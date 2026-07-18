// Backfill puntual: calcula el costo promedio ponderado NETO (compras menos
// devoluciones a proveedor) de cada producto con historial de compras, y lo
// guarda en Producto.costoPromedioActual — necesario una sola vez al
// desplegar esta mejora, para que el campo no arranque vacío para productos
// que ya tenían compras antes de que existiera este campo. De ahí en
// adelante se mantiene solo (ver utils/costeoInventario.ts, usado en
// routes/compras.ts y routes/devolucionesCompra.ts).
//
// Uso: npx ts-node backfill-costo-promedio.ts
// Corre contra DATABASE_URL (hoy solo existe la empresa "principal";
// empresas nuevas creadas después de este cambio no necesitan backfill, su
// costo se construye solo desde su primera compra real).

import { PrismaClient, Prisma } from "@prisma/client";
import * as dotenv from "dotenv";

dotenv.config({ quiet: true });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("No se encontró DATABASE_URL en tu archivo .env");
  }

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

  try {
    const productos = await prisma.producto.findMany({ select: { id: true, nombre: true } });
    console.log(`Calculando costo promedio para ${productos.length} producto(s)...`);

    let actualizados = 0;
    let sinDatos = 0;

    for (const producto of productos) {
      const comprasDetalle = await prisma.compraDetalle.findMany({
        where: { productoId: producto.id, compra: { estado: { not: "ANULADA" } } },
      });

      // Filtra también las devoluciones cuya compra original haya sido
      // anulada — no debería poder pasar hacia adelante (una compra con
      // devoluciones ya no se puede anular, ver PATCH /compras/:id/anular),
      // pero datos históricos previos a ese arreglo podrían tener esa
      // combinación, y contarlos dejaría el neto mal.
      const devolucionesDetalle = await prisma.devolucionCompraDetalle.findMany({
        where: { productoId: producto.id, compraDetalle: { compra: { estado: { not: "ANULADA" } } } },
      });

      let cantidadNeta = 0;
      let valorNeto = new Prisma.Decimal(0);

      for (const d of comprasDetalle) {
        cantidadNeta += d.cantidad;
        valorNeto = valorNeto.add(d.costoUnitario.mul(d.cantidad));
      }
      for (const d of devolucionesDetalle) {
        cantidadNeta -= d.cantidad;
        valorNeto = valorNeto.sub(d.costoUnitario.mul(d.cantidad));
      }

      const costoPromedio = cantidadNeta > 0 ? valorNeto.div(cantidadNeta) : null;

      await prisma.producto.update({
        where: { id: producto.id },
        data: { costoPromedioActual: costoPromedio },
      });

      if (costoPromedio) {
        actualizados++;
        console.log(`  - ${producto.nombre}: $${costoPromedio.toFixed(4)}`);
      } else {
        sinDatos++;
      }
    }

    console.log(`\nListo: ${actualizados} producto(s) con costo calculado, ${sinDatos} sin datos de costo (nunca comprados, o todo devuelto).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Error en el backfill:", error.message);
  process.exit(1);
});
