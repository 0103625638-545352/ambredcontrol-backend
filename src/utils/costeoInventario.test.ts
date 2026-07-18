import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { actualizarCostoPromedio } from "./costeoInventario";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

describe("actualizarCostoPromedio", () => {
  it("primera compra (sin costo previo, stock previo 0): el promedio es el costo de la compra", () => {
    const resultado = actualizarCostoPromedio(0, null, 10, decimal(5));
    expect(resultado.toNumber()).toBe(5);
  });

  it("segunda compra a costo distinto: promedio ponderado correcto", () => {
    // 10 unidades a $5 (promedio actual) + 5 unidades nuevas a $8
    // = (10*5 + 5*8) / 15 = 90/15 = 6
    const resultado = actualizarCostoPromedio(10, decimal(5), 5, decimal(8));
    expect(resultado.toNumber()).toBe(6);
  });

  it("devolución a proveedor que no vacía el stock: descuenta al costo original de esa línea", () => {
    // 15 unidades a $6 (promedio), se devuelven 5 a su costo original de $8
    // = (15*6 - 5*8) / 10 = (90-40)/10 = 5
    const resultado = actualizarCostoPromedio(15, decimal(6), -5, decimal(8));
    expect(resultado.toNumber()).toBe(5);
  });

  it("devolución que deja el stock en 0: no divide por cero, devuelve 0", () => {
    const resultado = actualizarCostoPromedio(5, decimal(6), -5, decimal(6));
    expect(resultado.toNumber()).toBe(0);
  });

  it("anulación de compra completa (mismo criterio que una devolución a costo conocido)", () => {
    // Único ingreso de 10 unidades a $5; se anula por completo -> vuelve a 0
    const resultado = actualizarCostoPromedio(10, decimal(5), -10, decimal(5));
    expect(resultado.toNumber()).toBe(0);
  });
});
