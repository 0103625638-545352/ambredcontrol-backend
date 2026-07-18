// Ordenamiento de paradas de una ruta de visita técnica por cercanía en
// línea recta (ver routes/visitas.ts: POST /visitas/rutas). Función pura,
// mismo estilo que utils/iess.ts.
//
// A propósito NO usa un servicio de rutas por calles (Google Directions,
// OSRM, etc.) — esta ronda solo ordena por distancia Haversine, gratis y
// sin dependencias externas, reusando calcularDistanciaMetros ya construido
// para geocercas. Ordenar por calles reales queda como una mejora futura si
// hace falta.
import { calcularDistanciaMetros } from "./geocercas";

export interface Punto {
  id: number;
  lat: number;
  lng: number;
}

// Vecino más cercano goloso: desde "origen", repetidamente elige la parada
// no visitada más cercana a la posición actual, la agrega al orden, y
// mueve la posición actual a esa parada. No es el óptimo global (eso sería
// un problema NP-difícil de "viajante de comercio"), pero para el puñado de
// visitas de un día es una aproximación razonable y suficiente.
export function ordenarPorCercania(origen: { lat: number; lng: number }, paradas: Punto[]): number[] {
  const pendientes = [...paradas];
  const orden: number[] = [];
  let posicionActual = origen;

  while (pendientes.length > 0) {
    let indiceMasCercano = 0;
    let distanciaMinima = Infinity;
    for (let i = 0; i < pendientes.length; i++) {
      const distancia = calcularDistanciaMetros(posicionActual.lat, posicionActual.lng, pendientes[i].lat, pendientes[i].lng);
      if (distancia < distanciaMinima) {
        distanciaMinima = distancia;
        indiceMasCercano = i;
      }
    }
    const siguiente = pendientes.splice(indiceMasCercano, 1)[0];
    orden.push(siguiente.id);
    posicionActual = { lat: siguiente.lat, lng: siguiente.lng };
  }

  return orden;
}
