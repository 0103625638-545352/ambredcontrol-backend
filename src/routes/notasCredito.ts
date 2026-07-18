import { Router, Request, Response } from "express";
import { prisma, empresaActiva } from "../db";
import { Prisma } from "@prisma/client";
import { datosEmisorDeEmpresa, rutaAbsoluta } from "../utils/empresas";
import { obtenerUrlsSri } from "../utils/sriEndpoints";
import { generarClaveAcceso } from "../utils/claveAcceso";
import { generarXmlNotaCredito } from "../utils/notaCreditoXml";
import { cargarCertificadoP12 } from "../utils/certificado";
import { firmarXadesBes } from "../utils/firmarXadesBes";
import { enviarComprobanteRecepcion } from "../utils/sriRecepcion";
import { consultarAutorizacion } from "../utils/sriAutorizacion";
import { generarRideNotaCreditoPdf } from "../utils/generarRideNotaCredito";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { enviarComprobantePorCorreo } from "../utils/email";
import { guardarComprobanteAutorizado } from "../utils/comprobantesAutorizados";
import { registrarAuditoria } from "../utils/auditoria";
import { leerRangoFechas } from "../utils/rangoFechas";
import { lineasPorNotaCredito } from "../utils/contabilidad";
import { crearAsiento } from "../utils/asientos";

export const notasCreditoRouter = Router();

// Consulta el estado de Autorización de una nota de crédito ya enviada, y
// actualiza su estado según la respuesta. Igual que su equivalente en
// facturas.ts: la usan la ruta manual, el paso 3 de "enviar-sri", y el job
// en segundo plano que reintenta automáticamente lo que quedó "EN_PROCESO".
export async function verificarYActualizarAutorizacionNotaCredito(notaCreditoId: number) {
  const nc = await prisma.notaCredito.findUnique({
    where: { id: notaCreditoId },
    include: { factura: { include: { cliente: true } }, detalles: { include: { producto: true } } },
  });
  if (!nc || !nc.claveAcceso) return null;

  const urlAutorizacion = obtenerUrlsSri(empresaActiva().ambienteSri).autorizacion;

  const autorizacion = await consultarAutorizacion(nc.claveAcceso, urlAutorizacion);

  if (autorizacion.estado === "AUTORIZADO") {
    await prisma.notaCredito.update({ where: { id: notaCreditoId }, data: { estado: "AUTORIZADA" } });
    if (autorizacion.comprobante) {
      guardarComprobanteAutorizado(nc.claveAcceso, autorizacion.comprobante);
      await enviarNotaCreditoAutorizadaPorCorreo(nc, autorizacion.comprobante);
    }
  } else if (autorizacion.estado === "NO AUTORIZADO") {
    await prisma.notaCredito.update({ where: { id: notaCreditoId }, data: { estado: "RECHAZADA" } });
  }

  return autorizacion;
}

// Igual que su equivalente en facturas.ts: manda el RIDE (PDF) + XML
// autorizado al cliente de la factura original, si tiene correo registrado.
// "Mejor esfuerzo" — un fallo de correo no debe afectar la autorización ya
// concedida por el SRI.
async function enviarNotaCreditoAutorizadaPorCorreo(nc: any, xmlAutorizado: string) {
  const cliente = nc.factura.cliente;
  if (!cliente.email) return;

  const empresa = empresaActiva();

  try {
    const pdfBytes = await generarRideNotaCreditoPdf(
      {
        secuencial: nc.secuencial,
        claveAcceso: nc.claveAcceso,
        fechaEmision: nc.fechaEmision,
        motivo: nc.motivo,
        subtotal0: nc.subtotal0,
        subtotal12: nc.subtotal12,
        iva: nc.iva,
        total: nc.total,
        estado: "AUTORIZADA",
        cliente,
        detalles: nc.detalles,
        facturaModificada: { secuencial: nc.factura.secuencial },
      },
      datosEmisorDeEmpresa(empresa)
    );

    const enviado = await enviarComprobantePorCorreo({
      destinatario: cliente.email,
      asunto: `Nota de crédito ${nc.secuencial} - ${empresa.razonSocial}`,
      textoPlano:
        `Hola ${cliente.razonSocial},\n\n` +
        `Adjuntamos tu nota de crédito ${nc.secuencial} (corrige la factura ${nc.factura.secuencial}), ` +
        `autorizada por el SRI, en PDF (RIDE) y en XML.`,
      pdfBuffer: Buffer.from(pdfBytes),
      pdfNombreArchivo: `nota-credito-${nc.secuencial}.pdf`,
      xmlContenido: xmlAutorizado,
      xmlNombreArchivo: `nota-credito-${nc.secuencial}.xml`,
    });

    if (enviado) {
      console.log(`[correo] Nota de crédito ${nc.secuencial} enviada a ${cliente.email}`);
    }
  } catch (error: any) {
    console.error(`[correo] Error enviando nota de crédito ${nc.secuencial} a ${cliente.email}:`, error.message);
  }
}

