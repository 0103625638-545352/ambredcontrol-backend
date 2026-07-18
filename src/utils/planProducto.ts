// Mantiene sincronizado el Producto "espejo" de cada PlanInternet (ver
// PlanInternet.productoId en schema.prisma): la línea que efectivamente
// aparece en una Factura de internet es un Producto normal con
// esServicio=true y precioFijo=PlanInternet.precio, para poder reusar TODO
// el flujo de facturación/SRI existente (routes/facturas.ts) sin ninguna
// rama especial ahí — el único lugar que sabe que "esto es un plan de
// internet" es este archivo y routes/planesInternet.ts.
//
// Sin stock: nunca crea StockSucursal/StockBodega (mismo criterio que un
// producto nuevo con stock inicial 0, ver POST /productos) — no hay bodega
// de la que descuente, porque descontarStockVenta ni se llama para
// esServicio=true.
import { Prisma } from "@prisma/client";

export async function sincronizarProductoDePlan(
  tx: Prisma.TransactionClient,
  plan: { id: number; nombre: string; precio: Prisma.Decimal | number; productoId: number | null }
): Promise<number> {
  const nombreProducto = `Internet - ${plan.nombre}`;
  const precioFijo = new Prisma.Decimal(plan.precio);

  if (plan.productoId) {
    await tx.producto.update({
      where: { id: plan.productoId },
      data: { nombre: nombreProducto, precioFijo },
    });
    return plan.productoId;
  }

  const producto = await tx.producto.create({
    data: {
      codigo: `INTERNET-${plan.id}`,
      nombre: nombreProducto,
      descripcion: "Servicio mensual de internet — generado automáticamente desde Planes de Internet",
      esServicio: true,
      precioFijo,
      ivaPorcentaje: 15.0,
    },
  });
  await tx.planInternet.update({ where: { id: plan.id }, data: { productoId: producto.id } });
  return producto.id;
}
