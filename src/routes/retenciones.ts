// Comprobante de Retención (IVA y/o Renta retenidos a un proveedor) — un
// documento electrónico SRI tan formal como Factura/NotaCredito: clave de
// acceso propia (tipoComprobante "07"), XML firmado XAdES-BES, envío a
// Recepción y consulta de Autorización. Nace siempre de una Compra ya
// registrada (relación 1 a 1, ver schema.prisma) — no tiene pantalla propia
// de navegación libre, sus acciones viven inline en ComprasPage.tsx.
//
// El % y el código de retención de cada línea SIEMPRE se ingresan a mano
// (ver utils/retenciones.ts): el SRI actualiza esas tablas periódicamente,
// mantener un catálogo interno acá sería un riesgo de compliance.
import { Router, Request, Response } from "express";
import { prisma, empresaActiva } from "../db";
import { Prisma } from "@prisma/client";
import { datosEmisorDeEmpresa, rutaAbsoluta } from "../utils/empresas";
import { obtenerUrlsSri } from "../utils/sriEndpoints";
import { generarClaveAcceso } from "../utils/claveAcceso";
import { generarXmlRetencion } from "../utils/retencionXml";
import { cargarCertificadoP12 } from "../utils/certificado";
import { firmarXadesBes } from "../utils/firmarXadesBes";
import { enviarComprobanteRecepcion } from "../utils/sriRecepcion";
import { consultarAutorizacion } from "../utils/sriAutorizacion";
import { generarRideRetencionPdf } from "../utils/generarRideRetencion";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { guardarComprobanteAutorizado } from "../utils/comprobantesAutorizados";
import { registrarAuditoria } from "../utils/auditoria";
import { leerRangoFechas } from "../utils/rangoFechas";
import { calcularEstadoPago } from "../utils/estadoPago";
import { calcularValorRetenido, calcularTotalesRetencion } from "../utils/retenciones";
import { crearPagoConAsiento } from "../utils/pagos";
import { totalDevueltoDeCompra } from "../utils/devolucionesCompra";

export const retencionesRouter = Router();

const INCLUDE_RETENCION = {
  compra: { include: { proveedor: true } },
  detalles: true,
} as const;

function construirXmlDeRetencion(r: any): string {
  return generarXmlRetencion(
    {
      claveAcceso: r.claveAcceso,
      secuencial: r.secuencial,
      fechaEmision: r.fechaEmision,
      periodoFiscal: r.periodoFiscal,
      total: r.total,
      proveedor: r.compra.proveedor,
      compra: { numeroFactura: r.compra.numeroFactura, fechaEmision: r.compra.fechaEmision },
      detalles: r.detalles,
    },
    datosEmisorDeEmpresa(empresaActiva())
  );
}

// Consulta el estado de Autorización de una retención ya enviada, y
// actualiza su estado según la respuesta. La usan la ruta manual y el job
// en segundo plano que reintenta automáticamente lo que quedó "EN_PROCESO".
export async function verificarYActualizarAutorizacionRetencion(retencionId: number) {
  const retencion = await prisma.retencion.findUnique({ where: { id: retencionId }, include: INCLUDE_RETENCION });
  if (!retencion || !retencion.claveAcceso) return null;

  const urlAutorizacion = obtenerUrlsSri(empresaActiva().ambienteSri).autorizacion;
  const autorizacion = await consultarAutorizacion(retencion.claveAcceso, urlAutorizacion);

  if (autorizacion.estado === "AUTORIZADO") {
    await prisma.retencion.update({ where: { id: retencionId }, data: { estado: "AUTORIZADA" } });
    if (autorizacion.comprobante) {
      guardarComprobanteAutorizado(retencion.claveAcceso, autorizacion.comprobante);
    }
  } else if (autorizacion.estado === "NO AUTORIZADO") {
    await prisma.retencion.update({ where: { id: retencionId }, data: { estado: "RECHAZADA" } });
  }

  return autorizacion;
}

// GET /retenciones
// Sin "?page=" devuelve un array plano (mismo criterio que /caja/historial),
// necesario para que el Reporteador Principal funcione con este endpoint.
retencionesRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.RetencionWhereInput = rango ? { fechaEmision: rango } : {};
    const opciones = { where, include: INCLUDE_RETENCION, orderBy: { fechaEmision: "desc" as const } };

    if (!paginacion.aplica) {
      const retenciones = await prisma.retencion.findMany(opciones);
      return res.json(retenciones);
    }

    const [retenciones, total] = await Promise.all([
      prisma.retencion.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.retencion.count({ where }),
    ]);
    res.json(respuestaPaginada(retenciones, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar retenciones" });
  }
});

