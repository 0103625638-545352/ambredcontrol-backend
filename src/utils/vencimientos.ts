// Cálculo de mora (días de atraso) para cuentas por cobrar/pagar. Separado de
// las rutas para poder testearlo sin base de datos (mismo criterio que
// estadoPago.ts/precios.ts). "ahora" SIEMPRE se recibe como parámetro, nunca
// se usa `new Date()` interno, para que el test pueda fijarlo.

export function calcularDiasAtraso(fechaVencimiento: Date | null, estadoPago: string, ahora: Date): number | null {
  if (!fechaVencimiento || estadoPago === "PAGADA") return null;

  // Se compara por DÍA CALENDARIO, no por milisegundos transcurridos — una
  // factura que venció ayer está "1 día atrasada" ni bien empieza hoy, sin
  // tener que esperar a que pasen 24h completas desde el fin de ese día.
  // Una que vence hoy todavía no cuenta como atrasada (diferencia = 0).
  const inicioDiaVencimiento = new Date(fechaVencimiento);
  inicioDiaVencimiento.setHours(0, 0, 0, 0);
  const inicioDiaAhora = new Date(ahora);
  inicioDiaAhora.setHours(0, 0, 0, 0);

  const diasTranscurridos = Math.round((inicioDiaAhora.getTime() - inicioDiaVencimiento.getTime()) / (1000 * 60 * 60 * 24));
  if (diasTranscurridos <= 0) return null; // vence hoy o en el futuro: aún no está atrasada

  return diasTranscurridos;
}

// Días que faltan para el vencimiento (0 = vence hoy). null si no tiene
// fecha de vencimiento o si ya venció (eso ya lo cubre calcularDiasAtraso).
// A propósito NO recibe estadoPago: quien llame a esto ya filtró "no
// pagada" en su propia consulta (a diferencia de calcularDiasAtraso, que sí
// lo necesita porque lo usa código que no pre-filtra).
export function calcularDiasParaVencer(fechaVencimiento: Date | null, ahora: Date): number | null {
  if (!fechaVencimiento) return null;

  const inicioDiaVencimiento = new Date(fechaVencimiento);
  inicioDiaVencimiento.setHours(0, 0, 0, 0);
  const inicioDiaAhora = new Date(ahora);
  inicioDiaAhora.setHours(0, 0, 0, 0);

  const diasTranscurridos = Math.round((inicioDiaAhora.getTime() - inicioDiaVencimiento.getTime()) / (1000 * 60 * 60 * 24));
  if (diasTranscurridos > 0) return null; // ya venció, no es "por vencer"

  return Math.abs(diasTranscurridos); // 0, 1, 2... días para vencer (Math.abs evita el -0 de "vence hoy")
}

export type BucketMora = "AL_DIA" | "1_30" | "31_60" | "61_90" | "MAS_90";

export function bucketMora(diasAtraso: number | null): BucketMora {
  if (diasAtraso === null) return "AL_DIA";
  if (diasAtraso <= 30) return "1_30";
  if (diasAtraso <= 60) return "31_60";
  if (diasAtraso <= 90) return "61_90";
  return "MAS_90";
}
