// Catálogo de promociones temporales sobre la facturación de internet (ver
// PromocionPlan en schema.prisma) — mismo criterio de CRUD con borrado
// suave que routes/planesInternet.ts, y gateado por el mismo permiso
// "mikrotik" (es el mismo dominio: precios/config del servicio de
// internet). La aplicación real del descuento vive en
// routes/facturasInternet.ts + utils/promociones.ts; acá solo se administra
// el catálogo.
import { Router, Request, Response } from "express";
import { Prisma, AlcancePromocion } from "@prisma/client";
import { prisma } from "../db";
import { registrarAuditoria } from "../utils/auditoria";

export const promocionesRouter = Router();

const ALCANCES_VALIDOS = Object.values(AlcancePromocion);

interface PromocionBody {
  nombre: string;
  porcentajeDescuento: number;
  fechaInicio: string; // "YYYY-MM-DD"
  fechaFin?: string | null;
  alcance: AlcancePromocion;
  mesesDesdeContrato?: number | null;
  planInternetId?: number | null;
}

function validar(body: PromocionBody): string | null {
  if (!body.nombre?.trim()) return "nombre es obligatorio";
  const porcentaje = Number(body.porcentajeDescuento);
  if (!Number.isFinite(porcentaje) || porcentaje <= 0 || porcentaje > 100) {
    return "porcentajeDescuento debe ser un número entre 0 y 100";
  }
  if (!body.fechaInicio) return "fechaInicio es obligatoria";
  if (!ALCANCES_VALIDOS.includes(body.alcance)) return `alcance debe ser uno de: ${ALCANCES_VALIDOS.join(", ")}`;
  if (body.alcance === "CLIENTES_NUEVOS") {
    const meses = Number(body.mesesDesdeContrato);
    if (!Number.isInteger(meses) || meses <= 0) {
      return "mesesDesdeContrato es obligatorio (entero mayor a 0) cuando alcance es CLIENTES_NUEVOS";
    }
  }
  if (body.fechaFin && new Date(body.fechaFin) < new Date(body.fechaInicio)) {
    return "fechaFin no puede ser anterior a fechaInicio";
  }
  return null;
}

// GET /promociones — trae todas (activas e inactivas), la pantalla decide
// cómo mostrarlas; a diferencia de /planes-internet, acá el historial de
// promos pasadas es información útil (para ver qué se ofreció antes), no
// solo ruido.
promocionesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const promociones = await prisma.promocionPlan.findMany({
      include: { planInternet: { select: { id: true, nombre: true } } },
      orderBy: { fechaInicio: "desc" },
    });
    res.json(promociones);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las promociones" });
  }
});

// POST /promociones
promocionesRouter.post("/", async (req: Request, res: Response) => {
  try {
    const body = req.body as PromocionBody;
    const errorValidacion = validar(body);
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });

    if (body.planInternetId) {
      const plan = await prisma.planInternet.findUnique({ where: { id: Number(body.planInternetId) } });
      if (!plan) return res.status(404).json({ error: "Plan de internet no encontrado" });
    }

    const promocion = await prisma.promocionPlan.create({
      data: {
        nombre: body.nombre.trim(),
        porcentajeDescuento: new Prisma.Decimal(body.porcentajeDescuento),
        fechaInicio: new Date(body.fechaInicio),
        fechaFin: body.fechaFin ? new Date(body.fechaFin) : null,
        alcance: body.alcance,
        mesesDesdeContrato: body.alcance === "CLIENTES_NUEVOS" ? Number(body.mesesDesdeContrato) : null,
        planInternetId: body.planInternetId ? Number(body.planInternetId) : null,
      },
      include: { planInternet: { select: { id: true, nombre: true } } },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_PROMOCION",
      entidad: "PromocionPlan",
      entidadId: promocion.id,
      detalle: `${promocion.nombre}: ${promocion.porcentajeDescuento}% (${promocion.alcance})`,
    });

    res.status(201).json(promocion);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear la promoción" });
  }
});

// PUT /promociones/:id
promocionesRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const body = req.body as PromocionBody;
    const errorValidacion = validar(body);
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });

    if (body.planInternetId) {
      const plan = await prisma.planInternet.findUnique({ where: { id: Number(body.planInternetId) } });
      if (!plan) return res.status(404).json({ error: "Plan de internet no encontrado" });
    }

    const promocion = await prisma.promocionPlan.update({
      where: { id },
      data: {
        nombre: body.nombre.trim(),
        porcentajeDescuento: new Prisma.Decimal(body.porcentajeDescuento),
        fechaInicio: new Date(body.fechaInicio),
        fechaFin: body.fechaFin ? new Date(body.fechaFin) : null,
        alcance: body.alcance,
        mesesDesdeContrato: body.alcance === "CLIENTES_NUEVOS" ? Number(body.mesesDesdeContrato) : null,
        planInternetId: body.planInternetId ? Number(body.planInternetId) : null,
      },
      include: { planInternet: { select: { id: true, nombre: true } } },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_PROMOCION",
      entidad: "PromocionPlan",
      entidadId: promocion.id,
      detalle: `${promocion.nombre}: ${promocion.porcentajeDescuento}% (${promocion.alcance})`,
    });

    res.json(promocion);
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Promoción no encontrada" });
    console.error(error);
    res.status(500).json({ error: "Error al editar la promoción" });
  }
});

// DELETE /promociones/:id — borrado suave: las facturas ya emitidas con este
// descuento no cambian (ver comentario en el modelo), solo deja de
// aplicarse a facturas nuevas.
promocionesRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const promocion = await prisma.promocionPlan.update({ where: { id }, data: { activo: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_PROMOCION",
      entidad: "PromocionPlan",
      entidadId: promocion.id,
      detalle: promocion.nombre,
    });

    res.json({ mensaje: "Promoción desactivada", promocion });
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Promoción no encontrada" });
    console.error(error);
    res.status(500).json({ error: "Error al desactivar la promoción" });
  }
});
