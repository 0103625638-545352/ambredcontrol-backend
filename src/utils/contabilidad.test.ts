import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  CUENTAS,
  lineasPorVenta,
  lineasPorNotaCredito,
  lineasPorCompra,
  lineasPorDevolucionCompra,
  lineasPorPago,
  lineasPorMovimientoCaja,
  lineasPorCostoVenta,
  lineasPorNomina,
  validarAsientoCuadrado,
} from "./contabilidad";

function decimal(valor: number) {
  return new Prisma.Decimal(valor);
}

function buscar(lineas: ReturnType<typeof lineasPorVenta>, cuentaCodigo: string) {
  return lineas.find((l) => l.cuentaCodigo === cuentaCodigo);
}

describe("lineasPorVenta", () => {
  it("con IVA: cuadra y separa ventas gravadas de IVA por pagar", () => {
    const lineas = lineasPorVenta({ subtotal0: decimal(0), subtotal12: decimal(100), iva: decimal(15), total: decimal(115) });
    expect(buscar(lineas, CUENTAS.CUENTAS_POR_COBRAR)?.debe.toFixed(2)).toBe("115.00");
    expect(buscar(lineas, CUENTAS.VENTAS)?.haber.toFixed(2)).toBe("100.00");
    expect(buscar(lineas, CUENTAS.IVA_VENTAS_POR_PAGAR)?.haber.toFixed(2)).toBe("15.00");
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });

  it("sin IVA (ej. NotaVenta con aplicaIva=false): no genera línea de IVA y sigue cuadrando", () => {
    const lineas = lineasPorVenta({ subtotal0: decimal(50), subtotal12: decimal(0), iva: decimal(0), total: decimal(50) });
    expect(buscar(lineas, CUENTAS.IVA_VENTAS_POR_PAGAR)).toBeUndefined();
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });
});

describe("lineasPorNotaCredito", () => {
  it("es el reverso exacto de lineasPorVenta y cuadra", () => {
    const lineas = lineasPorNotaCredito({ subtotal0: decimal(0), subtotal12: decimal(100), iva: decimal(15) });
    expect(buscar(lineas, CUENTAS.DEVOLUCIONES_VENTAS)?.debe.toFixed(2)).toBe("100.00");
    expect(buscar(lineas, CUENTAS.IVA_VENTAS_POR_PAGAR)?.debe.toFixed(2)).toBe("15.00");
    expect(buscar(lineas, CUENTAS.CUENTAS_POR_COBRAR)?.haber.toFixed(2)).toBe("115.00");
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });
});

describe("lineasPorCompra", () => {
  it("con IVA: genera crédito tributario y cuadra", () => {
    const lineas = lineasPorCompra({ subtotal0: decimal(0), subtotal12: decimal(200), iva: decimal(30), total: decimal(230) });
    expect(buscar(lineas, CUENTAS.INVENTARIO)?.debe.toFixed(2)).toBe("200.00");
    expect(buscar(lineas, CUENTAS.CREDITO_TRIBUTARIO_IVA_COMPRAS)?.debe.toFixed(2)).toBe("30.00");
    expect(buscar(lineas, CUENTAS.CUENTAS_POR_PAGAR)?.haber.toFixed(2)).toBe("230.00");
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });
});

describe("lineasPorDevolucionCompra", () => {
  it("es el reverso exacto de lineasPorCompra y cuadra", () => {
    const lineas = lineasPorDevolucionCompra({ subtotal0: decimal(0), subtotal12: decimal(200), iva: decimal(30) });
    expect(buscar(lineas, CUENTAS.CUENTAS_POR_PAGAR)?.debe.toFixed(2)).toBe("230.00");
    expect(buscar(lineas, CUENTAS.CREDITO_TRIBUTARIO_IVA_COMPRAS)?.haber.toFixed(2)).toBe("30.00");
    expect(buscar(lineas, CUENTAS.INVENTARIO)?.haber.toFixed(2)).toBe("200.00");
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });

  it("sin IVA: no genera línea de crédito tributario y sigue cuadrando", () => {
    const lineas = lineasPorDevolucionCompra({ subtotal0: decimal(50), subtotal12: decimal(0), iva: decimal(0) });
    expect(buscar(lineas, CUENTAS.CREDITO_TRIBUTARIO_IVA_COMPRAS)).toBeUndefined();
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });
});

