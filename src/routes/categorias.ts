// Catálogo de categorías de producto. El modelo existía desde el día uno
// (Producto.categoriaId ya lo usa), pero nunca tuvo una ruta ni una pantalla
// propia — hasta ahora solo se podía asignar una categoría por su id "a
// ciegas". Es una lista corta por naturaleza, así que no pagina.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requirePermiso } from "../middleware/auth";
import { registrarAuditoria } from "../utils/auditoria";
import { leerBusqueda, contiene } from "../utils/busquedaListado";
import { leerRangoFechas } from "../utils/rangoFechas";

export const categoriasRouter = Router();

// GET /categorias
categoriasRouter.get("/", async (req: Request, res: Response) => {
  try {
    const rango = leerRangoFechas(req);
    // Buscador de la pantalla Categorías: nombre (texto libre) y si tiene o
    // no productos asignados. Sin parámetros responde igual que siempre (lo
    // usan los selectores de categoría de Productos).
    const q = leerBusqueda(req);
    const productos = req.query.productos;
    const categorias = await prisma.categoria.findMany({
      where: {
        activo: true,
        ...(rango && { createdAt: rango }),
        ...(q && { nombre: contiene(q) }),
        ...(productos === "con" && { productos: { some: {} } }),
        ...(productos === "sin" && { productos: { none: {} } }),
      },
      include: { _count: { select: { productos: true } } },
      orderBy: { nombre: "asc" },
    });
    res.json(categorias);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar categorías" });
  }
});

// POST /categorias
// Body: { nombre }
categoriasRouter.post("/", requirePermiso("productos"), async (req: Request, res: Response) => {
  try {
    const { nombre } = req.body;
    if (!nombre) {
      return res.status(400).json({ error: "nombre es obligatorio" });
    }
    const categoria = await prisma.categoria.create({ data: { nombre } });
    res.status(201).json(categoria);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear la categoría" });
  }
});

// PUT /categorias/:id
categoriasRouter.put("/:id", requirePermiso("productos"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre } = req.body;
    if (!nombre) {
      return res.status(400).json({ error: "nombre es obligatorio" });
    }
    const categoria = await prisma.categoria.update({ where: { id }, data: { nombre } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_CATEGORIA",
      entidad: "Categoria",
      entidadId: categoria.id,
      detalle: categoria.nombre,
    });

    res.json(categoria);
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Categoría no encontrada" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar la categoría" });
  }
});

// DELETE /categorias/:id
// Borrado suave: los productos que ya la tienen asignada conservan la
// referencia, solo deja de aparecer como opción para productos nuevos.
categoriasRouter.delete("/:id", requirePermiso("productos"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const categoria = await prisma.categoria.update({ where: { id }, data: { activo: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_CATEGORIA",
      entidad: "Categoria",
      entidadId: categoria.id,
      detalle: categoria.nombre,
    });

    res.json({ mensaje: "Categoría desactivada", categoria });
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Categoría no encontrada" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al desactivar la categoría" });
  }
});
