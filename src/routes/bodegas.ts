// Gestión de bodegas (subdivisión física DENTRO de una sucursal). Crear/
// editar/desactivar es admin-only — mismo criterio que /sucursales: definir
// qué bodegas existen es una decisión estructural, no una acción rutinaria.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAdmin } from "../middleware/auth";
import { registrarAuditoria } from "../utils/auditoria";

export const bodegasRouter = Router();

// GET /bodegas — abierto a cualquier autenticado (lo necesitan los selects
// de Compras, Punto de Venta, Movimientos y Traslados). Filtro opcional
// ?sucursalId= para acotar a las bodegas de una sucursal en particular.
bodegasRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { sucursalId } = req.query;
    const bodegas = await prisma.bodega.findMany({
      where: {
        activa: true,
        ...(sucursalId ? { sucursalId: Number(sucursalId) } : {}),
      },
      orderBy: { nombre: "asc" },
    });
    res.json(bodegas);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar bodegas" });
  }
});

// POST /bodegas
bodegasRouter.post("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { nombre, sucursalId } = req.body;
    if (!nombre) return res.status(400).json({ error: "nombre es obligatorio" });
    if (!sucursalId) return res.status(400).json({ error: "sucursalId es obligatorio" });

    const sucursal = await prisma.sucursal.findUnique({ where: { id: Number(sucursalId) } });
    if (!sucursal) return res.status(400).json({ error: "La sucursal indicada no existe" });

    const bodega = await prisma.bodega.create({ data: { nombre, sucursalId: Number(sucursalId) } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_BODEGA",
      entidad: "Bodega",
      entidadId: bodega.id,
      detalle: `${bodega.nombre} (${sucursal.nombre})`,
    });

    res.status(201).json(bodega);
  } catch (error: any) {
    if (error.code === "P2002") return res.status(409).json({ error: "Ya existe una bodega con ese nombre en esa sucursal" });
    console.error(error);
    res.status(500).json({ error: "Error al crear la bodega" });
  }
});

// PUT /bodegas/:id — solo el nombre es editable; sucursalId no cambia
// después de creada (evita dejar huérfano el desglose de StockBodega ya
// acumulado bajo el supuesto de una sucursal fija).
bodegasRouter.put("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ error: "nombre es obligatorio" });

    const bodega = await prisma.bodega.update({ where: { id }, data: { nombre } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_BODEGA",
      entidad: "Bodega",
      entidadId: bodega.id,
      detalle: bodega.nombre,
    });

    res.json(bodega);
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Bodega no encontrada" });
    if (error.code === "P2002") return res.status(409).json({ error: "Ya existe una bodega con ese nombre en esa sucursal" });
    console.error(error);
    res.status(500).json({ error: "Error al editar la bodega" });
  }
});

// PATCH /bodegas/:id/desactivar
// Borrado suave — igual criterio que Sucursal: el historial que ya
// referencia esta bodega no se pierde. A diferencia de Sucursal, acá SÍ hay
// una invariante de negocio que hacer cumplir: toda sucursal debe quedar
// con al menos una bodega activa, así que se bloquea si esta es la última.
bodegasRouter.patch("/:id/desactivar", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const bodega = await prisma.bodega.findUnique({ where: { id } });
    if (!bodega) return res.status(404).json({ error: "Bodega no encontrada" });

    const otrasActivas = await prisma.bodega.count({
      where: { sucursalId: bodega.sucursalId, activa: true, id: { not: id } },
    });
    if (otrasActivas === 0) {
      return res.status(409).json({ error: "No puedes desactivar la última bodega activa de esta sucursal" });
    }

    const bodegaDesactivada = await prisma.bodega.update({ where: { id }, data: { activa: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_BODEGA",
      entidad: "Bodega",
      entidadId: bodegaDesactivada.id,
      detalle: bodegaDesactivada.nombre,
    });

    res.json({ mensaje: "Bodega desactivada", bodega: bodegaDesactivada });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al desactivar la bodega" });
  }
});
