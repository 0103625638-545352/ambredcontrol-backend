// Suma el total ya devuelto a un proveedor sobre una compra puntual —
// DevolucionCompra nunca edita Compra.total/montoPagado (igual criterio que
// NotaCredito nunca edita Factura.total: el documento original queda intacto
// tal como lo emitió el proveedor), así que el saldo real pendiente de pago
// se calcula restando esto en cada lugar que hoy usa
// "compra.total.sub(compra.montoPagado)" — ver compras.ts (POST /:id/pagos),
// retenciones.ts (POST /) y reportes.ts (GET /cuentas-por-pagar).
import { Prisma, PrismaClient } from "@prisma/client";

export async function totalDevueltoDeCompra(
  cliente: PrismaClient | Prisma.TransactionClient,
  compraId: number
): Promise<Prisma.Decimal> {
  const resultado = await cliente.devolucionCompra.aggregate({
    where: { compraId },
    _sum: { total: true },
  });
  return resultado._sum.total ?? new Prisma.Decimal(0);
}
