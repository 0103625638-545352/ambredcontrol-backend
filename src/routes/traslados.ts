// Traslado interno de stock entre dos bodegas — pueden ser de la misma
// sucursal (reclasificar mercadería entre bodegas, ej. "Electrónicos" ↔
// "Verduras" dentro del mismo local) o de sucursales distintas. Solo
// redistribuye StockBodega/StockSucursal (nunca toca Producto.stockActual,
// ver el comentario en el schema). Solo admite productos que NO manejan
// lotes. No existe "anular traslado": un error se corrige con un traslado
// igual y opuesto.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { leerBusqueda, contiene } from "../utils/busquedaListado";
import { Prisma } from "@prisma/client";
import { requirePermiso } from "../middleware/auth";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { registrarAuditoria } from "../utils/auditoria";
import { sucursalDelUsuarioActual } from "../utils/sucursales";
import { bodegaValidaEnSucursal } from "../utils/bodegas";
import { leerRangoFechas } from "../utils/rangoFechas";

export const trasladosRouter = Router();

interface ItemTraslado {
  productoId: number;
  cantidad: number;
}

interface CrearTrasladoBody {
  bodegaDestinoId: number;
  items: ItemTraslado[];
  motivo?: string;
}

// GET /traslados
trasladosRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.TrasladoWhereInput = rango ? { createdAt: rango } : {};

    // Buscador: motivo, bodega/sucursal de origen o destino, usuario que lo
    // registró o un producto trasladado (nombre o código).
    const q = leerBusqueda(req);
    if (q) {
      where.OR = [
        { motivo: contiene(q) },
        { bodegaOrigen: { nombre: contiene(q) } },
        { bodegaDestino: { nombre: contiene(q) } },
        { sucursalOrigen: { nombre: contiene(q) } },
        { sucursalDestino: { nombre: contiene(q) } },
        { usuario: { nombre: contiene(q) } },
        { detalles: { some: { producto: { OR: [{ nombre: contiene(q) }, { codigo: contiene(q) }] } } } },
      ];
    }

    const opciones = {
      where,
      include: {
        sucursalOrigen: true,
        sucursalDestino: true,
        bodegaOrigen: true,
        bodegaDestino: true,
        usuario: { select: { id: true, nombre: true } },
      },
      orderBy: { createdAt: "desc" as const },
    };

    if (!paginacion.aplica) {
      const traslados = await prisma.traslado.findMany(opciones);
      return res.json(traslados);
    }

    const [traslados, total] = await Promise.all([
      prisma.traslado.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.traslado.count({ where }),
    ]);
    res.json(respuestaPaginada(traslados, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar traslados" });
  }
});

// GET /traslados/:id
trasladosRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const traslado = await prisma.traslado.findUnique({
      where: { id },
      include: {
        sucursalOrigen: true,
        sucursalDestino: true,
        bodegaOrigen: true,
        bodegaDestino: true,
        usuario: { select: { id: true, nombre: true } },
        detalles: { include: { producto: true } },
      },
    });
    if (!traslado) return res.status(404).json({ error: "Traslado no encontrado" });
    res.json(traslado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar el traslado" });
  }
});

