// Guía de Remisión (transporte de mercadería ya vendida) — un documento
// electrónico SRI tan formal como Factura/NotaCredito/Retención: clave de
// acceso propia (tipoComprobante "06"), XML firmado XAdES-BES, envío a
// Recepción y consulta de Autorización. A diferencia de esos, no mueve
// dinero ni stock: el stock ya se descontó al crear la Factura, esto es
// puramente el documento que acompaña el traslado físico. Nace siempre de
// una Factura ya AUTORIZADA (mismo gate que NotaCredito), pero no es 1 a 1
// — una misma factura puede repartirse en varios viajes/camiones, cada uno
// con su propia guía.
import { Router, Request, Response } from "express";
import { prisma, empresaActiva } from "../db";
import { leerBusqueda, leerEnum, contiene } from "../utils/busquedaListado";
import { Prisma, EstadoFactura } from "@prisma/client";
import { datosEmisorDeEmpresa, rutaAbsoluta } from "../utils/empresas";
import { obtenerUrlsSri } from "../utils/sriEndpoints";
import { generarClaveAcceso } from "../utils/claveAcceso";
import { generarXmlGuiaRemision } from "../utils/guiaRemisionXml";
import { cargarCertificadoP12 } from "../utils/certificado";
import { firmarXadesBes } from "../utils/firmarXadesBes";
import { enviarComprobanteRecepcion } from "../utils/sriRecepcion";
import { consultarAutorizacion } from "../utils/sriAutorizacion";
import { generarRideGuiaRemisionPdf } from "../utils/generarRideGuiaRemision";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { guardarComprobanteAutorizado } from "../utils/comprobantesAutorizados";
import { registrarAuditoria } from "../utils/auditoria";
import { leerRangoFechas, fechaLocalDeString } from "../utils/rangoFechas";

export const guiasRemisionRouter = Router();

const INCLUDE_GUIA_REMISION = {
  factura: { include: { cliente: true } },
  detalles: { include: { producto: true } },
} as const;

function construirXmlDeGuiaRemision(g: any): string {
  return generarXmlGuiaRemision(
    {
      claveAcceso: g.claveAcceso,
      secuencial: g.secuencial,
      fechaEmision: g.fechaEmision,
      destinatarioTipoIdentificacion: g.destinatarioTipoIdentificacion,
      destinatarioIdentificacion: g.destinatarioIdentificacion,
      destinatarioRazonSocial: g.destinatarioRazonSocial,
      destinatarioDireccion: g.destinatarioDireccion,
      motivoTraslado: g.motivoTraslado,
      ruta: g.ruta,
      dirPartida: g.dirPartida,
      transportistaTipoIdentificacion: g.transportistaTipoIdentificacion,
      transportistaIdentificacion: g.transportistaIdentificacion,
      transportistaRazonSocial: g.transportistaRazonSocial,
      placa: g.placa,
      fechaIniTransporte: g.fechaIniTransporte,
      fechaFinTransporte: g.fechaFinTransporte,
      detalles: g.detalles,
      factura: { secuencial: g.factura.secuencial, fechaEmision: g.factura.fechaEmision, claveAcceso: g.factura.claveAcceso },
    },
    datosEmisorDeEmpresa(empresaActiva())
  );
}

// Consulta el estado de Autorización de una guía ya enviada, y actualiza su
// estado según la respuesta. La usan la ruta manual y el job en segundo
// plano que reintenta automáticamente lo que quedó "EN_PROCESO".
export async function verificarYActualizarAutorizacionGuiaRemision(guiaId: number) {
  const guia = await prisma.guiaRemision.findUnique({ where: { id: guiaId }, include: INCLUDE_GUIA_REMISION });
  if (!guia || !guia.claveAcceso) return null;

  const urlAutorizacion = obtenerUrlsSri(empresaActiva().ambienteSri).autorizacion;
  const autorizacion = await consultarAutorizacion(guia.claveAcceso, urlAutorizacion);

  if (autorizacion.estado === "AUTORIZADO") {
    await prisma.guiaRemision.update({ where: { id: guiaId }, data: { estado: "AUTORIZADA" } });
    if (autorizacion.comprobante) {
      guardarComprobanteAutorizado(guia.claveAcceso, autorizacion.comprobante);
    }
  } else if (autorizacion.estado === "NO AUTORIZADO") {
    await prisma.guiaRemision.update({ where: { id: guiaId }, data: { estado: "RECHAZADA" } });
  }

  return autorizacion;
}