function construirXmlDeNotaCredito(nc: any): string {
  return generarXmlNotaCredito(
    {
      claveAcceso: nc.claveAcceso,
      secuencial: nc.secuencial,
      fechaEmision: nc.fechaEmision,
      motivo: nc.motivo,
      subtotal0: nc.subtotal0,
      subtotal12: nc.subtotal12,
      iva: nc.iva,
      total: nc.total,
      cliente: nc.factura.cliente,
      detalles: nc.detalles,
      facturaModificada: { secuencial: nc.factura.secuencial, fechaEmision: nc.factura.fechaEmision },
    },
    datosEmisorDeEmpresa(empresaActiva())
  );
}

// GET /notas-credito
// La lista no trae "detalles" (las líneas) — la tabla de NotasCreditoPage
// solo necesita el resumen; el detalle completo se pide aparte con GET /:id.
notasCreditoRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.NotaCreditoWhereInput = rango ? { fechaEmision: rango } : {};
    const opciones = {
      where,
      include: { factura: { include: { cliente: true } } },
      orderBy: { fechaEmision: "desc" as const },
    };

    if (!paginacion.aplica) {
      const notas = await prisma.notaCredito.findMany(opciones);
      return res.json(notas);
    }

    const [notas, total] = await Promise.all([
      prisma.notaCredito.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.notaCredito.count({ where }),
    ]);
    res.json(respuestaPaginada(notas, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar notas de crédito" });
  }
});

// GET /notas-credito/:id
// Detalle completo con líneas — no existía un endpoint genérico para esto
// (solo /:id/xml, /:id/ride, etc., que arman su propia consulta interna);
// lo necesita el Reporteador Principal para mostrar el documento al hacer
// clic en una fila, mismo patrón que ya usan facturas.ts/notasVenta.ts.
notasCreditoRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const notaCredito = await prisma.notaCredito.findUnique({
      where: { id },
      include: { factura: { include: { cliente: true } }, detalles: { include: { producto: true } } },
    });
    if (!notaCredito) return res.status(404).json({ error: "Nota de crédito no encontrada" });
    res.json(notaCredito);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar la nota de crédito" });
  }
});