// GET /retenciones/:id
retencionesRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const retencion = await prisma.retencion.findUnique({ where: { id }, include: INCLUDE_RETENCION });
    if (!retencion) return res.status(404).json({ error: "Retención no encontrada" });
    res.json(retencion);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar la retención" });
  }
});

interface LineaRetencionBody {
  tipoImpuesto: "IVA" | "RENTA";
  clasificacion: "BIEN" | "SERVICIO";
  codigoRetencion: string;
  baseImponible: number;
  porcentaje: number;
}

// POST /retenciones
// Body: { compraId, lineas: [{ tipoImpuesto, clasificacion, codigoRetencion, baseImponible, porcentaje }] }
retencionesRouter.post("/", async (req: Request, res: Response) => {
  const { compraId, lineas } = req.body as { compraId: number; lineas: LineaRetencionBody[] };

  if (!compraId || !Array.isArray(lineas) || lineas.length === 0) {
    return res.status(400).json({ error: "compraId y al menos una línea son obligatorios" });
  }

  try {
    const empresa = empresaActiva();
    if (!empresa.agenteRetencion) {
      return res.status(400).json({ error: "Esta empresa no está marcada como agente de retención (ver Ajustes)" });
    }

    const nuevaRetencion = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const compra = await tx.compra.findUnique({
        where: { id: compraId },
        include: { proveedor: true, retencion: true },
      });
      if (!compra) throw new Error("COMPRA_NO_ENCONTRADA");
      if (compra.estado === "ANULADA") throw new Error("COMPRA_ANULADA");
      if (compra.retencion) throw new Error("RETENCION_YA_EXISTE");

      const detallesData = [];
      for (const linea of lineas) {
        if (linea.tipoImpuesto !== "IVA" && linea.tipoImpuesto !== "RENTA") {
          throw new Error("TIPO_IMPUESTO_INVALIDO");
        }
        if (linea.clasificacion !== "BIEN" && linea.clasificacion !== "SERVICIO") {
          throw new Error("CLASIFICACION_INVALIDA");
        }
        if (!linea.codigoRetencion || typeof linea.codigoRetencion !== "string" || !linea.codigoRetencion.trim()) {
          throw new Error("CODIGO_RETENCION_OBLIGATORIO");
        }
        const base = new Prisma.Decimal(linea.baseImponible ?? 0);
        const porcentaje = new Prisma.Decimal(linea.porcentaje ?? 0);
        if (base.lte(0)) throw new Error("BASE_IMPONIBLE_INVALIDA");
        if (porcentaje.lt(0) || porcentaje.gt(100)) throw new Error("PORCENTAJE_INVALIDO");

        detallesData.push({
          tipoImpuesto: linea.tipoImpuesto,
          clasificacion: linea.clasificacion,
          codigoRetencion: linea.codigoRetencion.trim(),
          baseImponible: base,
          porcentaje,
          valorRetenido: calcularValorRetenido(base, porcentaje),
        });
      }

      const { totalIva, totalRenta, total } = calcularTotalesRetencion(detallesData);

      // Resta lo ya devuelto por DevolucionCompra — igual criterio que
      // /compras/:id/pagos, ver utils/devolucionesCompra.ts.
      const saldoPendiente = compra.total.sub(compra.montoPagado).sub(await totalDevueltoDeCompra(tx, compraId));
      if (total.gt(saldoPendiente)) throw new Error("RETENCION_EXCEDE_SALDO");

      // Secuencial propio para retenciones (tipoComprobante "07")
      const secuencial = await tx.secuencial.upsert({
        where: { puntoVenta_establecimiento_tipoComprobante: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "07" } },
        create: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "07", ultimoNumero: 1 },
        update: { ultimoNumero: { increment: 1 } },
      });
      const secuencialTexto = `001-001-${String(secuencial.ultimoNumero).padStart(9, "0")}`;

      const fechaEmision = new Date();
      const claveAcceso = generarClaveAcceso({
        fechaEmision,
        tipoComprobante: "07",
        ruc: empresa.ruc,
        ambiente: empresa.ambienteSri,
        establecimiento: empresa.establecimiento,
        puntoEmision: empresa.puntoEmision,
        secuencial: secuencial.ultimoNumero,
      });
      const periodoFiscal = `${String(fechaEmision.getMonth() + 1).padStart(2, "0")}/${fechaEmision.getFullYear()}`;

      const retencionCreada = await tx.retencion.create({
        data: {
          secuencial: secuencialTexto,
          claveAcceso,
          fechaEmision,
          periodoFiscal,
          compraId,
          totalIva,
          totalRenta,
          total,
          detalles: { create: detallesData },
        },
        include: INCLUDE_RETENCION,
      });

      // Pago automático tipo RETENCION — reduce lo que hay que pagarle al
      // proveedor. Queda fuera del arqueo de Caja sin tocar caja.ts
      // (obtenerComponentesEfectivoCaja filtra estrictamente formaPago
      // "EFECTIVO").
      await crearPagoConAsiento(tx, {
        compraId,
        monto: total,
        formaPago: "RETENCION",
        referencia: secuencialTexto,
        descripcion: `Retención ${secuencialTexto} sobre compra Fact. ${compra.numeroFactura}`,
        usuarioId: req.usuario!.usuarioId,
        totalIvaRetencion: totalIva,
        totalRentaRetencion: totalRenta,
      });
      const nuevoMontoPagado = compra.montoPagado.add(total);
      await tx.compra.update({
        where: { id: compraId },
        data: { montoPagado: nuevoMontoPagado, estadoPago: calcularEstadoPago(nuevoMontoPagado, compra.total) },
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "CREAR_RETENCION",
        entidad: "Retencion",
        entidadId: retencionCreada.id,
        detalle: `Retención ${secuencialTexto} sobre compra Fact. ${compra.numeroFactura} (${compra.proveedor.razonSocial}): $${total.toFixed(2)}`,
      });

      return retencionCreada;
    });

    res.status(201).json(nuevaRetencion);

    // Envío automático al SRI, EN SEGUNDO PLANO — mismo criterio que
    // POST /facturas: la retención ya se confirmó arriba (y su pago ya se
    // registró), esto no debe hacer esperar a quien la generó. Si falla, se
    // queda en CREADA y el job en segundo plano la reintenta sola.
    enviarRetencionAlSri(nuevaRetencion.id).catch((error: any) => {
      console.error(`[auto-envio-sri] Retención ${nuevaRetencion.secuencial} quedó CREADA sin poder enviarse: ${error.message}`);
    });
  } catch (error: any) {
    if (error.message === "COMPRA_NO_ENCONTRADA") return res.status(404).json({ error: "La compra no existe" });
    if (error.message === "COMPRA_ANULADA") return res.status(409).json({ error: "No se puede generar una retención sobre una compra anulada" });
    if (error.message === "RETENCION_YA_EXISTE") return res.status(409).json({ error: "Esta compra ya tiene una retención generada" });
    if (error.message === "TIPO_IMPUESTO_INVALIDO") return res.status(400).json({ error: "Cada línea debe ser de tipo IVA o RENTA" });
    if (error.message === "CLASIFICACION_INVALIDA") return res.status(400).json({ error: "Cada línea debe clasificarse como Bien o Servicio" });
    if (error.message === "CODIGO_RETENCION_OBLIGATORIO") return res.status(400).json({ error: "El código de retención es obligatorio en cada línea" });
    if (error.message === "BASE_IMPONIBLE_INVALIDA") return res.status(400).json({ error: "La base imponible debe ser mayor a 0 en cada línea" });
    if (error.message === "PORCENTAJE_INVALIDO") return res.status(400).json({ error: "El porcentaje debe estar entre 0 y 100" });
    if (error.message === "RETENCION_EXCEDE_SALDO") return res.status(400).json({ error: "El total retenido supera el saldo pendiente de la compra" });
    console.error(error);
    res.status(500).json({ error: "Error al generar la retención" });
  }
});