// GET /guias-remision
guiasRemisionRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.GuiaRemisionWhereInput = rango ? { fechaEmision: rango } : {};

    // Buscador: número, clave de acceso, factura, destinatario, transportista
    // (nombre o identificación) o placa; filtro por estado SRI.
    const q = leerBusqueda(req);
    if (q) {
      where.OR = [
        { secuencial: contiene(q) },
        { claveAcceso: { contains: q } },
        { factura: { secuencial: contiene(q) } },
        { destinatarioRazonSocial: contiene(q) },
        { destinatarioIdentificacion: { contains: q } },
        { transportistaRazonSocial: contiene(q) },
        { transportistaIdentificacion: { contains: q } },
        { placa: contiene(q) },
      ];
    }
    const estado = leerEnum(req, "estado", EstadoFactura);
    if (estado) where.estado = estado;

    const opciones = { where, include: INCLUDE_GUIA_REMISION, orderBy: { fechaEmision: "desc" as const } };

    if (!paginacion.aplica) {
      const guias = await prisma.guiaRemision.findMany(opciones);
      return res.json(guias);
    }

    const [guias, total] = await Promise.all([
      prisma.guiaRemision.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.guiaRemision.count({ where }),
    ]);
    res.json(respuestaPaginada(guias, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar guías de remisión" });
  }
});

// GET /guias-remision/:id
guiasRemisionRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const guia = await prisma.guiaRemision.findUnique({ where: { id }, include: INCLUDE_GUIA_REMISION });
    if (!guia) return res.status(404).json({ error: "Guía de remisión no encontrada" });
    res.json(guia);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar la guía de remisión" });
  }
});

interface ItemGuiaBody {
  productoId: number;
  cantidad: number;
}

interface CrearGuiaRemisionBody {
  facturaId: number;
  destinatario: { tipoIdentificacion: string; identificacion: string; razonSocial: string; direccion: string };
  motivoTraslado: string;
  ruta?: string;
  transportista: { tipoIdentificacion: string; identificacion: string; razonSocial: string };
  placa: string;
  dirPartida: string;
  fechaIniTransporte: string;
  fechaFinTransporte: string;
  items: ItemGuiaBody[];
}

