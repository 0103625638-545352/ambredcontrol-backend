// Calcula el estado de "qué tan al día" está la última posición conocida de
// un técnico, a partir de hace cuántos minutos se capturó — mismo criterio
// de función pura + constantes de umbral que utils/estadoRedCliente.ts, para
// poder testearla sin tocar la base de datos. Usado por GET
// /ubicaciones-tecnicos/actual (ver routes/ubicacionesTecnicos.ts) y
// espejado en el color de cada marcador en MapaTecnicos.tsx.
export type EstadoUbicacionTecnico = "EN_LINEA" | "RECIENTE" | "DESCONECTADO" | "SIN_DATOS";

// La app manda una lectura cada ~2 min mientras está abierta (ver
// hooks/useUbicacionTecnico.ts) — "EN_LINEA" da un margen de un par de
// ciclos perdidos (celular con mala señal un momento) antes de pasar a
// "RECIENTE"; pasado el umbral de "RECIENTE" probablemente cerró la app,
// se quedó sin batería, o entró a una zona sin señal por un buen rato.
const UMBRAL_EN_LINEA_MINUTOS = 5;
const UMBRAL_RECIENTE_MINUTOS = 30;

export function calcularEstadoUbicacion(minutosDesdeUltima: number | null): EstadoUbicacionTecnico {
  if (minutosDesdeUltima === null) return "SIN_DATOS";
  if (minutosDesdeUltima <= UMBRAL_EN_LINEA_MINUTOS) return "EN_LINEA";
  if (minutosDesdeUltima <= UMBRAL_RECIENTE_MINUTOS) return "RECIENTE";
  return "DESCONECTADO";
}
