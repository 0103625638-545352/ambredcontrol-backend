// Cálculos de aportes al IESS (Instituto Ecuatoriano de Seguridad Social)
// sobre el sueldo de un empleado. Funciones puras (sin I/O), mismo estilo
// que utils/retenciones.ts — se testean aparte en iess.test.ts.
//
// Porcentajes vigentes en Ecuador para 2026 (verificar cada año, el IESS
// los puede ajustar): 9.45% aporte personal (se descuenta al empleado),
// 11.15% aporte patronal (lo paga la empresa, no se descuenta), 8.33%
// fondo de reserva (lo paga la empresa desde el 2do año de servicio
// continuo — ver Empleado.fondoReservaMensualizado en el schema).
import { Prisma } from "@prisma/client";

export const PORCENTAJE_APORTE_PERSONAL_IESS = 9.45;
export const PORCENTAJE_APORTE_PATRONAL_IESS = 11.15;
export const PORCENTAJE_FONDO_RESERVA = 8.33;

export function calcularAportePersonalIess(sueldo: Prisma.Decimal): Prisma.Decimal {
  return sueldo.mul(PORCENTAJE_APORTE_PERSONAL_IESS).div(100);
}

export function calcularAportePatronalIess(sueldo: Prisma.Decimal): Prisma.Decimal {
  return sueldo.mul(PORCENTAJE_APORTE_PATRONAL_IESS).div(100);
}

export function calcularFondoReserva(sueldo: Prisma.Decimal): Prisma.Decimal {
  return sueldo.mul(PORCENTAJE_FONDO_RESERVA).div(100);
}

// Un empleado tiene derecho al fondo de reserva recién desde su segundo año
// de servicio continuo (después de completar 12 meses).
export function tieneDerechoAFondoReserva(fechaIngreso: Date, fecha: Date): boolean {
  const unAnioDespues = new Date(fechaIngreso);
  unAnioDespues.setFullYear(unAnioDespues.getFullYear() + 1);
  return fecha >= unAnioDespues;
}