// POST /guias-remision
guiasRemisionRouter.post("/", async (req: Request, res: Response) => {
  const body = req.body as CrearGuiaRemisionBody;
  const { facturaId, destinatario, motivoTraslado, ruta, transportista, placa, dirPartida, fechaIniTransporte, fechaFinTransporte, items } = body;

  if (!facturaId || !destinatario || !motivoTraslado || !transportista || !placa || !dirPartida || !fechaIniTransporte || !fechaFinTransporte || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Faltan datos obligatorios para generar la guía de remisión" });
  }

  try {
    const empresa = empresaActiva();

    const nuevaGuia = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const factura = await tx.factura.findUnique({ where: { id: facturaId }, include: { detalles: { include: { producto: true } } } });
      if (!factura) throw new Error("FACTURA_NO_ENCONTRADA");
      if (factura.estado !== "AUTORIZADA") throw new Error("FACTURA_NO_AUTORIZADA");

      const detallesData = [];
      for (const item of items) {
        if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
          throw new Error(`CANTIDAD_INVALIDA:${item.productoId}`);
        }
        const detalleOriginal = factura.detalles.find((d: (typeof factura.detalles)[number]) => d.productoId === item.productoId);
        if (!detalleOriginal) throw new Error(`PRODUCTO_NO_EN_FACTURA:${item.productoId}`);
        if (item.cantidad > detalleOriginal.cantidad) {
          throw new Error(`CANTIDAD_EXCEDE:${item.productoId}`);
        }

        detallesData.push({
          productoId: detalleOriginal.productoId,
          cantidad: item.cantidad,
          descripcion: detalleOriginal.producto.nombre,
        });
      }

      // Secuencial propio para guías de remisión (tipoComprobante "06", el
      // código oficial del SRI para este comprobante).
      const secuencial = await tx.secuencial.upsert({
        where: { puntoVenta_establecimiento_tipoComprobante: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "06" } },
        create: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "06", ultimoNumero: 1 },
        update: { ultimoNumero: { increment: 1 } },
      });
      const secuencialTexto = `001-001-${String(secuencial.ultimoNumero).padStart(9, "0")}`;

      const fechaEmision = new Date();
      const claveAcceso = generarClaveAcceso({
        fechaEmision,
        tipoComprobante: "06",
        ruc: empresa.ruc,
        ambiente: empresa.ambienteSri,
        establecimiento: empresa.establecimiento,
        puntoEmision: empresa.puntoEmision,
        secuencial: secuencial.ultimoNumero,
      });

      const guiaCreada = await tx.guiaRemision.create({
        data: {
          secuencial: secuencialTexto,
          claveAcceso,
          fechaEmision,
          facturaId,
          destinatarioTipoIdentificacion: destinatario.tipoIdentificacion,
          destinatarioIdentificacion: destinatario.identificacion,
          destinatarioRazonSocial: destinatario.razonSocial,
          destinatarioDireccion: destinatario.direccion,
          motivoTraslado,
          ruta: ruta || undefined,
          dirPartida,
          transportistaTipoIdentificacion: transportista.tipoIdentificacion,
          transportistaIdentificacion: transportista.identificacion,
          transportistaRazonSocial: transportista.razonSocial,
          placa,
          fechaIniTransporte: fechaLocalDeString(fechaIniTransporte, false),
          fechaFinTransporte: fechaLocalDeString(fechaFinTransporte, false),
          detalles: { create: detallesData },
        },
        include: INCLUDE_GUIA_REMISION,
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "CREAR_GUIA_REMISION",
        entidad: "GuiaRemision",
        entidadId: guiaCreada.id,
        detalle: `Guía ${secuencialTexto} sobre factura ${factura.secuencial}`,
      });

      return guiaCreada;
    });

    res.status(201).json(nuevaGuia);

    // Envío automático al SRI, EN SEGUNDO PLANO — mismo criterio que
    // POST /facturas: la guía ya se confirmó arriba, esto no debe hacer
    // esperar a quien la generó. Si falla, se queda en CREADA y el job en
    // segundo plano la reintenta sola.
    enviarGuiaRemisionAlSri(nuevaGuia.id).catch((error: any) => {
      console.error(`[auto-envio-sri] Guía de remisión ${nuevaGuia.secuencial} quedó CREADA sin poder enviarse: ${error.message}`);
    });
  } catch (error: any) {
    if (error.message === "FACTURA_NO_ENCONTRADA") return res.status(404).json({ error: "La factura no existe" });
    if (error.message === "FACTURA_NO_AUTORIZADA") {
      return res.status(409).json({ error: "Solo se puede generar una guía de remisión sobre una factura ya AUTORIZADA por el SRI." });
    }
    if (typeof error.message === "string" && error.message.startsWith("CANTIDAD_INVALIDA")) {
      return res.status(400).json({ error: "La cantidad de cada producto debe ser un entero mayor a 0" });
    }
    if (typeof error.message === "string" && error.message.startsWith("PRODUCTO_NO_EN_FACTURA")) {
      return res.status(400).json({ error: "Uno de los productos no pertenece a esa factura" });
    }
    if (typeof error.message === "string" && error.message.startsWith("CANTIDAD_EXCEDE")) {
      return res.status(400).json({ error: "No puedes transportar más cantidad de la que se vendió en esa línea" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al generar la guía de remisión" });
  }
});

// GET /guias-remision/:id/xml
guiasRemisionRouter.get("/:id/xml", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const guia = await prisma.guiaRemision.findUnique({ where: { id }, include: INCLUDE_GUIA_REMISION });
    if (!guia) return res.status(404).json({ error: "Guía de remisión no encontrada" });
    if (!guia.claveAcceso) return res.status(400).json({ error: "Sin clave de acceso" });

    const xml = construirXmlDeGuiaRemision(guia);
    res.set("Content-Type", "application/xml");
    res.send(xml);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el XML" });
  }
});

