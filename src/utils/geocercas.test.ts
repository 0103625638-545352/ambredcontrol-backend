import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { calcularDistanciaMetros, evaluarGeocerca, type SucursalConGeocerca } from "./geocercas";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

describe("calcularDistanciaMetros", () => {
  it("es 0 entre el mismo punto", () => {
    expect(calcularDistanciaMetros(-2.9, -79.0, -2.9, -79.0)).toBe(0);
  });

  it("~111.19 km por cada grado de latitud (valor conocido)", () => {
    const distancia = calcularDistanciaMetros(0, 0, 1, 0);
    expect(distancia).toBeGreaterThan(110_000);
    expect(distancia).toBeLessThan(112_000);
  });

  it("~111.19 km por cada grado de longitud en el ecuador (valor conocido)", () => {
    const distancia = calcularDistanciaMetros(0, 0, 0, 1);
    expect(distancia).toBeGreaterThan(110_000);
    expect(distancia).toBeLessThan(112_000);
  });

  it("un cuarto de la circunferencia terrestre entre dos puntos a 90° de longitud", () => {
    const distancia = calcularDistanciaMetros(0, 0, 0, 90);
    // Circunferencia media ~40,030 km -> un cuarto ~10,007 km
    expect(distancia).toBeGreaterThan(9_900_000);
    expect(distancia).toBeLessThan(10_100_000);
  });
});

describe("evaluarGeocerca", () => {
  const sucursalConGeocerca: SucursalConGeocerca = {
    latitud: decimal(-2.9001),
    longitud: decimal(-79.0059),
    radioGeocercaMetros: 100,
  };

  it("no evalúa (null/null) si la sucursal no tiene geocerca configurada", () => {
    const sucursalSinGeocerca: SucursalConGeocerca = { latitud: null, longitud: null, radioGeocercaMetros: null };
    const resultado = evaluarGeocerca(sucursalSinGeocerca, -2.9001, -79.0059);
    expect(resultado.distanciaMetros).toBeNull();
    expect(resultado.dentroDeGeocerca).toBeNull();
  });

  it("no evalúa (null/null) si la marcación no trae coordenadas", () => {
    const resultado = evaluarGeocerca(sucursalConGeocerca, null, null);
    expect(resultado.distanciaMetros).toBeNull();
    expect(resultado.dentroDeGeocerca).toBeNull();
  });

  it("no evalúa (null/null) si no hay sucursal (empleado sin sucursalId)", () => {
    const resultado = evaluarGeocerca(null, -2.9001, -79.0059);
    expect(resultado.distanciaMetros).toBeNull();
    expect(resultado.dentroDeGeocerca).toBeNull();
  });

  it("dentroDeGeocerca=true cuando la marcación está prácticamente en el mismo punto", () => {
    const resultado = evaluarGeocerca(sucursalConGeocerca, -2.9001, -79.0059);
    expect(resultado.dentroDeGeocerca).toBe(true);
    expect(resultado.distanciaMetros).toBeLessThan(1);
  });

  it("dentroDeGeocerca=false cuando la marcación está lejos del radio configurado", () => {
    // ~1 grado de distancia, muy por fuera de un radio de 100 metros
    const resultado = evaluarGeocerca(sucursalConGeocerca, -3.9001, -79.0059);
    expect(resultado.dentroDeGeocerca).toBe(false);
    expect(resultado.distanciaMetros).toBeGreaterThan(100);
  });
});
