import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { calcularIndemnizacionDespidoIntempestivo, calcularBonificacionDesahucio } from "./liquidacion";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

describe("calcularIndemnizacionDespidoIntempestivo", () => {
  it("hasta 3 años de servicio -> 3 remuneraciones fijas", () => {
    expect(calcularIndemnizacionDespidoIntempestivo(decimal(500), 2).toFixed(2)).toBe("1500.00");
    expect(calcularIndemnizacionDespidoIntempestivo(decimal(500), 3).toFixed(2)).toBe("1500.00");
  });

  it("más de 3 años -> 1 remuneración por cada año completo", () => {
    expect(calcularIndemnizacionDespidoIntempestivo(decimal(500), 5).toFixed(2)).toBe("2500.00");
  });
});

describe("calcularBonificacionDesahucio", () => {
  it("25% de 1 sueldo por cada año completo de servicio", () => {
    expect(calcularBonificacionDesahucio(decimal(500), 4).toFixed(2)).toBe("500.00");
  });
});