describe("lineasPorPago", () => {
  it("cobro en efectivo: Debe Caja / Haber Cuentas por Cobrar", () => {
    const lineas = lineasPorPago({ monto: decimal(50), formaPago: "EFECTIVO", tipoDocumento: "COBRO" });
    expect(buscar(lineas, CUENTAS.CAJA)?.debe.toFixed(2)).toBe("50.00");
    expect(buscar(lineas, CUENTAS.CUENTAS_POR_COBRAR)?.haber.toFixed(2)).toBe("50.00");
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });

  it("cobro por transferencia: va a Bancos, no a Caja", () => {
    const lineas = lineasPorPago({ monto: decimal(50), formaPago: "TRANSFERENCIA", tipoDocumento: "COBRO" });
    expect(buscar(lineas, CUENTAS.BANCOS)?.debe.toFixed(2)).toBe("50.00");
    expect(buscar(lineas, CUENTAS.CAJA)).toBeUndefined();
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });

  it("cobro por retención repartido entre IVA y Renta por cobrar", () => {
    const lineas = lineasPorPago({
      monto: decimal(38.75),
      formaPago: "RETENCION",
      tipoDocumento: "COBRO",
      totalIvaRetencion: decimal(30),
      totalRentaRetencion: decimal(8.75),
    });
    expect(buscar(lineas, CUENTAS.RETENCIONES_IVA_POR_COBRAR)?.debe.toFixed(2)).toBe("30.00");
    expect(buscar(lineas, CUENTAS.RETENCIONES_RENTA_POR_COBRAR)?.debe.toFixed(2)).toBe("8.75");
    expect(buscar(lineas, CUENTAS.CUENTAS_POR_COBRAR)?.haber.toFixed(2)).toBe("38.75");
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });

  it("pago a proveedor en efectivo: Debe Cuentas por Pagar / Haber Caja", () => {
    const lineas = lineasPorPago({ monto: decimal(75), formaPago: "EFECTIVO", tipoDocumento: "PAGO_PROVEEDOR" });
    expect(buscar(lineas, CUENTAS.CUENTAS_POR_PAGAR)?.debe.toFixed(2)).toBe("75.00");
    expect(buscar(lineas, CUENTAS.CAJA)?.haber.toFixed(2)).toBe("75.00");
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });

  it("pago a proveedor por retención repartido entre IVA y Renta por pagar", () => {
    const lineas = lineasPorPago({
      monto: decimal(42),
      formaPago: "RETENCION",
      tipoDocumento: "PAGO_PROVEEDOR",
      totalIvaRetencion: decimal(30),
      totalRentaRetencion: decimal(12),
    });
    expect(buscar(lineas, CUENTAS.RETENCIONES_IVA_POR_PAGAR)?.haber.toFixed(2)).toBe("30.00");
    expect(buscar(lineas, CUENTAS.RETENCIONES_RENTA_POR_PAGAR)?.haber.toFixed(2)).toBe("12.00");
    expect(buscar(lineas, CUENTAS.CUENTAS_POR_PAGAR)?.debe.toFixed(2)).toBe("42.00");
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });
});

describe("lineasPorMovimientoCaja", () => {
  it("ingreso: Debe Caja / Haber Otros Ingresos", () => {
    const lineas = lineasPorMovimientoCaja({ tipo: "INGRESO", monto: decimal(20) });
    expect(buscar(lineas, CUENTAS.CAJA)?.debe.toFixed(2)).toBe("20.00");
    expect(buscar(lineas, CUENTAS.OTROS_INGRESOS)?.haber.toFixed(2)).toBe("20.00");
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });

  it("egreso: Debe Gastos Operativos / Haber Caja", () => {
    const lineas = lineasPorMovimientoCaja({ tipo: "EGRESO", monto: decimal(15) });
    expect(buscar(lineas, CUENTAS.GASTOS_OPERATIVOS)?.debe.toFixed(2)).toBe("15.00");
    expect(buscar(lineas, CUENTAS.CAJA)?.haber.toFixed(2)).toBe("15.00");
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });
});

