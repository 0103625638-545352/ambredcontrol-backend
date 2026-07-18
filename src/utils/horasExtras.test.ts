import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { calcularValorHoraOrdinaria, calcularValorHorasSuplementarias, calcularValorHorasExtraordinarias } from "./horasExtras";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

describe("calcularValorHoraOrdinaria", () => {
  it("sueldo de 600 -> hora ordinaria de 2.50 (ejemplo oficial)", () => {
    expect(calcularValorHoraOrdinaria(decimal(600)).toFixed(2)).toBe("2.50");
  });
});

describe("calcularValorHorasSuplementarias", () => {
  it("2 horas suplementarias con sueldo de 600 -> $7.50 (ejemplo oficial)", () => {
    expect(calcularValorHorasSuplementarias(decimal(600), 2).toFixed(2)).toBe("7.50");
  });

  it("0 horas no genera valor", () => {
    expect(calcularValorHorasSuplementarias(decimal(600), 0).toFixed(2)).toBe("0.00");
  });
});

describe("calcularValorHorasExtraordinarias", () => {
  it("2 horas extraordinarias con sueldo de 600 -> hora ordinaria x2 x2 horas = $10.00", () => {
    expect(calcularValorHorasExtraordinarias(decimal(600), 2).toFixed(2)).toBe("10.00");
  });
});
