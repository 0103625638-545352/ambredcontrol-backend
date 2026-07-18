import { describe, it, expect } from "vitest";
import { ordenarPorCercania, type Punto } from "./rutaVisitas";

describe("ordenarPorCercania", () => {
  it("lista vacía: sin orden", () => {
    expect(ordenarPorCercania({ lat: 0, lng: 0 }, [])).toEqual([]);
  });

  it("una sola parada: se queda sola", () => {
    const paradas: Punto[] = [{ id: 1, lat: 1, lng: 1 }];
    expect(ordenarPorCercania({ lat: 0, lng: 0 }, paradas)).toEqual([1]);
  });

  it("3 paradas en línea recta: ordena de la más cercana al origen a la más lejana", () => {
    // Origen en (0,0). Paradas a 0.01/0.02/0.03 grados de latitud (todas
    // sobre la misma línea recta), agregadas fuera de orden a propósito
    // para confirmar que el algoritmo las reordena, no solo respeta el
    // orden de entrada.
    const paradas: Punto[] = [
      { id: 1, lat: 0.03, lng: 0 }, // la más lejana
      { id: 2, lat: 0.01, lng: 0 }, // la más cercana al origen
      { id: 3, lat: 0.02, lng: 0 }, // intermedia
    ];
    expect(ordenarPorCercania({ lat: 0, lng: 0 }, paradas)).toEqual([2, 3, 1]);
  });

  it("no se altera si ya llegan en el orden más cercano primero", () => {
    const paradas: Punto[] = [
      { id: 10, lat: 0.01, lng: 0 },
      { id: 20, lat: 0.02, lng: 0 },
      { id: 30, lat: 0.03, lng: 0 },
    ];
    expect(ordenarPorCercania({ lat: 0, lng: 0 }, paradas)).toEqual([10, 20, 30]);
  });
});
