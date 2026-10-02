// Producto "espejo" para cobrar la multa por incumplimiento de vigencia
// contractual (ver Cliente.vigenciaContratoMeses/fechaInicioServicio y POST
// /clientes/:id/imponer-multa) — mismo patrón que utils/planProducto.ts: un
// Producto normal con esServicio=true para reusar TODO el flujo de
// facturación/SRI (routes/facturas.ts) sin ninguna rama especial ahí. A
// diferencia del plan de internet (un producto por plan, precio fijo del
// plan), acá hay UN SOLO producto compartido por todas las multas — el
// monto lo decide el admin caso por caso, así que precioFijo se reescribe
// justo antes de facturar cada multa.
import { Prisma } from "@prisma/client";

const CODIGO_PRODUCTO_MULTA = "COD-MUL";
const NOMBRE_PRODUCTO_MULTA = "Cobro de equipos por vigencia";

export async function obtenerProductoMultaConMonto(tx: Prisma.TransactionClient, monto: Prisma.Decimal | number): Promise<number> {
  const precioFijo = new Prisma.Decimal(monto);
  const existente = await tx.producto.findUnique({ where: { codigo: CODIGO_PRODUCTO_MULTA } });

  if (existente) {
    await tx.producto.update({ where: { id: existente.id }, data: { precioFijo } });
    return existente.id;
  }

  const producto = await tx.producto.create({
    data: {
      codigo: CODIGO_PRODUCTO_MULTA,
      nombre: NOMBRE_PRODUCTO_MULTA,
      descripcion: "Cobro de equipos por incumplimiento de la vigencia mínima pactada del contrato — generado automáticamente desde Clientes",
      esServicio: true,
      precioFijo,
      ivaPorcentaje: 15.0,
    },
  });
  return producto.id;
}
