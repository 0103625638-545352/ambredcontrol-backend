import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { calcularEfectivoEsperado, calcularDiferenciaCierre } from "./caja";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

describe("calcularEfectivoEsperado", () => {
  it("es igual al monto inicial cuando no hubo ningún movimiento", () => {
    const esperado = calcularEfectivoEsperado({
      montoInicial: decimal(20),
      ventasEfectivo: decimal(0),
      ingresosManuales: decimal(0),
      comprasEfectivo: decimal(0),
      egresosManuales: decimal(0),
    });
    expect(esperado.toFixed(2)).toBe("20.00");
  });

  it("suma las ventas en efectivo", () => {
    const esperado = calcularEfectivoEsperado({
      montoInicial: decimal(20),
      ventasEfectivo: decimal(150.5),
      ingresosManuales: decimal(0),
      comprasEfectivo: decimal(0),
      egresosManuales: decimal(0),
    });
    expect(esperado.toFixed(2)).toBe("170.50");
  });

  it("resta las compras pagadas en efectivo", () => {
    const esperado = calcularEfectivoEsperado({
      montoInicial: decimal(100),
      ventasEfectivo: decimal(0),
      ingresosManuales: decimal(0),
      comprasEfectivo: decimal(30),
      egresosManuales: decimal(0),
    });
    expect(esperado.toFixed(2)).toBe("70.00");
  });

  it("combina ingresos y egresos manuales", () => {
    const esperado = calcularEfectivoEsperado({
      montoInicial: decimal(20),
      ventasEfectivo: decimal(0),
      ingresosManuales: decimal(50),
      comprasEfectivo: decimal(0),
      egresosManuales: decimal(10),
    });
    expect(esperado.toFixed(2)).toBe("60.00");
  });

  it("combina todos los componentes a la vez", () => {
    const esperado = calcularEfectivoEsperado({
      montoInicial: decimal(20),
      ventasEfectivo: decimal(200),
      ingresosManuales: decimal(50),
      comprasEfectivo: decimal(30),
      egresosManuales: decimal(10),
    });
    expect(esperado.toFixed(2)).toBe("230.00");
  });
});

describe("calcularDiferenciaCierre", () => {
  it("es cero cuando lo contado coincide exactamente con lo esperado", () => {
    expect(calcularDiferenciaCierre(decimal(100), decimal(100)).toFixed(2)).toBe("0.00");
  });

  it("es positiva (sobrante) cuando lo contado es mayor a lo esperado", () => {
    expect(calcularDiferenciaCierre(decimal(105), decimal(100)).toFixed(2)).toBe("5.00");
  });

  it("es negativa (faltante) cuando lo contado es menor a lo esperado", () => {
    expect(calcularDiferenciaCierre(decimal(95), decimal(100)).toFixed(2)).toBe("-5.00");
  });
});
