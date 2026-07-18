// Cálculo de geocerca para marcaciones de asistencia (ver
// routes/marcaciones.ts). Funciones puras (sin I/O), mismo estilo que
// utils/iess.ts — se testean aparte en geocercas.test.ts.
//
// La geocerca es una señal de apoyo para que un admin revise el reporte de
// marcaciones, NUNCA un bloqueo: un GPS de celular típico tiene una
// precisión de 10-50 metros, así que rechazar la marcación de plano
// arriesgaría dejar a un empleado real sin poder marcar por un error de
// ubicación, no de identidad.
import { Prisma } from "@prisma/client";

const RADIO_TIERRA_METROS = 6_371_000;

// Distancia entre dos coordenadas (grados decimales) sobre la superficie de
// la Tierra, en metros — fórmula de Haversine.
export function calcularDistanciaMetros(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radianes = (grados: number) => (grados * Math.PI) / 180;
  const deltaLat = radianes(lat2 - lat1);
  const deltaLng = radianes(lng2 - lng1);
  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(radianes(lat1)) * Math.cos(radianes(lat2)) * Math.sin(deltaLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return RADIO_TIERRA_METROS * c;
}

export interface SucursalConGeocerca {
  latitud: Prisma.Decimal | null;
  longitud: Prisma.Decimal | null;
  radioGeocercaMetros: number | null;
}

export interface ResultadoGeocerca {
  distanciaMetros: number | null;
  dentroDeGeocerca: boolean | null;
}

// null en ambos campos = "no evaluado" — pasa exactamente en dos casos: la
// sucursal todavía no tiene geocerca configurada (Ajustes), o la marcación
// llegó sin coordenadas (el celular no compartió ubicación). ambos casos se
// tratan igual: se registra la marcación de todas formas (ver Alcance del
// plan de esta ronda).
export function evaluarGeocerca(
  sucursal: SucursalConGeocerca | null | undefined,
  latitud: number | null | undefined,
  longitud: number | null | undefined
): ResultadoGeocerca {
  if (
    !sucursal ||
    sucursal.latitud === null ||
    sucursal.longitud === null ||
    sucursal.radioGeocercaMetros === null ||
    latitud == null ||
    longitud == null
  ) {
    return { distanciaMetros: null, dentroDeGeocerca: null };
  }

  const distanciaMetros = calcularDistanciaMetros(
    sucursal.latitud.toNumber(),
    sucursal.longitud.toNumber(),
    latitud,
    longitud
  );

  return { distanciaMetros, dentroDeGeocerca: distanciaMetros <= sucursal.radioGeocercaMetros };
}
