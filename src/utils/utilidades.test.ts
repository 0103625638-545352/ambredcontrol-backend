import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { calcularDiasTrabajadosEnAnio, calcularMonto15Porciento, repartirUtilidades } from "./utilidades";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

// Fechas en HORA LOCAL ("new Date(anio, mes, dia)"), nunca ISO string — ver
// el comentario en iess.test.ts sobre por qué.
describe("calcularDiasTrabajadosEnAnio", () => {
  it("empleado que trabajó todo el año -> 365 días", () => {
    expect(calcularDiasTrabajadosEnAnio(new Date(2020, 0, 1), null, 2026)).toBe(365);
  });

  it("empleado que ingresó a mitad de año -> menos días", () => {
    const dias = calcularDiasTrabajadosEnAnio(new Date(2026, 6, 1), null, 2026);
    expect(dias).toBeLessThan(365);
    expect(dias).toBeGreaterThan(0);
  });

  it("empleado que salió antes de fin de año -> se recorta", () => {
    const dias = calcularDiasTrabajadosEnAnio(new Date(2020, 0, 1), new Date(2026, 5, 30), 2026);
    expect(dias).toBe(181);
  });

  it("empleado que ingresó después del año consultado -> 0 días", () => {
    expect(calcularDiasTrabajadosEnAnio(new Date(2027, 0, 1), null, 2026)).toBe(0);
  });
});

describe("calcularMonto15Porciento", () => {
  it("utilidad neta de 10000 -> $1500.00", () => {
    expect(calcularMonto15Porciento(decimal(10000)).toFixed(2)).toBe("1500.00");
  });
});

describe("repartirUtilidades", () => {
  it("reparte 10% por días + 5% por cargas, y todo suma exactamente el 15%", () => {
    const utilidadNeta = decimal(10000);
    const empleados = [
      { empleadoId: 1, diasTrabajados: 365, cargasFamiliares: 2 },
      { empleadoId: 2, diasTrabajados: 180, cargasFamiliares: 0 },
    ];
    const reparto = repartirUtilidades(utilidadNeta, empleados);

    const totalRepartido = reparto.reduce((acc, r) => acc.add(r.totalEmpleado), new Prisma.Decimal(0));
    expect(totalRepartido.toFixed(2)).toBe(calcularMonto15Porciento(utilidadNeta).toFixed(2));

    // El empleado 1 tiene más días y todas las cargas -> le toca más de ambas bolsas
    expect(reparto[0].valorPorDias.gt(reparto[1].valorPorDias)).toBe(true);
    expect(reparto[0].valorPorCargas.toFixed(2)).toBe("500.00"); // 5% de 10000 = 500, todo para el único con cargas
    expect(reparto[1].valorPorCargas.toFixed(2)).toBe("0.00");
  });

  it("si nadie tiene cargas familiares, el 5% no se reparte a nadie", () => {
    const reparto = repartirUtilidades(decimal(10000), [
      { empleadoId: 1, diasTrabajados: 100, cargasFamiliares: 0 },
      { empleadoId: 2, diasTrabajados: 100, cargasFamiliares: 0 },
    ]);
    expect(reparto[0].valorPorCargas.toFixed(2)).toBe("0.00");
    expect(reparto[1].valorPorCargas.toFixed(2)).toBe("0.00");
  });
});
