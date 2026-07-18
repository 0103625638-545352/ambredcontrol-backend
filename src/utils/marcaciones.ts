// Detección de tardanza para marcaciones de asistencia (ver
// routes/marcaciones.ts). Función pura, mismo estilo que utils/iess.ts.
//
// Sin período de gracia esta ronda (ej. "tolera 5 minutos") — si hace falta
// más adelante, se agrega acá, un solo lugar.

// "fecha" en HORA LOCAL del servidor (Date normal, ver el resto del
// proyecto), "horaEsperada" en formato "HH:MM".
export function esTardanza(fecha: Date, horaEsperada: string): boolean {
  const [horaEsp, minEsp] = horaEsperada.split(":").map(Number);
  const minutosEsperados = horaEsp * 60 + minEsp;
  const minutosReales = fecha.getHours() * 60 + fecha.getMinutes();
  return minutosReales > minutosEsperados;
}
