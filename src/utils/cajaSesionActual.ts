import { prisma } from "../db";

// A diferencia de sucursalDelUsuarioActual, esto NUNCA lanza — no tener
// una caja abierta es un estado normal (Caja es un módulo opcional), no un
// error. Ahora que puede haber más de una CajaSesion ABIERTA por sucursal
// (una por punto de venta), "mi caja" ya no se resuelve por sucursal sino
// por quién la abrió — así cada cajero opera siempre sobre la suya, sin
// importar cuántas otras estén abiertas al mismo tiempo en el mismo local.
export async function cajaAbiertaDelUsuarioActual(usuarioId: number) {
  return prisma.cajaSesion.findFirst({
    where: { abiertaPorId: usuarioId, estado: "ABIERTA" },
    include: { puntoVenta: true },
  });
}
