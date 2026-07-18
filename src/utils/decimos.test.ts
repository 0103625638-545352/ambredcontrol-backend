import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { calcularDecimoTercero, calcularDecimoCuarto, calcularMesesLaboradosEnRango, rangoDecimoCuarto, SBU_VIGENTE } from "./decimos";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

// Todas las fechas de este archivo se comparan en HORA LOCAL (getFullYear/
// getMonth/getDate) — nunca .toISOString() (UTC): las funciones bajo prueba
// construyen fechas con "new Date(anio, mes, dia)" (local), y este server
// corre en un huso horario detrás de UTC (Ecuador, UTC-5) — comparar en UTC
// mostraría el día anterior, mismo tipo de bug ya encontrado y corregido
// antes en este proyecto (ver utils/rangoFechas.ts).
function fechaLocalYMD(fecha: Date): string {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

describe("calcularDecimoTercero", () => {
  it("total percibido de 7200 en el período -> $600", () => {
    expect(calcularDecimoTercero(decimal(7200)).toFixed(2)).toBe("600.00");
  });
});

describe("calcularDecimoCuarto", () => {
  it("12 meses laborados -> 1 SBU completo", () => {
    expect(calcularDecimoCuarto(SBU_VIGENTE, 12).toFixed(2)).toBe("482.00");
  });

  it("6 meses laborados -> proporcional a la mitad", () => {
    expect(calcularDecimoCuarto(SBU_VIGENTE, 6).toFixed(2)).toBe("241.00");
  });

  it("nunca supera 12 meses aunque se pase el dato", () => {
    expect(calcularDecimoCuarto(SBU_VIGENTE, 15).toFixed(2)).toBe("482.00");
  });

  it("meses negativos no generan valor negativo", () => {
    expect(calcularDecimoCuarto(SBU_VIGENTE, -3).toFixed(2)).toBe("0.00");
  });
});

describe("rangoDecimoCuarto", () => {
  it("Sierra/Oriente: 1-ago del año anterior a 31-jul del año consultado", () => {
    const { desde, hasta } = rangoDecimoCuarto(2026, "SIERRA_ORIENTE");
    expect(fechaLocalYMD(desde)).toBe("2025-08-01");
    expect(fechaLocalYMD(hasta)).toBe("2026-07-31");
  });

  it("Costa/Galápagos: 1-mar del año anterior a 28-feb (año no bisiesto)", () => {
    const { desde, hasta } = rangoDecimoCuarto(2026, "COSTA_GALAPAGOS");
    expect(fechaLocalYMD(desde)).toBe("2025-03-01");
    expect(fechaLocalYMD(hasta)).toBe("2026-02-28");
  });

  it("Costa/Galápagos en año bisiesto: llega hasta 29-feb", () => {
    const { hasta } = rangoDecimoCuarto(2028, "COSTA_GALAPAGOS");
    expect(fechaLocalYMD(hasta)).toBe("2028-02-29");
  });
});

describe("calcularMesesLaboradosEnRango", () => {
  it("empleado que trabajó todo el período -> 12 meses", () => {
    const { desde, hasta } = rangoDecimoCuarto(2026, "SIERRA_ORIENTE");
    expect(calcularMesesLaboradosEnRango(new Date(2020, 0, 1), null, desde, hasta)).toBe(12);
  });

  it("empleado que ingresó a mitad del período -> proporcional", () => {
    const { desde, hasta } = rangoDecimoCuarto(2026, "SIERRA_ORIENTE");
    // feb, mar, abr, may, jun, jul = 6 meses (conteo inclusivo)
    expect(calcularMesesLaboradosEnRango(new Date(2026, 1, 1), null, desde, hasta)).toBe(6);
  });

  it("empleado que ingresó después del período -> 0 meses", () => {
    const { desde, hasta } = rangoDecimoCuarto(2026, "SIERRA_ORIENTE");
    expect(calcularMesesLaboradosEnRango(new Date(2026, 7, 1), null, desde, hasta)).toBe(0);
  });
});
