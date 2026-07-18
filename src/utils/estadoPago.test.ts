import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { calcularEstadoPago } from "./estadoPago";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

describe("calcularEstadoPago", () => {
  it("es PENDIENTE cuando no se ha pagado nada", () => {
    expect(calcularEstadoPago(decimal(0), decimal(100))).toBe("PENDIENTE");
  });

  it("es PARCIAL cuando se pagó una parte", () => {
    expect(calcularEstadoPago(decimal(50), decimal(100))).toBe("PARCIAL");
  });

  it("es PAGADA cuando se pagó exactamente el total", () => {
    expect(calcularEstadoPago(decimal(100), decimal(100))).toBe("PAGADA");
  });

  it("es PAGADA cuando se pagó de más (no debería pasar, pero no debe romperse)", () => {
    expect(calcularEstadoPago(decimal(150), decimal(100))).toBe("PAGADA");
  });
});