// GET /retenciones/:id/xml
retencionesRouter.get("/:id/xml", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const retencion = await prisma.retencion.findUnique({ where: { id }, include: INCLUDE_RETENCION });
    if (!retencion) return res.status(404).json({ error: "Retención no encontrada" });
    if (!retencion.claveAcceso) return res.status(400).json({ error: "Sin clave de acceso" });

    const xml = construirXmlDeRetencion(retencion);
    res.set("Content-Type", "application/xml");
    res.send(xml);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el XML" });
  }
});

// Firma+envía+consulta una retención. Reusada por la ruta manual, por el
// disparo automático al final de POST / (ver ahí) y por el job en segundo
// plano que reintenta las que quedaron CREADA sin enviarse. Mismo patrón
// que enviarFacturaAlSri en routes/facturas.ts.
export async function enviarRetencionAlSri(retencionId: number) {
  const retencion = await prisma.retencion.findUnique({ where: { id: retencionId }, include: INCLUDE_RETENCION });
  if (!retencion) throw new Error("RETENCION_NO_ENCONTRADA");
  if (!retencion.claveAcceso) throw new Error("SIN_CLAVE_ACCESO");

  const empresa = empresaActiva();
  if (!empresa.certificadoP12Password) throw new Error("SIN_CERTIFICADO");

  const urlRecepcion = obtenerUrlsSri(empresa.ambienteSri).recepcion;

  const xmlSinFirmar = construirXmlDeRetencion(retencion);
  const credenciales = cargarCertificadoP12(rutaAbsoluta(empresa.certificadoP12Path), empresa.certificadoP12Password);
  const xmlFirmado = firmarXadesBes(xmlSinFirmar, credenciales);

  const recepcion = await enviarComprobanteRecepcion(xmlFirmado, urlRecepcion);

  if (recepcion.estado !== "RECIBIDA") {
    await prisma.retencion.update({ where: { id: retencionId }, data: { estado: "RECHAZADA" } });
    return { paso: "recepcion" as const, recepcion };
  }

  await prisma.retencion.update({ where: { id: retencionId }, data: { estado: "ENVIADA" } });

  // Mismo criterio que facturas/notas de crédito: si queda "EN_PROCESO", el
  // job en segundo plano (jobs/reintentoAutorizacionSri.ts) la reintenta solo.
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const autorizacion = await verificarYActualizarAutorizacionRetencion(retencionId);

  return { paso: "autorizacion" as const, recepcion, autorizacion };
}

