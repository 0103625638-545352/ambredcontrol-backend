// Cálculo de indemnización por despido intempestivo y bonificación por
// desahucio (Art. 188 Código del Trabajo). Funciones puras, mismo estilo
// que utils/iess.ts.
//
// ¡¡¡ VERIFICAR ANTES DE USAR PARA UN PAGO REAL !!! Las fórmulas de
// indemnización por despido han cambiado varias veces con reformas
// laborales en Ecuador, y el resultado de esta función determina dinero
// real que se le debe a una persona real — a diferencia de un ajuste
// contable interno, un error acá tiene consecuencias legales directas.
// Antes de pagar cualquier liquidación calculada con estas funciones,
// confirma la fórmula vigente con un contador o abogado laboral. El PDF
// generado (ver utils/generarActaFiniquitoPdf.ts) debe mostrar este mismo
// aviso de forma visible, no solo quedar en el código.
import { Prisma } from "@prisma/client";

const ANIOS_UMBRAL_INDEMNIZACION = 3;
const MESES_INDEMNIZACION_HASTA_UMBRAL = 3; // fijo, no por año, para <= 3 años de servicio
const PORCENTAJE_BONIFICACION_DESAHUCIO = 25;

// Indemnización por despido intempestivo:
// - Hasta 3 años de servicio: 3 remuneraciones mensuales (monto fijo).
// - Más de 3 años: 1 remuneración mensual por cada año completo de servicio.
export function calcularIndemnizacionDespidoIntempestivo(sueldoMensual: Prisma.Decimal, aniosServicio: number): Prisma.Decimal {
  if (aniosServicio <= ANIOS_UMBRAL_INDEMNIZACION) {
    return sueldoMensual.mul(MESES_INDEMNIZACION_HASTA_UMBRAL);
  }
  return sueldoMensual.mul(Math.floor(aniosServicio));
}

// Bonificación por desahucio: 25% de 1 remuneración mensual por cada año
// completo de servicio (se suma a la indemnización en despido intempestivo).
export function calcularBonificacionDesahucio(sueldoMensual: Prisma.Decimal, aniosServicio: number): Prisma.Decimal {
  return sueldoMensual.mul(PORCENTAJE_BONIFICACION_DESAHUCIO).div(100).mul(Math.floor(aniosServicio));
}
