import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { calcularValorRetenido, calcularTotalesRetencion } from "./retenciones";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

describe("calcularValorRetenido", () => {
  it("calcula el 30% de retención de IVA sobre una base de 100", () => {
    expect(calcularValorRetenido(decimal(100), decimal(30)).toFixed(2)).toBe("30.00");
  });

  it("calcula un porcentaje de renta con decimales (1.75%)", () => {
    expect(calcularValorRetenido(decimal(500), decimal(1.75)).toFixed(2)).toBe("8.75");
  });

  it("es cero si el porcentaje es cero", () => {
    expect(calcularValorRetenido(decimal(200), decimal(0)).toFixed(2)).toBe("0.00");
  });

  it("es igual a la base si el porcentaje es 100 (retención total de IVA)", () => {
    expect(calcularValorRetenido(decimal(80), decimal(100)).toFixed(2)).toBe("80.00");
  });
});

describe("calcularTotalesRetencion", () => {
  it("separa correctamente IVA y RENTA y suma el total", () => {
    const lineas = [
      { tipoImpuesto: "IVA" as const, valorRetenido: decimal(30) },
      { tipoImpuesto: "IVA" as const, valorRetenido: decimal(12) },
      { tipoImpuesto: "RENTA" as const, valorRetenido: decimal(8.75) },
    ];
    const totales = calcularTotalesRetencion(lineas);
    expect(totales.totalIva.toFixed(2)).toBe("42.00");
    expect(totales.totalRenta.toFixed(2)).toBe("8.75");
    expect(totales.total.toFixed(2)).toBe("50.75");
  });

  it("da cero en todo si no hay líneas", () => {
    const totales = calcularTotalesRetencion([]);
    expect(totales.totalIva.toFixed(2)).toBe("0.00");
    expect(totales.totalRenta.toFixed(2)).toBe("0.00");
    expect(totales.total.toFixed(2)).toBe("0.00");
  });
});
