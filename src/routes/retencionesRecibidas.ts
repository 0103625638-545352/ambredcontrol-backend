// Retención RECIBIDA: el reverso de Retencion (backend/src/routes/retenciones.ts).
// Acá no somos quienes emitimos el comprobante — un CLIENTE (agente de
// retención) ya generó y envió su propio comprobante de retención al SRI al
// pagarnos una factura, y esta ruta solo registra internamente lo que
// recibimos. Por eso NO hay clave de acceso, XML, firma ni envío — mucho más
// simple que retenciones.ts.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { Prisma } from "@prisma/client";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerRangoFechas } from "../utils/rangoFechas";
import { registrarAuditoria } from "../utils/auditoria";
import { calcularEstadoPago } from "../utils/estadoPago";
import { calcularValorRetenido, calcularTotalesRetencion } from "../utils/retenciones";
import { crearPagoConAsiento } from "../utils/pagos";

export const retencionesRecibidasRouter = Router();

const INCLUDE_RETENCION_RECIBIDA = {
  factura: { include: { cliente: true } },
  detalles: true,
} as const;

// GET /retenciones-recibidas
// Sin "?page=" devuelve un array plano (mismo criterio que /retenciones),
// necesario para que el Reporteador Principal funcione con este endpoint.
retencionesRecibidasRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.RetencionRecibidaWhereInput = rango ? { fechaEmision: rango } : {};
    const opciones = { where, include: INCLUDE_RETENCION_RECIBIDA, orderBy: { fechaEmision: "desc" as const } };

    if (!paginacion.aplica) {
      const retenciones = await prisma.retencionRecibida.findMany(opciones);
      return res.json(retenciones);
    }

    const [retenciones, total] = await Promise.all([
      prisma.retencionRecibida.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.retencionRecibida.count({ where }),
    ]);
    res.json(respuestaPaginada(retenciones, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar retenciones recibidas" });
  }
});

// GET /retenciones-recibidas/:id
retencionesRecibidasRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const retencion = await prisma.retencionRecibida.findUnique({ where: { id }, include: INCLUDE_RETENCION_RECIBIDA });
    if (!retencion) return res.status(404).json({ error: "Retención recibida no encontrada" });
    res.json(retencion);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar la retención recibida" });
  }
});

interface LineaRetencionBody {
  tipoImpuesto: "IVA" | "RENTA";
  clasificacion: "BIEN" | "SERVICIO";
  codigoRetencion: string;
  baseImponible: number;
  porcentaje: number;
}

// POST /retenciones-recibidas
// Body: { facturaId, numeroComprobante, fechaEmision, lineas: [{ tipoImpuesto, clasificacion, codigoRetencion, baseImponible, porcentaje }] }
retencionesRecibidasRouter.post("/", async (req: Request, res: Response) => {
  const { facturaId, numeroComprobante, fechaEmision, lineas } = req.body as {
    facturaId: number;
    numeroComprobante: string;
    fechaEmision: string;
    lineas: LineaRetencionBody[];
  };

  if (!facturaId || !numeroComprobante || !fechaEmision || !Array.isArray(lineas) || lineas.length === 0) {
    return res.status(400).json({ error: "facturaId, numeroComprobante, fechaEmision y al menos una línea son obligatorios" });
  }

  try {
    const nuevaRetencion = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const factura = await tx.factura.findUnique({
        where: { id: facturaId },
        include: { cliente: true, retencionRecibida: true },
      });
      if (!factura) throw new Error("FACTURA_NO_ENCONTRADA");
      // Solo tiene sentido sobre una factura electrónica real ya enviada al
      // cliente — el cliente no puede haber retenido nada sobre un documento
      // que todavía no existe formalmente ante el SRI.
      if (factura.estado !== "AUTORIZADA") throw new Error("FACTURA_NO_AUTORIZADA");
      if (factura.retencionRecibida) throw new Error("RETENCION_YA_EXISTE");

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

      const saldoPendiente = factura.total.sub(factura.montoPagado);
      if (total.gt(saldoPendiente)) throw new Error("RETENCION_EXCEDE_SALDO");

      const retencionCreada = await tx.retencionRecibida.create({
        data: {
          numeroComprobante: numeroComprobante.trim(),
          fechaEmision: new Date(fechaEmision),
          facturaId,
          totalIva,
          totalRenta,
          total,
          detalles: { create: detallesData },
        },
        include: INCLUDE_RETENCION_RECIBIDA,
      });

      // Pago automático tipo RETENCION — reduce el saldo pendiente de la
      // factura, mismo criterio que retenciones.ts para Compra. Queda fuera
      // del arqueo de Caja sin tocar caja.ts (que filtra estrictamente
      // formaPago "EFECTIVO").
      await crearPagoConAsiento(tx, {
        facturaId,
        monto: total,
        formaPago: "RETENCION",
        referencia: numeroComprobante.trim(),
        descripcion: `Retención recibida ${numeroComprobante.trim()} sobre factura ${factura.secuencial}`,
        usuarioId: req.usuario!.usuarioId,
        totalIvaRetencion: totalIva,
        totalRentaRetencion: totalRenta,
      });
      const nuevoMontoPagado = factura.montoPagado.add(total);
      await tx.factura.update({
        where: { id: facturaId },
        data: { montoPagado: nuevoMontoPagado, estadoPago: calcularEstadoPago(nuevoMontoPagado, factura.total) },
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "REGISTRAR_RETENCION_RECIBIDA",
        entidad: "RetencionRecibida",
        entidadId: retencionCreada.id,
        detalle: `Comprobante ${numeroComprobante} sobre factura ${factura.secuencial} (${factura.cliente.razonSocial}): $${total.toFixed(2)}`,
      });

      return retencionCreada;
    });

    res.status(201).json(nuevaRetencion);
  } catch (error: any) {
    if (error.message === "FACTURA_NO_ENCONTRADA") return res.status(404).json({ error: "La factura no existe" });
    if (error.message === "FACTURA_NO_AUTORIZADA") {
      return res.status(409).json({ error: "Solo se puede registrar una retención recibida sobre una factura ya AUTORIZADA por el SRI" });
    }
    if (error.message === "RETENCION_YA_EXISTE") return res.status(409).json({ error: "Esta factura ya tiene una retención recibida registrada" });
    if (error.message === "TIPO_IMPUESTO_INVALIDO") return res.status(400).json({ error: "Cada línea debe ser de tipo IVA o RENTA" });
    if (error.message === "CLASIFICACION_INVALIDA") return res.status(400).json({ error: "Cada línea debe clasificarse como Bien o Servicio" });
    if (error.message === "CODIGO_RETENCION_OBLIGATORIO") return res.status(400).json({ error: "El código de retención es obligatorio en cada línea" });
    if (error.message === "BASE_IMPONIBLE_INVALIDA") return res.status(400).json({ error: "La base imponible debe ser mayor a 0 en cada línea" });
    if (error.message === "PORCENTAJE_INVALIDO") return res.status(400).json({ error: "El porcentaje debe estar entre 0 y 100" });
    if (error.message === "RETENCION_EXCEDE_SALDO") return res.status(400).json({ error: "El total retenido supera el saldo pendiente de la factura" });
    console.error(error);
    res.status(500).json({ error: "Error al registrar la retención recibida" });
  }
});
