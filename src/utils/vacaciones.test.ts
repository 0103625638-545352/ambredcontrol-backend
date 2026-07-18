import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { calcularDiasVacacionesPorAntiguedad, calcularValorVacaciones } from "./vacaciones";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

// Fechas en HORA LOCAL ("new Date(anio, mes, dia)"), nunca ISO string — ver
// el comentario en iess.test.ts sobre por qué.
describe("calcularDiasVacacionesPorAntiguedad", () => {
  it("menos de 5 años -> 15 días base", () => {
    const ingreso = new Date(2024, 0, 15);
    const hoy = new Date(2026, 5, 1);
    expect(calcularDiasVacacionesPorAntiguedad(ingreso, hoy)).toBe(15);
  });

  it("exactamente 5 años -> todavía 15 días (los adicionales empiezan DESPUÉS del 5to)", () => {
    const ingreso = new Date(2021, 0, 15);
    const hoy = new Date(2026, 1, 1);
    expect(calcularDiasVacacionesPorAntiguedad(ingreso, hoy)).toBe(15);
  });

  it("7 años completos -> 15 + 2 días adicionales", () => {
    const ingreso = new Date(2019, 0, 15);
    const hoy = new Date(2026, 1, 1);
    expect(calcularDiasVacacionesPorAntiguedad(ingreso, hoy)).toBe(17);
  });
});

describe("calcularValorVacaciones", () => {
  it("sueldo de 600, 15 días -> $375.00", () => {
    expect(calcularValorVacaciones(decimal(600), 15).toFixed(2)).toBe("375.00");
  });

  it("0 días no genera valor", () => {
    expect(calcularValorVacaciones(decimal(600), 0).toFixed(2)).toBe("0.00");
  });
});
