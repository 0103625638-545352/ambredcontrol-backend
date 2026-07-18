// Genera el código interno de un producto nuevo — ya no se escribe a mano
// (ver routes/productos.ts): antes era un campo de texto libre que el
// usuario tipeaba, ahora es correlativo y automático, "PROD-00001",
// "PROD-00002", etc. Mismo patrón atómico que generarClaveAcceso/Secuencial
// para las facturas (upsert + increment DENTRO de la transacción de
// creación, para que dos productos creados al mismo tiempo nunca choquen en
// el mismo número — Postgres bloquea la fila del contador hasta que la
// transacción termine).
import { Prisma } from "@prisma/client";

export async function generarCodigoProducto(tx: Prisma.TransactionClient): Promise<string> {
  const contador = await tx.contadorProducto.upsert({
    where: { id: 1 },
    create: { id: 1, ultimoNumero: 1 },
    update: { ultimoNumero: { increment: 1 } },
  });
  return `PROD-${String(contador.ultimoNumero).padStart(5, "0")}`;
}
