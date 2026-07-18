// Cálculo de vacaciones (Art. 69-73 Código del Trabajo). Funciones puras,
// mismo estilo que utils/iess.ts.
//
// VERIFICAR antes de usar para un pago real: la regla base (15 días/año) es
// estable, pero el detalle exacto de los días adicionales por antigüedad
// después del 5to año (y si existe o no un tope) ha tenido interpretaciones
// distintas — confirmar contra el Código del Trabajo vigente y, si hay
// duda, con un profesional, antes de aplicarlo a un caso real.
import { Prisma } from "@prisma/client";

const DIAS_BASE_ANUALES = 15;
const ANIOS_ANTES_DE_DIAS_ADICIONALES = 5;
const DIVISOR_VALOR_DIA = 24; // sueldo mensual ÷ 24 = valor de 1 día de vacación

function aniosCompletos(fechaIngreso: Date, fecha: Date): number {
  let anios = fecha.getFullYear() - fechaIngreso.getFullYear();
  const aniversarioEsteAnio = new Date(fechaIngreso);
  aniversarioEsteAnio.setFullYear(fecha.getFullYear());
  if (fecha < aniversarioEsteAnio) anios -= 1;
  return Math.max(anios, 0);
}

// 15 días base, +1 día por cada año completo después del 5to (VERIFICAR el
// tope exacto vigente — ver disclaimer arriba).
export function calcularDiasVacacionesPorAntiguedad(fechaIngreso: Date, fecha: Date): number {
  const anios = aniosCompletos(fechaIngreso, fecha);
  const aniosAdicionales = Math.max(anios - ANIOS_ANTES_DE_DIAS_ADICIONALES, 0);
  return DIAS_BASE_ANUALES + aniosAdicionales;
}

// Valor de los días de vacación no gozados: sueldo mensual ÷ 24 × días.
export function calcularValorVacaciones(sueldoMensual: Prisma.Decimal, dias: number): Prisma.Decimal {
  if (dias <= 0) return new Prisma.Decimal(0);
  return sueldoMensual.div(DIVISOR_VALOR_DIA).mul(dias);
}
