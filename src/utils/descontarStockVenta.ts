// Descuenta stock por una venta (factura, nota de venta, o conversión de
// proforma), respetando el seguimiento por lotes cuando el producto lo usa.
//
// Si el producto NO maneja lotes, es el comportamiento de siempre: solo
// decrementa stockActual y deja un movimiento SALIDA.
//
// Si el producto SÍ maneja lotes, consume primero del lote que caduca más
// pronto (FEFO - First Expired, First Out), dejando un movimiento SALIDA por
// cada lote tocado (para poder reconstruir de cuál salió cada unidad). Si la
// cantidad pedida supera lo que hay repartido en lotes registrados (ej. stock
// cargado antes de activar el seguimiento por lotes, o una devolución que se
// sumó sin volver a asignarse a un lote puntual), el sobrante se descuenta
// igual, sin caducidad asociada — nunca bloquea la venta por esto.
import { Prisma } from "@prisma/client";

export async function descontarStockVenta(
  tx: Prisma.TransactionClient,
  producto: { id: number; manejaLotes: boolean },
  cantidadVendida: number,
  motivo: string,
  sucursalId: number,
  bodegaId: number
): Promise<void> {
  if (!producto.manejaLotes) {
    await tx.producto.update({
      where: { id: producto.id },
      data: { stockActual: { decrement: cantidadVendida } },
    });
    await tx.stockSucursal.update({
      where: { productoId_sucursalId: { productoId: producto.id, sucursalId } },
      data: { cantidad: { decrement: cantidadVendida } },
    });
    await tx.stockBodega.update({
      where: { productoId_bodegaId: { productoId: producto.id, bodegaId } },
      data: { cantidad: { decrement: cantidadVendida } },
    });
    await tx.movimientoInventario.create({
      data: { productoId: producto.id, tipo: "SALIDA", cantidad: cantidadVendida, motivo, sucursalId, bodegaId },
    });
    return;
  }

  let restante = cantidadVendida;
  const lotes = await tx.loteProducto.findMany({
    where: { productoId: producto.id, cantidad: { gt: 0 } },
    orderBy: { fechaCaducidad: "asc" },
  });

  for (const lote of lotes) {
    if (restante <= 0) break;
    const consumir = Math.min(lote.cantidad, restante);
    await tx.loteProducto.update({ where: { id: lote.id }, data: { cantidad: { decrement: consumir } } });
    await tx.movimientoInventario.create({
      data: { productoId: producto.id, tipo: "SALIDA", cantidad: consumir, motivo, loteProductoId: lote.id },
    });
    restante -= consumir;
  }

  if (restante > 0) {
    await tx.movimientoInventario.create({
      data: { productoId: producto.id, tipo: "SALIDA", cantidad: restante, motivo },
    });
  }

  await tx.producto.update({
    where: { id: producto.id },
    data: { stockActual: { decrement: cantidadVendida } },
  });
}