// POST /notas-credito
// Body: { facturaId: number, motivo: string, items: [{ productoId, cantidad }] }
//
// "items" define QUÉ se devuelve y CUÁNTO — puede ser toda la factura (devolución
// total) o solo algunos productos/cantidades (devolución parcial). Los precios
// SIEMPRE se toman de la factura original, nunca del precio actual del producto
// (si devuelves algo vendido el mes pasado a $10, la nota de crédito es por $10,
// aunque hoy el producto cueste $12).
notasCreditoRouter.post("/", async (req: Request, res: Response) => {
  const { facturaId, motivo, items } = req.body as {
    facturaId: number;
    motivo: string;
    items: { productoId: number; cantidad: number }[];
  };

  if (!facturaId || !motivo || !items || items.length === 0) {
    return res.status(400).json({ error: "facturaId, motivo e items son obligatorios" });
  }

  try {
    const nuevaNota = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const factura = await tx.factura.findUnique({
        where: { id: facturaId },
        include: { detalles: true, cliente: true },
      });

      if (!factura) throw new Error("FACTURA_NO_ENCONTRADA");

      // Regla de negocio clave: SOLO se puede emitir una nota de crédito sobre
      // una factura que el SRI ya autorizó. Si todavía no se envió, lo correcto
      // es anular la factura directamente (ya construimos esa ruta antes).
      if (factura.estado !== "AUTORIZADA") {
        throw new Error("FACTURA_NO_AUTORIZADA");
      }

      let subtotal0 = new Prisma.Decimal(0);
      let subtotal12 = new Prisma.Decimal(0);
      let ivaTotal = new Prisma.Decimal(0);
      const detallesData = [];

      for (const item of items) {
        if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
          throw new Error(`CANTIDAD_INVALIDA:${item.productoId}`);
        }

        // Buscamos la línea correspondiente en la factura ORIGINAL, para copiar
        // su precio exacto — no aceptamos un precio nuevo desde el frontend.
        const detalleOriginal = factura.detalles.find((d: (typeof factura.detalles)[number]) => d.productoId === item.productoId);
        if (!detalleOriginal) throw new Error(`PRODUCTO_NO_EN_FACTURA:${item.productoId}`);
        if (item.cantidad > detalleOriginal.cantidad) {
          throw new Error(`CANTIDAD_EXCEDE:${item.productoId}`);
        }

        const producto = await tx.producto.findUnique({ where: { id: item.productoId } });
        if (!producto) throw new Error(`PRODUCTO_NO_ENCONTRADO:${item.productoId}`);

        // Proporción del precio unitario original (ya con descuento aplicado prorrateado)
        const precioUnitarioOriginal = detalleOriginal.subtotal.div(detalleOriginal.cantidad);
        const subtotalLinea = precioUnitarioOriginal.mul(item.cantidad);
        const ivaLinea = detalleOriginal.cantidad > 0
          ? detalleOriginal.ivaValor.div(detalleOriginal.cantidad).mul(item.cantidad)
          : new Prisma.Decimal(0);

        if (producto.ivaPorcentaje.gt(0)) {
          subtotal12 = subtotal12.add(subtotalLinea);
        } else {
          subtotal0 = subtotal0.add(subtotalLinea);
        }
        ivaTotal = ivaTotal.add(ivaLinea);

        detallesData.push({
          productoId: item.productoId,
          cantidad: item.cantidad,
          precioUnitario: precioUnitarioOriginal,
          subtotal: subtotalLinea,
          ivaValor: ivaLinea,
        });

        // Devolvemos el stock: una nota de crédito por devolución de mercadería
        // significa que el producto vuelve a tu inventario. Para productos sin
        // lote, vuelve a la sucursal donde se hizo la venta ORIGINAL (la
        // nota de crédito no tiene su propia sucursal, siempre se deriva de
        // la factura que corrige).
        await tx.producto.update({
          where: { id: item.productoId },
          data: { stockActual: { increment: item.cantidad } },
        });
        if (!producto.manejaLotes) {
          await tx.stockSucursal.update({
            where: { productoId_sucursalId: { productoId: item.productoId, sucursalId: factura.sucursalId } },
            data: { cantidad: { increment: item.cantidad } },
          });
          await tx.stockBodega.update({
            where: { productoId_bodegaId: { productoId: item.productoId, bodegaId: factura.bodegaId } },
            data: { cantidad: { increment: item.cantidad } },
          });
        }
        await tx.movimientoInventario.create({
          data: {
            productoId: item.productoId,
            tipo: "ENTRADA",
            cantidad: item.cantidad,
            motivo: `Nota de crédito - devolución de factura ${factura.secuencial}`,
            sucursalId: producto.manejaLotes ? null : factura.sucursalId,
            bodegaId: producto.manejaLotes ? null : factura.bodegaId,
          },
        });
      }

      const total = subtotal0.add(subtotal12).add(ivaTotal);

      // Secuencial propio para notas de crédito (tipoComprobante "04")
      const secuencial = await tx.secuencial.upsert({
        where: {
          puntoVenta_establecimiento_tipoComprobante: {
            puntoVenta: "001",
            establecimiento: "001",
            tipoComprobante: "04",
          },
        },
        create: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "04", ultimoNumero: 1 },
        update: { ultimoNumero: { increment: 1 } },
      });

      const numeroFormateado = String(secuencial.ultimoNumero).padStart(9, "0");
      const secuencialTexto = `001-001-${numeroFormateado}`;

      const empresa = empresaActiva();
      const claveAcceso = generarClaveAcceso({
        fechaEmision: new Date(),
        tipoComprobante: "04",
        ruc: empresa.ruc,
        ambiente: empresa.ambienteSri,
        establecimiento: empresa.establecimiento,
        puntoEmision: empresa.puntoEmision,
        secuencial: secuencial.ultimoNumero,
      });

      const notaCreditoCreada = await tx.notaCredito.create({
        data: {
          secuencial: secuencialTexto,
          claveAcceso,
          motivo,
          facturaId,
          subtotal0,
          subtotal12,
          iva: ivaTotal,
          total,
          detalles: { create: detallesData },
        },
        include: { detalles: { include: { producto: true } }, factura: { include: { cliente: true } } },
      });

      await crearAsiento(tx, {
        origen: "NOTA_CREDITO",
        origenId: notaCreditoCreada.id,
        descripcion: `Nota de crédito ${secuencialTexto} contra factura ${factura.secuencial}`,
        lineas: lineasPorNotaCredito({ subtotal0, subtotal12, iva: ivaTotal }),
        usuarioId: req.usuario!.usuarioId,
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "CREAR_NOTA_CREDITO",
        entidad: "NotaCredito",
        entidadId: notaCreditoCreada.id,
        detalle: `Nota de crédito ${secuencialTexto} contra factura ${factura.secuencial}: ${motivo}`,
      });

      return notaCreditoCreada;
    });

    res.status(201).json(nuevaNota);

    // Envío automático al SRI, EN SEGUNDO PLANO — mismo criterio que
    // POST /facturas: la nota ya se confirmó arriba, esto no debe hacer
    // esperar a quien la creó. Si falla, se queda en CREADA y el job en
    // segundo plano la reintenta sola un par de minutos después.
    enviarNotaCreditoAlSri(nuevaNota.id).catch((error: any) => {
      console.error(`[auto-envio-sri] Nota de crédito ${nuevaNota.secuencial} quedó CREADA sin poder enviarse: ${error.message}`);
    });
  } catch (error: any) {
    if (error.message === "FACTURA_NO_ENCONTRADA") {
      return res.status(404).json({ error: "La factura no existe" });
    }
    if (error.message === "FACTURA_NO_AUTORIZADA") {
      return res.status(409).json({
        error: "Solo se puede emitir una nota de crédito sobre una factura ya AUTORIZADA por el SRI.",
      });
    }
    if (typeof error.message === "string" && error.message.startsWith("CANTIDAD_INVALIDA")) {
      return res.status(400).json({ error: "La cantidad a devolver de cada producto debe ser un entero mayor a 0" });
    }
    if (typeof error.message === "string" && error.message.startsWith("PRODUCTO_NO_EN_FACTURA")) {
      return res.status(400).json({ error: "Uno de los productos no pertenece a esa factura" });
    }
    if (typeof error.message === "string" && error.message.startsWith("CANTIDAD_EXCEDE")) {
      return res.status(400).json({ error: "No puedes devolver más cantidad de la que se vendió" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear la nota de crédito" });
  }
});

// GET /notas-credito/:id/xml
notasCreditoRouter.get("/:id/xml", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const nc = await prisma.notaCredito.findUnique({
      where: { id },
      include: { factura: { include: { cliente: true } }, detalles: { include: { producto: true } } },
    });
    if (!nc) return res.status(404).json({ error: "Nota de crédito no encontrada" });
    if (!nc.claveAcceso) return res.status(400).json({ error: "Sin clave de acceso" });

    const xml = construirXmlDeNotaCredito(nc);
    res.set("Content-Type", "application/xml");
    res.send(xml);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el XML" });
  }
});