// Firma+envía+consulta una guía de remisión. Reusada por la ruta manual, por
// el disparo automático al final de POST / (ver ahí) y por el job en
// segundo plano que reintenta las que quedaron CREADA sin enviarse. Mismo
// patrón que enviarFacturaAlSri en routes/facturas.ts.
export async function enviarGuiaRemisionAlSri(guiaId: number) {
  const guia = await prisma.guiaRemision.findUnique({ where: { id: guiaId }, include: INCLUDE_GUIA_REMISION });
  if (!guia) throw new Error("GUIA_REMISION_NO_ENCONTRADA");
  if (!guia.claveAcceso) throw new Error("SIN_CLAVE_ACCESO");

  const empresa = empresaActiva();
  if (!empresa.certificadoP12Password) throw new Error("SIN_CERTIFICADO");

  const urlRecepcion = obtenerUrlsSri(empresa.ambienteSri).recepcion;

  const xmlSinFirmar = construirXmlDeGuiaRemision(guia);
  const credenciales = cargarCertificadoP12(rutaAbsoluta(empresa.certificadoP12Path), empresa.certificadoP12Password);
  const xmlFirmado = firmarXadesBes(xmlSinFirmar, credenciales);

  const recepcion = await enviarComprobanteRecepcion(xmlFirmado, urlRecepcion);

  if (recepcion.estado !== "RECIBIDA") {
    await prisma.guiaRemision.update({ where: { id: guiaId }, data: { estado: "RECHAZADA" } });
    return { paso: "recepcion" as const, recepcion };
  }

  await prisma.guiaRemision.update({ where: { id: guiaId }, data: { estado: "ENVIADA" } });

  // Mismo criterio que facturas/notas de crédito/retenciones: si queda
  // "EN_PROCESO", el job en segundo plano (jobs/reintentoAutorizacionSri.ts)
  // la reintenta solo.
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const autorizacion = await verificarYActualizarAutorizacionGuiaRemision(guiaId);

  return { paso: "autorizacion" as const, recepcion, autorizacion };
}

// POST /guias-remision/:id/enviar-sri
// Respaldo manual: normalmente ya no hace falta, toda guía nueva se envía
// sola al crearse (ver el fire-and-forget al final de POST /).
guiasRemisionRouter.post("/:id/enviar-sri", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const resultado = await enviarGuiaRemisionAlSri(id);

    if (resultado.paso === "recepcion") {
      return res.status(422).json({ paso: "recepcion", resultado: resultado.recepcion });
    }
    res.json(resultado);
  } catch (error: any) {
    if (error.message === "GUIA_REMISION_NO_ENCONTRADA") return res.status(404).json({ error: "Guía de remisión no encontrada" });
    if (error.message === "SIN_CLAVE_ACCESO") return res.status(400).json({ error: "Sin clave de acceso" });
    if (error.message === "SIN_CERTIFICADO") {
      return res.status(400).json({ error: "Esta empresa todavía no tiene un certificado .p12 configurado (ver Ajustes)" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al enviar al SRI: " + error.message });
  }
});

// GET /guias-remision/:id/consultar-autorizacion
guiasRemisionRouter.get("/:id/consultar-autorizacion", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const autorizacion = await verificarYActualizarAutorizacionGuiaRemision(id);
    if (!autorizacion) {
      return res.status(404).json({ error: "Guía de remisión no encontrada o sin clave de acceso" });
    }
    res.json(autorizacion);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al consultar autorización: " + error.message });
  }
});

// GET /guias-remision/:id/ride
guiasRemisionRouter.get("/:id/ride", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const guia = await prisma.guiaRemision.findUnique({ where: { id }, include: INCLUDE_GUIA_REMISION });
    if (!guia) return res.status(404).json({ error: "Guía de remisión no encontrada" });
    if (!guia.claveAcceso) return res.status(400).json({ error: "Sin clave de acceso" });

    const pdfBytes = await generarRideGuiaRemisionPdf(
      {
        secuencial: guia.secuencial,
        claveAcceso: guia.claveAcceso,
        fechaEmision: guia.fechaEmision,
        estado: guia.estado,
        destinatarioIdentificacion: guia.destinatarioIdentificacion,
        destinatarioRazonSocial: guia.destinatarioRazonSocial,
        destinatarioDireccion: guia.destinatarioDireccion,
        motivoTraslado: guia.motivoTraslado,
        ruta: guia.ruta,
        dirPartida: guia.dirPartida,
        transportistaIdentificacion: guia.transportistaIdentificacion,
        transportistaRazonSocial: guia.transportistaRazonSocial,
        placa: guia.placa,
        fechaIniTransporte: guia.fechaIniTransporte,
        fechaFinTransporte: guia.fechaFinTransporte,
        factura: { secuencial: guia.factura.secuencial },
        detalles: guia.detalles,
      },
      datosEmisorDeEmpresa(empresaActiva())
    );

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="guia-remision-${guia.secuencial}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el RIDE: " + error.message });
  }
});
