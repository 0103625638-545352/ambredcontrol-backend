// Gestión de sucursales (locales físicos de la misma empresa). Crear/editar/
// desactivar es admin-only (igual que /usuarios) — definir qué sucursales
// existe es una decisión estructural, no una acción rutinaria como sí lo es
// hacer un traslado (ver routes/traslados.ts, gateado por el permiso
// "traslados" — separado de "inventario" a propósito, ver utils/permisos.ts).
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAdmin, requirePermiso } from "../middleware/auth";
import { registrarAuditoria } from "../utils/auditoria";

export const sucursalesRouter = Router();

// GET /sucursales — abierto a cualquier autenticado (lo necesitan los selects
// de Usuarios, Punto de Venta y Traslados).
sucursalesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const sucursales = await prisma.sucursal.findMany({
      where: { activa: true },
      orderBy: { nombre: "asc" },
    });
    res.json(sucursales);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar sucursales" });
  }
});

// POST /sucursales
// Toda sucursal nace ya con una "Bodega Principal" propia — es lo que hace
// cumplir la regla de que ninguna sucursal se quede sin al menos una bodega
// activa (ver schema.prisma, comentario sobre Bodega).
sucursalesRouter.post("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { nombre, direccion } = req.body;
    if (!nombre) return res.status(400).json({ error: "nombre es obligatorio" });

    const sucursal = await prisma.$transaction(async (tx) => {
      const nuevaSucursal = await tx.sucursal.create({ data: { nombre, direccion: direccion || undefined } });
      await tx.bodega.create({ data: { nombre: "Bodega Principal", sucursalId: nuevaSucursal.id } });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "CREAR_SUCURSAL",
        entidad: "Sucursal",
        entidadId: nuevaSucursal.id,
        detalle: nuevaSucursal.nombre,
      });

      return nuevaSucursal;
    });

    res.status(201).json(sucursal);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear la sucursal" });
  }
});

// PUT /sucursales/:id
sucursalesRouter.put("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre, direccion } = req.body;
    if (!nombre) return res.status(400).json({ error: "nombre es obligatorio" });

    const sucursal = await prisma.sucursal.update({ where: { id }, data: { nombre, direccion: direccion || null } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_SUCURSAL",
      entidad: "Sucursal",
      entidadId: sucursal.id,
      detalle: sucursal.nombre,
    });

    res.json(sucursal);
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Sucursal no encontrada" });
    console.error(error);
    res.status(500).json({ error: "Error al editar la sucursal" });
  }
});

// PATCH /sucursales/:id/geocerca
// Configura la geocerca usada por las marcaciones de asistencia (ver
// utils/geocercas.ts, routes/marcaciones.ts) — gateado por "configuracion"
// (no requireAdmin como el resto de este archivo) a propósito: esta acción
// vive junto al resto de Ajustes de la empresa, gateadas por ese mismo
// permiso en routes/configuracion.ts, y es una configuración operativa, no
// una decisión estructural de "qué sucursales existen" como sí lo es
// crear/renombrar una sucursal.
sucursalesRouter.patch("/:id/geocerca", requirePermiso("configuracion"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { latitud, longitud, radioGeocercaMetros } = req.body as {
      latitud?: number | null;
      longitud?: number | null;
      radioGeocercaMetros?: number | null;
    };

    // Los tres se limpian juntos (todos null) o se fijan juntos — una
    // geocerca a medio configurar (ej. solo latitud) no sirve para nada y
    // evaluarGeocerca la trataría igual que "sin configurar".
    const completa = latitud != null && longitud != null && radioGeocercaMetros != null;
    const vacia = latitud == null && longitud == null && radioGeocercaMetros == null;
    if (!completa && !vacia) {
      return res.status(400).json({ error: "latitud, longitud y radioGeocercaMetros deben venir los tres juntos, o los tres vacíos para borrar la geocerca" });
    }
    if (completa && (radioGeocercaMetros as number) <= 0) {
      return res.status(400).json({ error: "radioGeocercaMetros debe ser mayor a 0" });
    }

    const sucursal = await prisma.sucursal.update({
      where: { id },
      data: { latitud: latitud ?? null, longitud: longitud ?? null, radioGeocercaMetros: radioGeocercaMetros ?? null },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CONFIGURAR_GEOCERCA_SUCURSAL",
      entidad: "Sucursal",
      entidadId: sucursal.id,
      detalle: sucursal.nombre,
    });

    res.json(sucursal);
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Sucursal no encontrada" });
    console.error(error);
    res.status(500).json({ error: "Error al configurar la geocerca" });
  }
});

// PATCH /sucursales/:id/desactivar
// Borrado suave — igual criterio que Categoria/Usuario: el historial que ya
// referencia esta sucursal (movimientos, facturas, etc.) no se pierde.
sucursalesRouter.patch("/:id/desactivar", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const sucursal = await prisma.sucursal.update({ where: { id }, data: { activa: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_SUCURSAL",
      entidad: "Sucursal",
      entidadId: sucursal.id,
      detalle: sucursal.nombre,
    });

    res.json({ mensaje: "Sucursal desactivada", sucursal });
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Sucursal no encontrada" });
    console.error(error);
    res.status(500).json({ error: "Error al desactivar la sucursal" });
  }
});
