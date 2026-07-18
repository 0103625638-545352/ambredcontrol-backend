// Deriva el estado de pago (PENDIENTE/PARCIAL/PAGADA) a partir de cuánto se
// ha abonado contra el total — lo usan tanto Factura (cuentas por cobrar)
// como Compra (cuentas por pagar), ya que la regla es idéntica en los dos.
import { Prisma } from "@prisma/client";

export function calcularEstadoPago(
  montoPagado: Prisma.Decimal,
  total: Prisma.Decimal
): "PENDIENTE" | "PARCIAL" | "PAGADA" {
  if (montoPagado.gte(total)) return "PAGADA";
  if (montoPagado.gt(0)) return "PARCIAL";
  return "PENDIENTE";
}