describe("lineasPorCostoVenta", () => {
  it("Debe Costo de Ventas / Haber Inventario, y cuadra", () => {
    const lineas = lineasPorCostoVenta(decimal(60));
    expect(buscar(lineas, CUENTAS.COSTO_VENTAS)?.debe.toFixed(2)).toBe("60.00");
    expect(buscar(lineas, CUENTAS.INVENTARIO)?.haber.toFixed(2)).toBe("60.00");
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });

  it("costo 0: no genera ninguna línea (nada que postear)", () => {
    expect(lineasPorCostoVenta(decimal(0))).toEqual([]);
  });

  it("concatenado con lineasPorVenta en el mismo asiento, sigue cuadrando", () => {
    const lineas = [
      ...lineasPorVenta({ subtotal0: decimal(0), subtotal12: decimal(100), iva: decimal(15), total: decimal(115) }),
      ...lineasPorCostoVenta(decimal(60)),
    ];
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });
});

describe("validarAsientoCuadrado", () => {
  it("false si debe y haber no coinciden", () => {
    const lineas = [
      { cuentaCodigo: CUENTAS.CAJA, debe: decimal(100), haber: decimal(0) },
      { cuentaCodigo: CUENTAS.VENTAS, debe: decimal(0), haber: decimal(90) },
    ];
    expect(validarAsientoCuadrado(lineas)).toBe(false);
  });
});

describe("lineasPorNomina", () => {
  it("cuadra y separa gasto de sueldos, aporte patronal, IESS por pagar y neto a bancos", () => {
    const lineas = lineasPorNomina({
      sueldoBase: decimal(500),
      valorHorasSuplementarias: decimal(0),
      valorHorasExtraordinarias: decimal(0),
      otrosIngresos: decimal(0),
      fondoReservaValor: decimal(0),
      aportePersonalIess: decimal(47.25), // 9.45% de 500
      aportePatronalIess: decimal(55.75), // 11.15% de 500
      otrosDescuentos: decimal(0),
      netoAPagar: decimal(452.75), // 500 - 47.25
      formaPago: "OTRO",
    });
    expect(buscar(lineas, CUENTAS.GASTO_SUELDOS)?.debe.toFixed(2)).toBe("500.00");
    expect(buscar(lineas, CUENTAS.GASTO_APORTE_PATRONAL_IESS)?.debe.toFixed(2)).toBe("55.75");
    expect(buscar(lineas, CUENTAS.IESS_POR_PAGAR)?.haber.toFixed(2)).toBe("103.00"); // 47.25 + 55.75
    expect(buscar(lineas, CUENTAS.BANCOS)?.haber.toFixed(2)).toBe("452.75");
    expect(buscar(lineas, CUENTAS.OTROS_DESCUENTOS_EMPLEADOS)).toBeUndefined();
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });

  it("con otros descuentos (anticipo) y pago en efectivo: sigue cuadrando", () => {
    const lineas = lineasPorNomina({
      sueldoBase: decimal(500),
      valorHorasSuplementarias: decimal(10),
      valorHorasExtraordinarias: decimal(0),
      otrosIngresos: decimal(0),
      fondoReservaValor: decimal(0),
      aportePersonalIess: decimal(48.19),
      aportePatronalIess: decimal(56.87),
      otrosDescuentos: decimal(50),
      netoAPagar: decimal(411.81), // 510 - 48.19 - 50
      formaPago: "EFECTIVO",
    });
    expect(buscar(lineas, CUENTAS.OTROS_DESCUENTOS_EMPLEADOS)?.haber.toFixed(2)).toBe("50.00");
    expect(buscar(lineas, CUENTAS.CAJA)?.haber.toFixed(2)).toBe("411.81");
    expect(validarAsientoCuadrado(lineas)).toBe(true);
  });
});
