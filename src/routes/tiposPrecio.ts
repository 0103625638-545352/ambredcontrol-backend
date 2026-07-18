// Catálogo de categorías de precio de venta (ej. "Mayorista", "Minorista A")
// — cada Cliente se asigna a una (ver Cliente.tipoPrecioId en schema.prisma)
// y determina el precio que se le cobra en cada venta (ver utils/precios.ts).
// Mirror de routes/categorias.ts (misma forma de CRUD con borrado suave),
// pero con requireAdmin en vez de requirePermiso("productos"): a diferencia
// de una categoría de producto (una simple etiqueta), esto fija el precio de
// venta real de todo el catálogo para todos los clientes de esa categoría.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAdmin } from "../middleware/auth";
import { registrarAuditoria } from "../utils/auditoria";

export const tiposPrecioRouter = Router();

// GET /tipos-precio
tiposPrecioRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const tiposPrecio = await prisma.tipoPrecio.findMany({
      where: { activo: true },
      orderBy: { porcentajeGanancia: "asc" },
    });
    res.json(tiposPrecio);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las categorías de precio" });
  }
});

// POST /tipos-precio
// Body: { nombre, porcentajeGanancia }
tiposPrecioRouter.post("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { nombre, porcentajeGanancia } = req.body;
    if (!nombre || porcentajeGanancia === undefined) {
      return res.status(400).json({ error: "nombre y porcentajeGanancia son obligatorios" });
    }
    if (Number(porcentajeGanancia) < 0) {
      return res.status(400).json({ error: "porcentajeGanancia no puede ser negativo" });
    }
    const tipoPrecio = await prisma.tipoPrecio.create({ data: { nombre, porcentajeGanancia } });
    res.status(201).json(tipoPrecio);
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe una categoría de precio con ese nombre" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear la categoría de precio" });
  }
});

// PUT /tipos-precio/:id
tiposPrecioRouter.put("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre, porcentajeGanancia } = req.body;
    if (!nombre || porcentajeGanancia === undefined) {
      return res.status(400).json({ error: "nombre y porcentajeGanancia son obligatorios" });
    }
    if (Number(porcentajeGanancia) < 0) {
      return res.status(400).json({ error: "porcentajeGanancia no puede ser negativo" });
    }
    const tipoPrecio = await prisma.tipoPrecio.update({ where: { id }, data: { nombre, porcentajeGanancia } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_TIPO_PRECIO",
      entidad: "TipoPrecio",
      entidadId: tipoPrecio.id,
      detalle: `${tipoPrecio.nombre}: ${tipoPrecio.porcentajeGanancia}%`,
    });

    res.json(tipoPrecio);
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Categoría de precio no encontrada" });
    }
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe una categoría de precio con ese nombre" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar la categoría de precio" });
  }
});

// DELETE /tipos-precio/:id
// Borrado suave: los clientes que ya la tienen asignada la conservan, solo
// deja de aparecer como opción para clientes nuevos.
tiposPrecioRouter.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const tipoPrecio = await prisma.tipoPrecio.update({ where: { id }, data: { activo: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_TIPO_PRECIO",
      entidad: "TipoPrecio",
      entidadId: tipoPrecio.id,
      detalle: tipoPrecio.nombre,
    });

    res.json({ mensaje: "Categoría de precio desactivada", tipoPrecio });
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Categoría de precio no encontrada" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al desactivar la categoría de precio" });
  }
});
