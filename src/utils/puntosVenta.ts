import { prisma } from "../db";

// Solo se usa en POST /caja/abrir — el único lugar donde alguien elige un
// punto de venta a mano (en el resto del sistema se hereda en silencio de
// la caja abierta, ver utils/cajaSesionActual.ts). A diferencia de
// bodegaValidaEnSucursal, puntoVentaId es opcional: si no viene, no hay
// nada que validar (la sucursal no está usando puntos de venta).
export async function puntoVentaValidoEnSucursal(puntoVentaId: number | undefined, sucursalId: number) {
  if (!puntoVentaId) return null;

  const puntoVenta = await prisma.puntoDeVenta.findUnique({ where: { id: puntoVentaId } });
  if (!puntoVenta || !puntoVenta.activo) {
    throw new Error("PUNTO_VENTA_NO_ENCONTRADO");
  }
  if (puntoVenta.sucursalId !== sucursalId) {
    throw new Error("PUNTO_VENTA_NO_PERTENECE_A_SUCURSAL");
  }
  return puntoVenta;
}
