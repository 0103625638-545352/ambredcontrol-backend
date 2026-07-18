// Costo promedio ponderado MÓVIL de un producto — actualizado en cada
// movimiento que aporta un costo CONOCIDO (una compra entra a su
// costoUnitario real, una devolución a proveedor sale al costo prorrateado
// de la compra original). Nunca se usa para ventas ni notas de crédito: esas
// mueven stock a favor/en contra del costo promedio YA vigente, sin aportar
// información de costo nueva (vender no cambia el promedio de lo que queda,
// y una devolución de cliente reingresa unidades valoradas exactamente al
// promedio vigente, lo cual es matemáticamente un no-op sobre ese promedio).
import { Prisma } from "@prisma/client";

// "cantidadDelta" positivo = entra a este costo (compra); negativo = sale a
// este costo (devolución a proveedor, anulación de compra).
export function actualizarCostoPromedio(
  stockAntes: number,
  costoPromedioAntes: Prisma.Decimal | null,
  cantidadDelta: number,
  costoUnitarioDelMovimiento: Prisma.Decimal
): Prisma.Decimal {
  const stockDespues = stockAntes + cantidadDelta;
  const valorAntes = (costoPromedioAntes ?? new Prisma.Decimal(0)).mul(stockAntes);
  const valorDespues = valorAntes.add(costoUnitarioDelMovimiento.mul(cantidadDelta));
  return stockDespues > 0 ? valorDespues.div(stockDespues) : new Prisma.Decimal(0);
}
