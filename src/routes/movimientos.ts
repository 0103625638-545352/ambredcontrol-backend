// Rutas para registrar entradas, salidas y ajustes de stock.

import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { Prisma } from "@prisma/client";
import { requirePermiso } from "../middleware/auth";
import { sucursalDelUsuarioActual } from "../utils/sucursales";
import { bodegaValidaEnSucursal } from "../utils/bodegas";

export const movimientosRouter = Router();

// GET /movimientos/:productoId
// Devuelve el historial ("kardex") de un producto.
movimientosRouter.get("/:productoId", async (req: Request, res: Response) => {
  try {
    const productoId = Number(req.params.productoId);
    const movimientos = await prisma.movimientoInventario.findMany({
      where: { productoId },
      orderBy: { fecha: "desc" },
    });
    res.json(movimientos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener el kardex" });
  }
});

// POST /movimientos
// Body esperado: { productoId, tipo: "ENTRADA" | "SALIDA" | "AJUSTE", cantidad, motivo? }
// Para productos perecibles (manejaLotes), una ENTRADA además necesita
// { fechaCaducidad, numeroLote? }: esa cantidad se registra como un lote
// nuevo, no como stock "suelto".
movimientosRouter.post("/", requirePermiso("inventario"), async (req: Request, res: Response) => {
  try {
    const { productoId, bodegaId, tipo, cantidad, motivo, fechaCaducidad, numeroLote } = req.body;

    if (!productoId || !tipo || cantidad === undefined || cantidad === null) {
      return res.status(400).json({ error: "productoId, tipo y cantidad son obligatorios" });
    }
    if (!["ENTRADA", "SALIDA", "AJUSTE"].includes(tipo)) {
      return res.status(400).json({ error: "tipo debe ser ENTRADA, SALIDA o AJUSTE" });
    }
    // En ENTRADA/SALIDA "cantidad" es cuánto se mueve (tiene que ser positivo).
    // En AJUSTE "cantidad" es el nuevo stock absoluto (ej. resultado de un conteo
    // físico), así que 0 es un valor válido — solo un negativo no tiene sentido.
    if (tipo === "AJUSTE" ? cantidad < 0 : cantidad <= 0) {
      return res.status(400).json({
        error: tipo === "AJUSTE" ? "cantidad (el nuevo stock) no puede ser negativa" : "cantidad debe ser mayor a 0",
      });
    }
    if (tipo === "ENTRADA" && !fechaCaducidad) {
      const producto = await prisma.producto.findUnique({ where: { id: productoId } });
      if (producto?.manejaLotes) {
        return res.status(400).json({ error: "Este producto maneja lotes: fechaCaducidad es obligatoria en cada entrada" });
      }
    }

    // --- EL CONCEPTO CLAVE DE ESTA LECCIÓN: LA TRANSACCIÓN ---
    //
    // Necesitamos hacer DOS cosas que deben ocurrir juntas o no ocurrir ninguna:
    //   1. Crear el registro del movimiento (el "recibo" de qué pasó).
    //   2. Actualizar el stockActual del producto.
    //
    // ¿Qué pasaría si el servidor se cae justo entre el paso 1 y el paso 2?
    // Tendrías un movimiento registrado pero el stock NO reflejaría ese cambio,
    // o viceversa. Eso es un dato corrupto e imposible de confiar.
    //
    // prisma.$transaction agrupa varias operaciones en una sola unidad:
    // si cualquiera falla, TODAS se revierten (rollback). O pasan las dos, o no pasa ninguna.

    const resultado = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Bloquea la fila del producto para el resto de esta transacción. Sin
      // esto, dos movimientos concurrentes del MISMO producto podrían leer
      // el mismo stock "viejo" (stockActual / StockBodega.cantidad) antes de
      // que cualquiera confirme, y la segunda escritura pisaría (perdería)
      // el efecto de la primera — acá abajo el nuevo stock se calcula en JS
      // a partir de esta lectura, no con un increment/decrement atómico como
      // en compras/facturas/notasVenta/notasCredito/traslados. El lock solo
      // serializa los movimientos de ESTE producto entre sí; movimientos de
      // otros productos no se bloquean entre ellos.
      const filaBloqueada = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "Producto" WHERE id = ${productoId} FOR UPDATE`;
      if (filaBloqueada.length === 0) {
        throw new Error("PRODUCTO_NO_ENCONTRADO");
      }

      const producto = await tx.producto.findUnique({ where: { id: productoId } });

      if (!producto) {
        throw new Error("PRODUCTO_NO_ENCONTRADO");
      }

      // La sucursal/bodega solo aplican a productos SIN lote — uno con lote
      // sigue usando un único stock global, sin importar quién registre el
      // movimiento (ver Producto.stockActual en el schema). A diferencia de
      // la sucursal (fija por usuario), la bodega se elige explícitamente
      // acá también, porque un mismo usuario puede ajustar stock de más de
      // una bodega de su sucursal.
      const sucursal = producto.manejaLotes ? null : await sucursalDelUsuarioActual(req.usuario!.usuarioId);
      if (!producto.manejaLotes) {
        await bodegaValidaEnSucursal(bodegaId, sucursal!.id);
      }

      let loteProductoId: number | undefined;
      let nuevoStockGlobal: number;

      if (producto.manejaLotes) {
        // Sin cambios: el mismo cálculo global de siempre.
        if (tipo === "ENTRADA") {
          nuevoStockGlobal = producto.stockActual + cantidad;
        } else if (tipo === "SALIDA") {
          nuevoStockGlobal = producto.stockActual - cantidad;
          if (nuevoStockGlobal < 0) throw new Error("STOCK_INSUFICIENTE");
        } else {
          nuevoStockGlobal = cantidad;
        }

        if (tipo === "ENTRADA") {
          const lote = await tx.loteProducto.create({
            data: { productoId, numeroLote: numeroLote || undefined, fechaCaducidad: new Date(fechaCaducidad), cantidad },
          });
          loteProductoId = lote.id;
        }
      } else {
        // AJUSTE ahora opera al nivel más fino (bodega): "cantidad" es el
        // nuevo stock absoluto de ESA bodega, no de la sucursal completa —
        // el delta resultante se propaga por igual a StockSucursal y al
        // total global, para no pisar el stock que haya en otras bodegas
        // ni en otras sucursales (mismo criterio que ya usaba esta ruta un
        // nivel más arriba, generalizado un nivel más).
        const stockBodegaLocal = await tx.stockBodega.findUnique({
          where: { productoId_bodegaId: { productoId, bodegaId } },
        });
        const cantidadBodegaActual = stockBodegaLocal?.cantidad ?? 0;

        let nuevaCantidadBodega: number;
        let deltaBodega: number;
        if (tipo === "ENTRADA") {
          nuevaCantidadBodega = cantidadBodegaActual + cantidad;
          deltaBodega = cantidad;
        } else if (tipo === "SALIDA") {
          nuevaCantidadBodega = cantidadBodegaActual - cantidad;
          if (nuevaCantidadBodega < 0) throw new Error("STOCK_INSUFICIENTE");
          deltaBodega = -cantidad;
        } else {
          nuevaCantidadBodega = cantidad;
          deltaBodega = cantidad - cantidadBodegaActual;
        }

        await tx.stockBodega.upsert({
          where: { productoId_bodegaId: { productoId, bodegaId } },
          create: { productoId, bodegaId, cantidad: nuevaCantidadBodega },
          update: { cantidad: nuevaCantidadBodega },
        });

        await tx.stockSucursal.upsert({
          where: { productoId_sucursalId: { productoId, sucursalId: sucursal!.id } },
          // Si no existía la fila de sucursal, tampoco existía la de bodega
          // (ambas se crean siempre juntas) — así que partía de 0, y
          // deltaBodega no puede ser negativo acá (una SALIDA que llevara la
          // bodega bajo 0 ya se bloqueó arriba con STOCK_INSUFICIENTE).
          create: { productoId, sucursalId: sucursal!.id, cantidad: deltaBodega },
          update: { cantidad: { increment: deltaBodega } },
        });

        nuevoStockGlobal = producto.stockActual + deltaBodega;
      }

      const movimiento = await tx.movimientoInventario.create({
        data: { productoId, tipo, cantidad, motivo, loteProductoId, sucursalId: sucursal?.id, bodegaId: producto.manejaLotes ? undefined : bodegaId },
      });

      const productoActualizado = await tx.producto.update({
        where: { id: productoId },
        data: { stockActual: nuevoStockGlobal },
      });

      return { movimiento, productoActualizado };
    });

    res.status(201).json(resultado);
  } catch (error: any) {
    if (error.message === "PRODUCTO_NO_ENCONTRADO") {
      return res.status(404).json({ error: "El producto no existe" });
    }
    if (error.message === "SIN_SUCURSAL_ASIGNADA") {
      return res.status(400).json({ error: "Tu usuario no tiene una sucursal asignada — pídele a un administrador que te asigne una" });
    }
    if (error.message === "BODEGA_OBLIGATORIA") {
      return res.status(400).json({ error: "Debes elegir una bodega" });
    }
    if (error.message === "BODEGA_NO_ENCONTRADA") {
      return res.status(400).json({ error: "La bodega indicada no existe o está inactiva" });
    }
    if (error.message === "BODEGA_NO_PERTENECE_A_SUCURSAL") {
      return res.status(400).json({ error: "Esa bodega no pertenece a tu sucursal" });
    }
    if (error.message === "STOCK_INSUFICIENTE") {
      return res.status(409).json({ error: "No hay suficiente stock para esta salida" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al registrar el movimiento" });
  }
});
