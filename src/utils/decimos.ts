// Cálculo de décimo tercer y décimo cuarto sueldo (Ecuador). Funciones
// puras, mismo estilo que utils/iess.ts.
import { Prisma } from "@prisma/client";

// Décimo cuarto 2026 = 1 SBU. Verificar cada año (el gobierno lo fija en
// enero) — se deja como constante nombrada, no un número suelto.
export const SBU_VIGENTE = 482;

const MESES_POR_ANIO = 12;

// Décimo tercero ("bono navideño"): se suma todo lo percibido por el
// trabajador entre el 1-dic del año anterior y el 30-nov del año en curso,
// y ese total se divide entre 12. Pago máximo el 24-dic (o mensualizado).
export function calcularDecimoTercero(totalIngresosPeriodo: Prisma.Decimal): Prisma.Decimal {
  return totalIngresosPeriodo.div(MESES_POR_ANIO);
}

// Décimo cuarto ("bono escolar"): 1 SBU al año, proporcional a los meses
// laborados en el período de la región del empleado (ver Sucursal.region):
// Sierra/Amazonía (1-ago a 31-jul, pago hasta 15-ago) o Costa/Galápagos
// (1-mar a 28/29-feb, pago hasta 15-mar). mesesLaborados se limita a 12
// (un empleado no puede acumular más de un período completo).
export function calcularDecimoCuarto(sbu: number, mesesLaborados: number): Prisma.Decimal {
  const meses = Math.min(Math.max(mesesLaborados, 0), MESES_POR_ANIO);
  return new Prisma.Decimal(sbu).div(MESES_POR_ANIO).mul(meses);
}

// Período del décimo cuarto que se PAGA en "anio", según la región:
// Sierra/Amazonía: 1-ago del año anterior a 31-jul de "anio".
// Costa/Galápagos: 1-mar del año anterior a 28/29-feb de "anio".
export function rangoDecimoCuarto(anio: number, region: string): { desde: Date; hasta: Date } {
  if (region === "COSTA_GALAPAGOS") {
    // new Date(anio, 2, 0) = "día 0 de marzo" = último día real de febrero
    // (28 o 29 según si "anio" es bisiesto) — evita el desborde a marzo que
    // daría new Date(anio, 1, 29) en un año no bisiesto.
    return { desde: new Date(anio - 1, 2, 1), hasta: new Date(anio, 2, 0) };
  }
  return { desde: new Date(anio - 1, 7, 1), hasta: new Date(anio, 6, 31) };
}

// Meses laborados dentro de un rango, acotado por fecha de ingreso/salida
// del empleado — usado para el proporcional del décimo cuarto. Cuenta
// meses CALENDARIO de forma inclusiva (si "inicio" y "fin" caen en el mismo
// mes, cuenta 1, no 0) — así un empleado que trabajó el período completo
// (ej. 1-ago a 31-jul, ambos inclusive) da exactamente 12, no 11: el rango
// abarca 12 meses calendario distintos (ago, sep, ..., jul), aunque la
// diferencia en DÍAS entre esas dos fechas sea de solo 364 días.
export function calcularMesesLaboradosEnRango(fechaIngreso: Date, fechaSalida: Date | null, desde: Date, hasta: Date): number {
  const inicio = fechaIngreso > desde ? fechaIngreso : desde;
  const fin = fechaSalida && fechaSalida < hasta ? fechaSalida : hasta;
  if (fin < inicio) return 0;
  const meses = (fin.getFullYear() - inicio.getFullYear()) * 12 + (fin.getMonth() - inicio.getMonth()) + 1;
  return Math.min(Math.max(meses, 0), MESES_POR_ANIO);
}
