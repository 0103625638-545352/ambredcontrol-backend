// Metraje de cable: rollos enteros (ej. 305m de UTP) entregados a un
// técnico, que salen de la bodega como una SALIDA real de inventario en ese
// momento (ver el comentario "Módulo de METRAJE DE CABLE" en
// schema.prisma). El consumo por visita (ver routes/visitas.ts,
// PATCH /:id/detalle-trabajo) solo descuenta metrosRestantes de la
// asignación, nunca vuelve a tocar el stock de bodega. Gateado por el
// permiso "inventario" salvo GET /mis-rollos, que es para cualquier
// técnico logueado consultando SUS PROPIOS rollos.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requirePermiso } from "../middleware/auth";
import { registrarAuditoria } from "../utils/auditoria";
import { sucursalDelUsuarioActual } from "../utils/sucursales";
import { bodegaValidaEnSucursal } from "../utils/bodegas";

export const metrajeRouter = Router();

const puedeAdministrar = requirePermiso("inventario");

// GET /metraje/asignaciones?activo=true
metrajeRouter.get("/asignaciones", puedeAdministrar, async (req: Request, res: Response) => {
  try {
    const soloActivas = req.query.activo === "true";
    const asignaciones = await prisma.asignacionMetraje.findMany({
      where: soloActivas ? { activo: true } : {},
      include: {
        producto: { select: { id: true, nombre: true, codigo: true, unidadMedida: true } },
        empleado: { select: { id: true, nombres: true, apellidos: true } },
        bodega: { select: { id: true, nombre: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(asignaciones);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las asignaciones de metraje" });
  }
});

// GET /metraje/mis-rollos — para el técnico logueado, solo SUS rollos con
// metros disponibles. Cualquier usuario autenticado puede pedirlo (no
// requiere el permiso "inventario"): un técnico de campo llenando su propia
// acta de visita normalmente no lo tiene.
metrajeRouter.get("/mis-rollos", async (req: Request, res: Response) => {
  try {
    const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario!.usuarioId }, select: { empleadoId: true } });
    if (!usuario?.empleadoId) return res.json([]); // no está vinculado a un Empleado — no puede tener rollos

    const rollos = await prisma.asignacionMetraje.findMany({
      where: { empleadoId: usuario.empleadoId, activo: true, metrosRestantes: { gt: 0 } },
      include: { producto: { select: { id: true, nombre: true, codigo: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(rollos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar tus rollos asignados" });
  }
});

// POST /metraje/asignaciones
// Body: { productoId, empleadoId, metros, bodegaId }
metrajeRouter.post("/asignaciones", puedeAdministrar, async (req: Request, res: Response) => {
  try {
    const { productoId, empleadoId, metros, bodegaId } = req.body;
    if (!productoId || !empleadoId || !metros || Number(metros) <= 0) {
      return res.status(400).json({ error: "productoId, empleadoId y metros (mayor a 0) son obligatorios" });
    }

    const resultado = await prisma.$transaction(async (tx) => {
      // Bloquea la fila del producto por el resto de esta transacción —
      // mismo criterio que en POST /movimientos: sin este lock, dos
      // asignaciones concurrentes de ESTE producto podrían leer el mismo
      // StockBodega.cantidad "viejo" y la segunda escritura (un upsert con
      // valor absoluto, no un increment) pisaría el efecto de la primera.
      const filaBloqueada = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "Producto" WHERE id = ${Number(productoId)} FOR UPDATE`;
      if (filaBloqueada.length === 0) throw new Error("PRODUCTO_NO_ENCONTRADO");

      const producto = await tx.producto.findUnique({ where: { id: Number(productoId) } });
      if (!producto) throw new Error("PRODUCTO_NO_ENCONTRADO");
      if (producto.manejaLotes) throw new Error("PRODUCTO_CON_LOTE_NO_SOPORTADO");

      const empleado = await tx.empleado.findUnique({ where: { id: Number(empleadoId) } });
      if (!empleado || !empleado.activo) throw new Error("EMPLEADO_NO_ENCONTRADO");

      const sucursal = await sucursalDelUsuarioActual(req.usuario!.usuarioId);
      const bodega = await bodegaValidaEnSucursal(bodegaId, sucursal.id, tx);

      const metrosNum = Number(metros);
      const stockBodegaLocal = await tx.stockBodega.findUnique({
        where: { productoId_bodegaId: { productoId: producto.id, bodegaId: bodega.id } },
      });
      const cantidadBodegaActual = stockBodegaLocal?.cantidad ?? 0;
      const nuevaCantidadBodega = cantidadBodegaActual - metrosNum;
      if (nuevaCantidadBodega < 0) throw new Error("STOCK_INSUFICIENTE");

      await tx.stockBodega.upsert({
        where: { productoId_bodegaId: { productoId: producto.id, bodegaId: bodega.id } },
        create: { productoId: producto.id, bodegaId: bodega.id, cantidad: nuevaCantidadBodega },
        update: { cantidad: nuevaCantidadBodega },
      });
      await tx.stockSucursal.upsert({
        where: { productoId_sucursalId: { productoId: producto.id, sucursalId: sucursal.id } },
        create: { productoId: producto.id, sucursalId: sucursal.id, cantidad: -metrosNum },
        update: { cantidad: { increment: -metrosNum } },
      });
      await tx.producto.update({ where: { id: producto.id }, data: { stockActual: { decrement: metrosNum } } });

      await tx.movimientoInventario.create({
        data: {
          productoId: producto.id,
          tipo: "SALIDA",
          cantidad: metrosNum,
          motivo: `Rollo asignado a ${empleado.nombres} ${empleado.apellidos}`,
          sucursalId: sucursal.id,
          bodegaId: bodega.id,
        },
      });

      return tx.asignacionMetraje.create({
        data: {
          productoId: producto.id,
          empleadoId: empleado.id,
          bodegaId: bodega.id,
          metrosIniciales: metrosNum,
          metrosRestantes: metrosNum,
        },
        include: {
          producto: { select: { id: true, nombre: true, codigo: true } },
          empleado: { select: { id: true, nombres: true, apellidos: true } },
          bodega: { select: { id: true, nombre: true } },
        },
      });
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "ASIGNAR_ROLLO_METRAJE",
      entidad: "AsignacionMetraje",
      entidadId: resultado.id,
      detalle: `${resultado.metrosIniciales}m de ${resultado.producto.nombre} a ${resultado.empleado.nombres} ${resultado.empleado.apellidos}`,
    });

    res.status(201).json(resultado);
  } catch (error: any) {
    if (error.message === "PRODUCTO_NO_ENCONTRADO") return res.status(404).json({ error: "El producto no existe" });
    if (error.message === "PRODUCTO_CON_LOTE_NO_SOPORTADO") {
      return res.status(400).json({ error: "Este producto maneja lotes de caducidad — el metraje no aplica ahí" });
    }
    if (error.message === "EMPLEADO_NO_ENCONTRADO") return res.status(404).json({ error: "El empleado no existe o está inactivo" });
    if (error.message === "SIN_SUCURSAL_ASIGNADA") return res.status(400).json({ error: "Tu usuario no tiene una sucursal asignada" });
    if (error.message === "BODEGA_OBLIGATORIA") return res.status(400).json({ error: "Debes elegir una bodega" });
    if (error.message === "BODEGA_NO_ENCONTRADA") return res.status(400).json({ error: "La bodega indicada no existe o está inactiva" });
    if (error.message === "BODEGA_NO_PERTENECE_A_SUCURSAL") return res.status(400).json({ error: "Esa bodega no pertenece a tu sucursal" });
    if (error.message === "STOCK_INSUFICIENTE") return res.status(409).json({ error: "No hay suficiente stock de ese producto en esa bodega" });
    console.error(error);
    res.status(500).json({ error: "Error al asignar el rollo" });
  }
});

// PATCH /metraje/asignaciones/:id/cerrar
// Body: { devolverSobrante?: boolean, metrosFisicos?: number } — si
// devolverSobrante, repone el sobrante a la MISMA bodega de origen
// (ENTRADA) antes de desactivar la asignación. metrosFisicos = lo que se
// MIDIÓ en bodega al recibir el rollo: si viene, eso es lo que entra al
// stock (no lo que el sistema creía que quedaba) y la diferencia queda
// registrada como metrosFaltantes (cuadre del técnico, ver Centro de
// Control). Sin metrosFisicos, se comporta como siempre.
metrajeRouter.patch("/asignaciones/:id/cerrar", puedeAdministrar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const devolverSobrante = req.body.devolverSobrante === true;
    const metrosFisicos = req.body.metrosFisicos === undefined || req.body.metrosFisicos === null || req.body.metrosFisicos === "" ? null : Number(req.body.metrosFisicos);
    if (metrosFisicos !== null && (!Number.isInteger(metrosFisicos) || metrosFisicos < 0)) {
      return res.status(400).json({ error: "metrosFisicos debe ser un número entero mayor o igual a 0" });
    }

    const resultado = await prisma.$transaction(async (tx) => {
      const asignacion = await tx.asignacionMetraje.findUnique({ where: { id } });
      if (!asignacion) throw new Error("ASIGNACION_NO_ENCONTRADA");
      if (!asignacion.activo) throw new Error("YA_CERRADA");
      if (metrosFisicos !== null && metrosFisicos > asignacion.metrosIniciales) throw new Error("METROS_FISICOS_EXCESIVOS");

      // Lo que realmente vuelve a bodega: lo medido si se midió, si no lo
      // que dice el sistema (comportamiento de siempre).
      const metrosADevolver = metrosFisicos ?? asignacion.metrosRestantes;
      const metrosFaltantes = metrosFisicos !== null ? asignacion.metrosRestantes - metrosFisicos : null;

      if (devolverSobrante && metrosADevolver > 0) {
        const bodega = await tx.bodega.findUnique({ where: { id: asignacion.bodegaId } });
        if (!bodega) throw new Error("BODEGA_NO_ENCONTRADA");

        // Mismo lock que en POST /asignaciones: evita perder el sobrante
        // devuelto si esto corre a la vez que otro movimiento del mismo
        // producto (ver comentario ahí).
        await tx.$queryRaw`SELECT id FROM "Producto" WHERE id = ${asignacion.productoId} FOR UPDATE`;

        const stockBodegaLocal = await tx.stockBodega.findUnique({
          where: { productoId_bodegaId: { productoId: asignacion.productoId, bodegaId: asignacion.bodegaId } },
        });
        const nuevaCantidadBodega = (stockBodegaLocal?.cantidad ?? 0) + metrosADevolver;
        await tx.stockBodega.upsert({
          where: { productoId_bodegaId: { productoId: asignacion.productoId, bodegaId: asignacion.bodegaId } },
          create: { productoId: asignacion.productoId, bodegaId: asignacion.bodegaId, cantidad: nuevaCantidadBodega },
          update: { cantidad: nuevaCantidadBodega },
        });
        await tx.stockSucursal.upsert({
          where: { productoId_sucursalId: { productoId: asignacion.productoId, sucursalId: bodega.sucursalId } },
          create: { productoId: asignacion.productoId, sucursalId: bodega.sucursalId, cantidad: metrosADevolver },
          update: { cantidad: { increment: metrosADevolver } },
        });
        await tx.producto.update({ where: { id: asignacion.productoId }, data: { stockActual: { increment: metrosADevolver } } });
        await tx.movimientoInventario.create({
          data: {
            productoId: asignacion.productoId,
            tipo: "ENTRADA",
            cantidad: metrosADevolver,
            motivo: "Devolución de sobrante de rollo asignado",
            sucursalId: bodega.sucursalId,
            bodegaId: asignacion.bodegaId,
          },
        });
      }

      return tx.asignacionMetraje.update({
        where: { id },
        data: {
          activo: false,
          ...(devolverSobrante ? { metrosRestantes: 0 } : {}),
          ...(metrosFisicos !== null ? { metrosDevueltosFisicos: metrosFisicos, metrosFaltantes } : {}),
        },
      });
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CERRAR_ROLLO_METRAJE",
      entidad: "AsignacionMetraje",
      entidadId: resultado.id,
      detalle:
        (devolverSobrante ? "Sobrante devuelto a bodega" : "Cerrada sin devolver sobrante") +
        (resultado.metrosFaltantes != null ? ` — conteo físico ${resultado.metrosDevueltosFisicos} m, diferencia ${resultado.metrosFaltantes} m` : ""),
    });

    res.json(resultado);
  } catch (error: any) {
    if (error.message === "ASIGNACION_NO_ENCONTRADA") return res.status(404).json({ error: "Asignación no encontrada" });
    if (error.message === "YA_CERRADA") return res.status(400).json({ error: "Esta asignación ya está cerrada" });
    if (error.message === "METROS_FISICOS_EXCESIVOS") return res.status(400).json({ error: "Los metros contados no pueden ser más que los que tenía el rollo al entregarse" });
    console.error(error);
    res.status(500).json({ error: "Error al cerrar la asignación" });
  }
});