// POST /retenciones/:id/enviar-sri
// Respaldo manual: normalmente ya no hace falta, toda retención nueva se
// envía sola al crearse (ver el fire-and-forget al final de POST /).
retencionesRouter.post("/:id/enviar-sri", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const resultado = await enviarRetencionAlSri(id);

    if (resultado.paso === "recepcion") {
      return res.status(422).json({ paso: "recepcion", resultado: resultado.recepcion });
    }
    res.json(resultado);
  } catch (error: any) {
    if (error.message === "RETENCION_NO_ENCONTRADA") return res.status(404).json({ error: "Retención no encontrada" });
    if (error.message === "SIN_CLAVE_ACCESO") return res.status(400).json({ error: "Sin clave de acceso" });
    if (error.message === "SIN_CERTIFICADO") {
      return res.status(400).json({ error: "Esta empresa todavía no tiene un certificado .p12 configurado (ver Ajustes)" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al enviar al SRI: " + error.message });
  }
});

// GET /retenciones/:id/consultar-autorizacion
retencionesRouter.get("/:id/consultar-autorizacion", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const autorizacion = await verificarYActualizarAutorizacionRetencion(id);
    if (!autorizacion) {
      return res.status(404).json({ error: "Retención no encontrada o sin clave de acceso" });
    }
    res.json(autorizacion);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al consultar autorización: " + error.message });
  }
});

// GET /retenciones/:id/ride
retencionesRouter.get("/:id/ride", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const retencion = await prisma.retencion.findUnique({ where: { id }, include: INCLUDE_RETENCION });
    if (!retencion) return res.status(404).json({ error: "Retención no encontrada" });
    if (!retencion.claveAcceso) return res.status(400).json({ error: "Sin clave de acceso" });

    const pdfBytes = await generarRideRetencionPdf(
      {
        secuencial: retencion.secuencial,
        claveAcceso: retencion.claveAcceso,
        fechaEmision: retencion.fechaEmision,
        periodoFiscal: retencion.periodoFiscal,
        estado: retencion.estado,
        totalIva: retencion.totalIva,
        totalRenta: retencion.totalRenta,
        total: retencion.total,
        proveedor: retencion.compra.proveedor,
        compra: { numeroFactura: retencion.compra.numeroFactura, fechaEmision: retencion.compra.fechaEmision },
        detalles: retencion.detalles,
      },
      datosEmisorDeEmpresa(empresaActiva())
    );

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="retencion-${retencion.secuencial}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el RIDE: " + error.message });
  }
});
