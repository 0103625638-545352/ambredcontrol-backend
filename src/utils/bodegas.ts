import { prisma } from "../db";
import { Prisma } from "@prisma/client";

// A diferencia de sucursalDelUsuarioActual (fija por usuario, releída de la
// BD), la bodega se elige EXPLÍCITAMENTE en cada documento — Prisma no puede
// forzar a nivel de FK que una bodega pertenezca a una sucursal en
// particular, así que esta validación vive acá y se llama desde cada ruta
// que recibe un bodegaId en el body.
export async function bodegaValidaEnSucursal(bodegaId: number | undefined, sucursalId: number, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  if (!bodegaId) {
    throw new Error("BODEGA_OBLIGATORIA");
  }
  const bodega = await tx.bodega.findUnique({ where: { id: bodegaId } });
  if (!bodega || !bodega.activa) {
    throw new Error("BODEGA_NO_ENCONTRADA");
  }
  if (bodega.sucursalId !== sucursalId) {
    throw new Error("BODEGA_NO_PERTENECE_A_SUCURSAL");
  }
  return bodega;
}