// Firma+envía+consulta una nota de crédito. Reusada por la ruta manual y por
// el disparo automático al final de POST / (ver ahí) y por el job en segundo
// plano que reintenta las que quedaron CREADA sin enviarse. Mismo patrón que
// enviarFacturaAlSri en routes/facturas.ts.
export async function enviarNotaCreditoAlSri(notaCreditoId: number) {
  const nc = await prisma.notaCredito.findUnique({
    where: { id: notaCreditoId },
    include: { factura: { include: { cliente: true } }, detalles: { include: { producto: true } } },
  });
  if (!nc) throw new Error("NOTA_CREDITO_NO_ENCONTRADA");
  if (!nc.claveAcceso) throw new Error("SIN_CLAVE_ACCESO");

  const empresa = empresaActiva();
  if (!empresa.certificadoP12Password) throw new Error("SIN_CERTIFICADO");

  const urlRecepcion = obtenerUrlsSri(empresa.ambienteSri).recepcion;

  const xmlSinFirmar = construirXmlDeNotaCredito(nc);
  const credenciales = cargarCertificadoP12(rutaAbsoluta(empresa.certificadoP12Path), empresa.certificadoP12Password);
  const xmlFirmado = firmarXadesBes(xmlSinFirmar, credenciales);

  const recepcion = await enviarComprobanteRecepcion(xmlFirmado, urlRecepcion);

  if (recepcion.estado !== "RECIBIDA") {
    await prisma.notaCredito.update({ where: { id: notaCreditoId }, data: { estado: "RECHAZADA" } });
    return { paso: "recepcion" as const, recepcion };
  }

  await prisma.notaCredito.update({ where: { id: notaCreditoId }, data: { estado: "ENVIADA" } });

  // El SRI necesita un momento para procesar internamente antes de tener una
  // respuesta. Si aquí queda "EN_PROCESO", no hace falta volver manualmente:
  // el job en segundo plano (jobs/reintentoAutorizacionSri.ts) la reintenta solo.
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const autorizacion = await verificarYActualizarAutorizacionNotaCredito(notaCreditoId);

  return { paso: "autorizacion" as const, recepcion, autorizacion };
}

