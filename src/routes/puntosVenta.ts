// Gestión de puntos de venta (cajas registradoras DENTRO de una sucursal).
// A diferencia de bodegas.ts, NO hay candado de "no desactivar el último
// activo" — un punto de venta es opcional, una sucursal puede válidamente
// quedar con cero (sigue funcionando con una sola caja compartida).
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAdmin } from "../middleware/auth";
import { registrarAuditoria } from "../utils/auditoria";

export const puntosVentaRouter = Router();

// GET /puntos-venta — abierto a cualquier autenticado (lo necesita el
// selector opcional de "Abrir caja" y la tarjeta de administración).
// Filtro opcional ?sucursalId= para acotar a una sucursal.
puntosVentaRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { sucursalId } = req.query;
    const puntosVenta = await prisma.puntoDeVenta.findMany({
      where: {
        activo: true,
        ...(sucursalId ? { sucursalId: Number(sucursalId) } : {}),
      },
      orderBy: { nombre: "asc" },
    });
    res.json(puntosVenta);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar puntos de venta" });
  }
});

// POST /puntos-venta
puntosVentaRouter.post("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { nombre, sucursalId } = req.body;
    if (!nombre) return res.status(400).json({ error: "nombre es obligatorio" });
    if (!sucursalId) return res.status(400).json({ error: "sucursalId es obligatorio" });

    const sucursal = await prisma.sucursal.findUnique({ where: { id: Number(sucursalId) } });
    if (!sucursal) return res.status(400).json({ error: "La sucursal indicada no existe" });

    const puntoVenta = await prisma.puntoDeVenta.create({ data: { nombre, sucursalId: Number(sucursalId) } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_PUNTO_VENTA",
      entidad: "PuntoDeVenta",
      entidadId: puntoVenta.id,
      detalle: `${puntoVenta.nombre} (${sucursal.nombre})`,
    });

    res.status(201).json(puntoVenta);
  } catch (error: any) {
    if (error.code === "P2002") return res.status(409).json({ error: "Ya existe un punto de venta con ese nombre en esa sucursal" });
    console.error(error);
    res.status(500).json({ error: "Error al crear el punto de venta" });
  }
});

// PUT /puntos-venta/:id — solo el nombre es editable; sucursalId no cambia
// después de creado (mismo criterio que Bodega).
puntosVentaRouter.put("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ error: "nombre es obligatorio" });

    const puntoVenta = await prisma.puntoDeVenta.update({ where: { id }, data: { nombre } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_PUNTO_VENTA",
      entidad: "PuntoDeVenta",
      entidadId: puntoVenta.id,
      detalle: puntoVenta.nombre,
    });

    res.json(puntoVenta);
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Punto de venta no encontrado" });
    if (error.code === "P2002") return res.status(409).json({ error: "Ya existe un punto de venta con ese nombre en esa sucursal" });
    console.error(error);
    res.status(500).json({ error: "Error al editar el punto de venta" });
  }
});

// PATCH /puntos-venta/:id/desactivar — borrado suave, sin candados: una
// sucursal puede válidamente terminar con cero puntos de venta activos.
puntosVentaRouter.patch("/:id/desactivar", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const puntoVenta = await prisma.puntoDeVenta.update({ where: { id }, data: { activo: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_PUNTO_VENTA",
      entidad: "PuntoDeVenta",
      entidadId: puntoVenta.id,
      detalle: puntoVenta.nombre,
    });

    res.json({ mensaje: "Punto de venta desactivado", puntoVenta });
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Punto de venta no encontrado" });
    console.error(error);
    res.status(500).json({ error: "Error al desactivar el punto de venta" });
  }
});
