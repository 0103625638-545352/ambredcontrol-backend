import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { calcularAportePersonalIess, calcularAportePatronalIess, calcularFondoReserva, tieneDerechoAFondoReserva } from "./iess";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

describe("calcularAportePersonalIess", () => {
  it("9.45% de un sueldo de 482 (SBU 2026)", () => {
    expect(calcularAportePersonalIess(decimal(482)).toFixed(2)).toBe("45.55");
  });
});

describe("calcularAportePatronalIess", () => {
  it("11.15% de un sueldo de 482 (SBU 2026)", () => {
    expect(calcularAportePatronalIess(decimal(482)).toFixed(2)).toBe("53.74");
  });
});

describe("calcularFondoReserva", () => {
  it("8.33% de un sueldo de 600", () => {
    expect(calcularFondoReserva(decimal(600)).toFixed(2)).toBe("49.98");
  });
});

// Fechas construidas en HORA LOCAL ("new Date(anio, mes, dia)"), nunca con
// un string ISO ("new Date('2026-01-15')" se parsea como medianoche UTC,
// que en un servidor detrás de UTC como Ecuador cae en el día ANTERIOR en
// hora local) — mismo criterio que ya usa fechaLocalDeString en producción.
describe("tieneDerechoAFondoReserva", () => {
  it("no tiene derecho antes de cumplir 1 año", () => {
    const ingreso = new Date(2026, 0, 15);
    const hoy = new Date(2026, 5, 1);
    expect(tieneDerechoAFondoReserva(ingreso, hoy)).toBe(false);
  });

  it("tiene derecho justo al cumplir 1 año", () => {
    const ingreso = new Date(2025, 0, 15);
    const hoy = new Date(2026, 0, 15);
    expect(tieneDerechoAFondoReserva(ingreso, hoy)).toBe(true);
  });

  it("tiene derecho bastante después de 1 año", () => {
    const ingreso = new Date(2023, 0, 15);
    const hoy = new Date(2026, 5, 1);
    expect(tieneDerechoAFondoReserva(ingreso, hoy)).toBe(true);
  });
});
