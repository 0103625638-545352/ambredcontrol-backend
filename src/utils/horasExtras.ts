// Cálculo de horas suplementarias y extraordinarias (Art. 55 Código del
// Trabajo). Funciones puras, mismo estilo que utils/iess.ts.
//
// Hora ordinaria = sueldo mensual ÷ 240 (jornada completa de 8h × 30 días).
// Hora suplementaria (después de la jornada, antes de las 24:00): recargo
// 50% → valor hora × 1.5.
// Hora extraordinaria (00:00-06:00, o sábado/domingo/feriado): recargo
// 100% → valor hora × 2.
//
// El recargo nocturno (19:00-06:00, 25% adicional) NO se modela como línea
// aparte en esta ronda — se puede sumar como "otros ingresos" manual en el
// rol de pagos si hace falta (es el caso menos común de los tres recargos).
import { Prisma } from "@prisma/client";

const HORAS_JORNADA_MENSUAL = 240;
const RECARGO_HORA_SUPLEMENTARIA = 1.5;
const RECARGO_HORA_EXTRAORDINARIA = 2;

export function calcularValorHoraOrdinaria(sueldoMensual: Prisma.Decimal): Prisma.Decimal {
  return sueldoMensual.div(HORAS_JORNADA_MENSUAL);
}

export function calcularValorHorasSuplementarias(sueldoMensual: Prisma.Decimal, horas: number): Prisma.Decimal {
  if (horas <= 0) return new Prisma.Decimal(0);
  return calcularValorHoraOrdinaria(sueldoMensual).mul(RECARGO_HORA_SUPLEMENTARIA).mul(horas);
}

export function calcularValorHorasExtraordinarias(sueldoMensual: Prisma.Decimal, horas: number): Prisma.Decimal {
  if (horas <= 0) return new Prisma.Decimal(0);
  return calcularValorHoraOrdinaria(sueldoMensual).mul(RECARGO_HORA_EXTRAORDINARIA).mul(horas);
}
