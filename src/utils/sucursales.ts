import { prisma } from "../db";

// Vuelve a leer de la base de datos la sucursal fija del usuario que hace la
// petición (nunca del JWT/localStorage) — así, si un admin reasigna a alguien
// de local, se aplica en su siguiente petición, no cuando vuelva a iniciar
// sesión (mismo criterio ya usado para permisos, ver middleware/auth.ts).
export async function sucursalDelUsuarioActual(usuarioId: number) {
  const usuario = await prisma.usuario.findUnique({
    where: { id: usuarioId },
    select: { sucursal: { select: { id: true, nombre: true, activa: true } } },
  });
  if (!usuario?.sucursal || !usuario.sucursal.activa) {
    throw new Error("SIN_SUCURSAL_ASIGNADA");
  }
  return usuario.sucursal;
}
