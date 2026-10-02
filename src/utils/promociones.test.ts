import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { promocionAplicable, montoDescuentoPromocion, type PromocionCandidata } from "./promociones";

const HOY = new Date(2026, 9, 15); // 15 de octubre de 2026

function promo(datos: Partial<PromocionCandidata> & { id: number }): PromocionCandidata {
  return {
    nombre: `Promo ${datos.id}`,
    porcentajeDescuento: new Prisma.Decimal(50),
    alcance: "TODOS_LOS_CLIENTES",
    mesesDesdeContrato: null,
    planInternetId: null,
    ...datos,
  };
}

describe("promocionAplicable", () => {
  it("devuelve null si no hay ninguna promoción candidata", () => {
    expect(promocionAplicable([], { fechaContrato: null }, 1, HOY)).toBeNull();
  });

  it("aplica una promoción TODOS_LOS_CLIENTES sin importar la antigüedad del cliente", () => {
    const p = promo({ id: 1 });
    expect(promocionAplicable([p], { fechaContrato: null }, 1, HOY)?.id).toBe(1);
  });

  it("aplica CLIENTES_NUEVOS dentro de la ventana de meses desde el contrato", () => {
    const p = promo({ id: 2, alcance: "CLIENTES_NUEVOS", mesesDesdeContrato: 3 });
    const fechaContrato = new Date(2026, 8, 1); // 1 mes antes de HOY (sep -> oct)
    expect(promocionAplicable([p], { fechaContrato }, 1, HOY)?.id).toBe(2);
  });

  it("NO aplica CLIENTES_NUEVOS una vez pasados los meses de vigencia", () => {
    const p = promo({ id: 2, alcance: "CLIENTES_NUEVOS", mesesDesdeContrato: 3 });
    const fechaContrato = new Date(2026, 4, 1); // 5 meses antes de HOY
    expect(promocionAplicable([p], { fechaContrato }, 1, HOY)).toBeNull();
  });

  it("NO aplica CLIENTES_NUEVOS si el cliente no tiene fechaContrato cargada", () => {
    const p = promo({ id: 2, alcance: "CLIENTES_NUEVOS", mesesDesdeContrato: 3 });
    expect(promocionAplicable([p], { fechaContrato: null }, 1, HOY)).toBeNull();
  });

  it("ignora una promoción atada a OTRO plan de internet", () => {
    const p = promo({ id: 3, planInternetId: 99 });
    expect(promocionAplicable([p], { fechaContrato: null }, 1, HOY)).toBeNull();
  });

  it("prioriza la promoción atada a un plan específico sobre una general, aunque la general tenga mayor %", () => {
    const general = promo({ id: 1, porcentajeDescuento: new Prisma.Decimal(80) });
    const especifica = promo({ id: 2, planInternetId: 1, porcentajeDescuento: new Prisma.Decimal(30) });
    expect(promocionAplicable([general, especifica], { fechaContrato: null }, 1, HOY)?.id).toBe(2);
  });

  it("entre dos promociones igual de específicas, gana la de mayor % de descuento", () => {
    const menor = promo({ id: 1, porcentajeDescuento: new Prisma.Decimal(20) });
    const mayor = promo({ id: 2, porcentajeDescuento: new Prisma.Decimal(50) });
    expect(promocionAplicable([menor, mayor], { fechaContrato: null }, 1, HOY)?.id).toBe(2);
  });
});

describe("montoDescuentoPromocion", () => {
  it("calcula el monto absoluto a partir del % sobre el precio base", () => {
    const p = promo({ id: 1, porcentajeDescuento: new Prisma.Decimal(50) });
    expect(montoDescuentoPromocion(new Prisma.Decimal(20), p).toNumber()).toBe(10);
  });

  it("redondea a 2 decimales", () => {
    const p = promo({ id: 1, porcentajeDescuento: new Prisma.Decimal(33.33) });
    expect(montoDescuentoPromocion(new Prisma.Decimal(10), p).toNumber()).toBe(3.33);
  });
});