// POST /notas-credito/:id/enviar-sri
// Respaldo manual: normalmente ya no hace falta, toda nota de crédito nueva
// se envía sola al crearse (ver el fire-and-forget al final de POST /).
notasCreditoRouter.post("/:id/enviar-sri", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const resultado = await enviarNotaCreditoAlSri(id);

    if (resultado.paso === "recepcion") {
      return res.status(422).json({ paso: "recepcion", resultado: resultado.recepcion });
    }
    res.json(resultado);
  } catch (error: any) {
    if (error.message === "NOTA_CREDITO_NO_ENCONTRADA") return res.status(404).json({ error: "Nota de crédito no encontrada" });
    if (error.message === "SIN_CLAVE_ACCESO") return res.status(400).json({ error: "Sin clave de acceso" });
    if (error.message === "SIN_CERTIFICADO") {
      return res.status(400).json({ error: "Esta empresa todavía no tiene un certificado .p12 configurado (ver Ajustes)" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al enviar al SRI: " + error.message });
  }
});

// GET /notas-credito/:id/consultar-autorizacion
// Vuelve a preguntar el estado, sin reenviar (útil si quedó "EN_PROCESO").
// Es un atajo manual — el job en segundo plano ya hace esta misma consulta
// automáticamente cada cierto tiempo para todo lo pendiente.
// (No hace falta un requirePermiso aquí: todo /notas-credito ya exige el
// permiso "notas_credito" a nivel de router, en index.ts.)
notasCreditoRouter.get("/:id/consultar-autorizacion", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const autorizacion = await verificarYActualizarAutorizacionNotaCredito(id);
    if (!autorizacion) {
      return res.status(404).json({ error: "Nota de crédito no encontrada o sin clave de acceso" });
    }
    res.json(autorizacion);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al consultar autorización: " + error.message });
  }
});

// GET /notas-credito/:id/ride
notasCreditoRouter.get("/:id/ride", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const nc = await prisma.notaCredito.findUnique({
      where: { id },
      include: { factura: { include: { cliente: true } }, detalles: { include: { producto: true } } },
    });
    if (!nc) return res.status(404).json({ error: "Nota de crédito no encontrada" });
    if (!nc.claveAcceso) return res.status(400).json({ error: "Sin clave de acceso" });

    const pdfBytes = await generarRideNotaCreditoPdf(
      {
        secuencial: nc.secuencial,
        claveAcceso: nc.claveAcceso,
        fechaEmision: nc.fechaEmision,
        motivo: nc.motivo,
        subtotal0: nc.subtotal0,
        subtotal12: nc.subtotal12,
        iva: nc.iva,
        total: nc.total,
        estado: nc.estado,
        cliente: nc.factura.cliente,
        detalles: nc.detalles,
        facturaModificada: { secuencial: nc.factura.secuencial },
      },
      datosEmisorDeEmpresa(empresaActiva())
    );

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="nota-credito-${nc.secuencial}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el RIDE: " + error.message });
  }
});