// POST /traslados
// Body: { bodegaDestinoId, items: [{ productoId, cantidad }], motivo? }
// La bodega de ORIGEN nunca se acepta directamente como "de qué sucursal" —
// siempre tiene que pertenecer a la sucursal fija de quien hace la petición
// (releída de la BD): nadie puede sacar stock de un local que no es el
// suyo. La sucursal de destino se deriva de la bodega destino, no se pide
// aparte (una bodega ya implica su sucursal).
trasladosRouter.post("/", requirePermiso("traslados"), async (req: Request, res: Response) => {
  const { bodegaOrigenId, bodegaDestinoId, items, motivo } = req.body as CrearTrasladoBody & { bodegaOrigenId: number };

  if (!bodegaDestinoId || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "bodegaDestinoId e items (con al menos 1 producto) son obligatorios" });
  }

  try {
    const sucursalOrigen = await sucursalDelUsuarioActual(req.usuario!.usuarioId);
    const bodegaOrigen = await bodegaValidaEnSucursal(bodegaOrigenId, sucursalOrigen.id);

    if (bodegaDestinoId === bodegaOrigen.id) {
      return res.status(400).json({ error: "La bodega de destino no puede ser la misma que la de origen" });
    }
    const bodegaDestino = await prisma.bodega.findUnique({ where: { id: bodegaDestinoId } });
    if (!bodegaDestino || !bodegaDestino.activa) {
      return res.status(400).json({ error: "La bodega de destino no existe o está inactiva" });
    }
    const sucursalDestino = await prisma.sucursal.findUnique({ where: { id: bodegaDestino.sucursalId } });
    if (!sucursalDestino || !sucursalDestino.activa) {
      return res.status(400).json({ error: "La sucursal de la bodega de destino no existe o está inactiva" });
    }

    const traslado = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const detallesData = [];

      for (const item of items) {
        if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
          throw new Error(`CANTIDAD_INVALIDA:${item.productoId}`);
        }

        const producto = await tx.producto.findUnique({ where: { id: item.productoId } });
        if (!producto) throw new Error(`PRODUCTO_NO_ENCONTRADO:${item.productoId}`);
        if (producto.manejaLotes) {
          throw new Error(`PRODUCTO_CON_LOTE:${producto.nombre}`);
        }

        const stockOrigen = await tx.stockBodega.findUnique({
          where: { productoId_bodegaId: { productoId: producto.id, bodegaId: bodegaOrigen.id } },
        });
        if (!stockOrigen || stockOrigen.cantidad < item.cantidad) {
          throw new Error(`STOCK_INSUFICIENTE:${producto.nombre}`);
        }

        // Nunca toca Producto.stockActual: solo redistribuye entre dos filas
        // de StockBodega (y, si las bodegas son de sucursales distintas,
        // también entre dos filas de StockSucursal). Si origen y destino
        // comparten sucursal, las dos escrituras a StockSucursal caen sobre
        // la MISMA fila y se cancelan solas — no hace falta caso especial.
        await tx.stockBodega.update({
          where: { productoId_bodegaId: { productoId: producto.id, bodegaId: bodegaOrigen.id } },
          data: { cantidad: { decrement: item.cantidad } },
        });
        await tx.stockBodega.upsert({
          where: { productoId_bodegaId: { productoId: producto.id, bodegaId: bodegaDestinoId } },
          create: { productoId: producto.id, bodegaId: bodegaDestinoId, cantidad: item.cantidad },
          update: { cantidad: { increment: item.cantidad } },
        });

        await tx.stockSucursal.update({
          where: { productoId_sucursalId: { productoId: producto.id, sucursalId: sucursalOrigen.id } },
          data: { cantidad: { decrement: item.cantidad } },
        });
        await tx.stockSucursal.upsert({
          where: { productoId_sucursalId: { productoId: producto.id, sucursalId: sucursalDestino.id } },
          create: { productoId: producto.id, sucursalId: sucursalDestino.id, cantidad: item.cantidad },
          update: { cantidad: { increment: item.cantidad } },
        });

        await tx.movimientoInventario.create({
          data: {
            productoId: producto.id,
            tipo: "SALIDA",
            cantidad: item.cantidad,
            motivo: `Traslado a ${bodegaDestino.nombre} (${sucursalDestino.nombre})`,
            sucursalId: sucursalOrigen.id,
            bodegaId: bodegaOrigen.id,
          },
        });
        await tx.movimientoInventario.create({
          data: {
            productoId: producto.id,
            tipo: "ENTRADA",
            cantidad: item.cantidad,
            motivo: `Traslado desde ${bodegaOrigen.nombre} (${sucursalOrigen.nombre})`,
            sucursalId: sucursalDestino.id,
            bodegaId: bodegaDestinoId,
          },
        });

        detallesData.push({ productoId: producto.id, cantidad: item.cantidad });
      }

      const trasladoCreado = await tx.traslado.create({
        data: {
          sucursalOrigenId: sucursalOrigen.id,
          sucursalDestinoId: sucursalDestino.id,
          bodegaOrigenId: bodegaOrigen.id,
          bodegaDestinoId,
          motivo: motivo || undefined,
          usuarioId: req.usuario!.usuarioId,
          detalles: { create: detallesData },
        },
        include: { sucursalOrigen: true, sucursalDestino: true, bodegaOrigen: true, bodegaDestino: true, detalles: { include: { producto: true } } },
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "CREAR_TRASLADO",
        entidad: "Traslado",
        entidadId: trasladoCreado.id,
        detalle: `De ${bodegaOrigen.nombre} (${sucursalOrigen.nombre}) a ${bodegaDestino.nombre} (${sucursalDestino.nombre})`,
      });

      return trasladoCreado;
    });

    res.status(201).json(traslado);
  } catch (error: any) {
    if (error.message === "SIN_SUCURSAL_ASIGNADA") {
      return res.status(400).json({ error: "Tu usuario no tiene una sucursal asignada — pídele a un administrador que te asigne una" });
    }
    if (error.message === "BODEGA_OBLIGATORIA") {
      return res.status(400).json({ error: "Debes elegir una bodega de origen" });
    }
    if (error.message === "BODEGA_NO_ENCONTRADA") {
      return res.status(400).json({ error: "La bodega de origen no existe o está inactiva" });
    }
    if (error.message === "BODEGA_NO_PERTENECE_A_SUCURSAL") {
      return res.status(400).json({ error: "Esa bodega de origen no pertenece a tu sucursal" });
    }
    if (typeof error.message === "string" && error.message.startsWith("CANTIDAD_INVALIDA")) {
      return res.status(400).json({ error: "La cantidad de cada producto debe ser un entero mayor a 0" });
    }
    if (typeof error.message === "string" && error.message.startsWith("PRODUCTO_NO_ENCONTRADO")) {
      return res.status(404).json({ error: `Producto no encontrado: ${error.message.split(":")[1]}` });
    }
    if (typeof error.message === "string" && error.message.startsWith("PRODUCTO_CON_LOTE")) {
      return res.status(400).json({ error: `"${error.message.split(":")[1]}" maneja lotes: los traslados no admiten productos con lote todavía` });
    }
    if (typeof error.message === "string" && error.message.startsWith("STOCK_INSUFICIENTE")) {
      return res.status(409).json({ error: `Stock insuficiente en esa bodega para: ${error.message.split(":")[1]}` });
    }
    console.error(error);
    res.status(500).json({ error: "Error al registrar el traslado" });
  }
});
