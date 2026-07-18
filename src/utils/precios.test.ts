import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { precioParaCliente } from "./precios";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

describe("precioParaCliente", () => {
  it("sin costo conocido (nunca se compró): null, no se puede vender", () => {
    const producto = { costoPromedioActual: null };
    const cliente = { tipoPrecio: { porcentajeGanancia: decimal(15) } };
    expect(precioParaCliente(producto, cliente)).toBeNull();
  });

  it("costo 1000, categoría 10%: precio 1100", () => {
    const producto = { costoPromedioActual: decimal(1000) };
    const cliente = { tipoPrecio: { porcentajeGanancia: decimal(10) } };
    expect(precioParaCliente(producto, cliente)?.toFixed(2)).toBe("1100.00");
  });

  it("mismo producto, categorías distintas: precios distintos", () => {
    const producto = { costoPromedioActual: decimal(100) };
    const mayorista = precioParaCliente(producto, { tipoPrecio: { porcentajeGanancia: decimal(10) } });
    const consumidorFinal = precioParaCliente(producto, { tipoPrecio: { porcentajeGanancia: decimal(25) } });
    expect(mayorista?.toFixed(2)).toBe("110.00");
    expect(consumidorFinal?.toFixed(2)).toBe("125.00");
  });

  it("categoría 0%: precio igual al costo", () => {
    const producto = { costoPromedioActual: decimal(500) };
    const cliente = { tipoPrecio: { porcentajeGanancia: decimal(0) } };
    expect(precioParaCliente(producto, cliente)?.toFixed(2)).toBe("500.00");
  });
});
