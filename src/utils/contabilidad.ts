// Generadores de líneas de asiento contable (partida doble) para cada
// documento del sistema. Funciones puras, sin acceso a base de datos —
// reciben los montos ya calculados por la ruta que los llama y devuelven
// las líneas [cuentaCodigo, debe, haber] que utils/asientos.ts persiste.
// Testeadas aparte (ver contabilidad.test.ts), mismo criterio que
// utils/retenciones.ts / utils/caja.ts.
//
// El costo de ventas SÍ se postea automáticamente por venta (ver
// lineasPorCostoVenta) — usa el mismo costoPromedioActual por producto que
// ya mantiene utils/costeoInventario.ts para el reporte de rentabilidad, así
// que no hace falta un ajuste manual aparte a fin de período.

import { Prisma } from "@prisma/client";

// Códigos del plan de cuentas sembrado en la migración
// 20260712190559_sembrar_plan_cuentas. Referenciados por código (no por id)
// porque el id depende de cada base de datos — con multi-tenancy, cada
// empresa tiene su propia fila para el mismo código.
export const CUENTAS = {
  CAJA: "1.1.01",
  BANCOS: "1.1.02",
  CUENTAS_POR_COBRAR: "1.1.03",
  CREDITO_TRIBUTARIO_IVA_COMPRAS: "1.1.04",
  RETENCIONES_IVA_POR_COBRAR: "1.1.05",
  INVENTARIO: "1.1.06",
  RETENCIONES_RENTA_POR_COBRAR: "1.1.07",
  CUENTAS_POR_PAGAR: "2.1.01",
  IVA_VENTAS_POR_PAGAR: "2.1.02",
  RETENCIONES_IVA_POR_PAGAR: "2.1.03",
  RETENCIONES_RENTA_POR_PAGAR: "2.1.04",
  CAPITAL_SOCIAL: "3.1.01",
  UTILIDAD_PERDIDA_EJERCICIO: "3.1.02",
  VENTAS: "4.1.01",
  DEVOLUCIONES_VENTAS: "4.1.02",
  OTROS_INGRESOS: "4.1.03",
  COSTO_VENTAS: "5.1.01",
  GASTOS_OPERATIVOS: "6.1.01",
  // Nuevas para Nómina — a diferencia del resto (sembradas en la migración
  // 20260712190559), estas NO se siembran automáticamente: el plan de
  // cuentas es dato de negocio editable, no estructura, así que cada
  // empresa las crea una sola vez desde Contabilidad > Plan de Cuentas
  // antes de usar "Pagar" en un rol de pagos (si faltan, crearAsiento ya
  // lanza CUENTA_CONTABLE_NO_ENCONTRADA:<codigo> con un mensaje claro).
  GASTO_SUELDOS: "6.1.02",
  GASTO_APORTE_PATRONAL_IESS: "6.1.03",
  IESS_POR_PAGAR: "2.1.05",
  OTROS_DESCUENTOS_EMPLEADOS: "2.1.06",
} as const;

export interface LineaAsientoInput {
  cuentaCodigo: string;
  debe: Prisma.Decimal;
  haber: Prisma.Decimal;
  glosa?: string;
}

const CERO = new Prisma.Decimal(0);

function linea(cuentaCodigo: string, debe: Prisma.Decimal, haber: Prisma.Decimal, glosa?: string): LineaAsientoInput {
  return { cuentaCodigo, debe, haber, glosa };
}

interface MontosVenta {
  subtotal0: Prisma.Decimal;
  subtotal12: Prisma.Decimal;
  iva: Prisma.Decimal;
  total: Prisma.Decimal;
}

// Factura y NotaVenta comparten esta misma función: cuando una NotaVenta no
// aplica IVA, la ruta que la crea ya fuerza iva=0, así que no hace falta
// lógica especial acá.
export function lineasPorVenta({ subtotal0, subtotal12, iva, total }: MontosVenta): LineaAsientoInput[] {
  const lineas: LineaAsientoInput[] = [
    linea(CUENTAS.CUENTAS_POR_COBRAR, total, CERO),
    linea(CUENTAS.VENTAS, CERO, subtotal0.add(subtotal12)),
  ];
  if (iva.gt(0)) lineas.push(linea(CUENTAS.IVA_VENTAS_POR_PAGAR, CERO, iva));
  return lineas;
}

// Se concatena a lineasPorVenta EN EL MISMO asiento (ver facturas.ts /
// notasVenta.ts) — dos grupos de líneas que cuadran cada uno por separado
// siguen cuadrando al concatenarse, así que un solo asiento por venta cubre
// tanto el ingreso (CxC/Ventas/IVA) como su costo (Costo de Ventas/Inventario).
// costoTotal = suma de (cantidad × costoPromedioActual) de cada línea vendida,
// ya calculada por quien llama (el producto no puede venderse sin costo
// registrado, así que nunca llega null/undefined acá).
export function lineasPorCostoVenta(costoTotal: Prisma.Decimal): LineaAsientoInput[] {
  if (costoTotal.lte(0)) return [];
  return [linea(CUENTAS.COSTO_VENTAS, costoTotal, CERO), linea(CUENTAS.INVENTARIO, CERO, costoTotal)];
}

interface MontosNotaCredito {
  subtotal0: Prisma.Decimal;
  subtotal12: Prisma.Decimal;
  iva: Prisma.Decimal;
}

// Reverso exacto de lineasPorVenta.
export function lineasPorNotaCredito({ subtotal0, subtotal12, iva }: MontosNotaCredito): LineaAsientoInput[] {
  const total = subtotal0.add(subtotal12).add(iva);
  const lineas: LineaAsientoInput[] = [linea(CUENTAS.DEVOLUCIONES_VENTAS, subtotal0.add(subtotal12), CERO)];
  if (iva.gt(0)) lineas.push(linea(CUENTAS.IVA_VENTAS_POR_PAGAR, iva, CERO));
  lineas.push(linea(CUENTAS.CUENTAS_POR_COBRAR, CERO, total));
  return lineas;
}

interface MontosCompra {
  subtotal0: Prisma.Decimal;
  subtotal12: Prisma.Decimal;
  iva: Prisma.Decimal;
  total: Prisma.Decimal;
}

export function lineasPorCompra({ subtotal0, subtotal12, iva, total }: MontosCompra): LineaAsientoInput[] {
  const lineas: LineaAsientoInput[] = [linea(CUENTAS.INVENTARIO, subtotal0.add(subtotal12), CERO)];
  if (iva.gt(0)) lineas.push(linea(CUENTAS.CREDITO_TRIBUTARIO_IVA_COMPRAS, iva, CERO));
  lineas.push(linea(CUENTAS.CUENTAS_POR_PAGAR, CERO, total));
  return lineas;
}

interface MontosDevolucionCompra {
  subtotal0: Prisma.Decimal;
  subtotal12: Prisma.Decimal;
  iva: Prisma.Decimal;
}

// Reverso exacto de lineasPorCompra.
export function lineasPorDevolucionCompra({ subtotal0, subtotal12, iva }: MontosDevolucionCompra): LineaAsientoInput[] {
  const total = subtotal0.add(subtotal12).add(iva);
  const lineas: LineaAsientoInput[] = [linea(CUENTAS.CUENTAS_POR_PAGAR, total, CERO)];
  if (iva.gt(0)) lineas.push(linea(CUENTAS.CREDITO_TRIBUTARIO_IVA_COMPRAS, CERO, iva));
  lineas.push(linea(CUENTAS.INVENTARIO, CERO, subtotal0.add(subtotal12)));
  return lineas;
}

interface MontosPago {
  monto: Prisma.Decimal;
  formaPago: string;
  tipoDocumento: "COBRO" | "PAGO_PROVEEDOR";
  // Solo obligatorios cuando formaPago === "RETENCION": el desglose IVA/Renta
  // de la Retencion (a proveedores) o RetencionRecibida (de clientes) que
  // generó este Pago — quien llama los lee de ahí, esta función solo reparte.
  totalIvaRetencion?: Prisma.Decimal;
  totalRentaRetencion?: Prisma.Decimal;
}

// Un cobro de cliente (factura/notaVenta) o un pago a proveedor (compra),
// según formaPago: EFECTIVO va a Caja, RETENCION se reparte entre las
// cuentas de retención IVA/Renta correspondientes, cualquier otra forma
// (TRANSFERENCIA/TARJETA/CHEQUE/OTRO) se trata como Bancos.
export function lineasPorPago({ monto, formaPago, tipoDocumento, totalIvaRetencion, totalRentaRetencion }: MontosPago): LineaAsientoInput[] {
  const esCobro = tipoDocumento === "COBRO";
  const cuentaDocumento = esCobro ? CUENTAS.CUENTAS_POR_COBRAR : CUENTAS.CUENTAS_POR_PAGAR;

  if (formaPago === "RETENCION") {
    const iva = totalIvaRetencion ?? CERO;
    const renta = totalRentaRetencion ?? CERO;
    const cuentaIva = esCobro ? CUENTAS.RETENCIONES_IVA_POR_COBRAR : CUENTAS.RETENCIONES_IVA_POR_PAGAR;
    const cuentaRenta = esCobro ? CUENTAS.RETENCIONES_RENTA_POR_COBRAR : CUENTAS.RETENCIONES_RENTA_POR_PAGAR;

    const lineas: LineaAsientoInput[] = [];
    if (iva.gt(0)) lineas.push(esCobro ? linea(cuentaIva, iva, CERO) : linea(cuentaIva, CERO, iva));
    if (renta.gt(0)) lineas.push(esCobro ? linea(cuentaRenta, renta, CERO) : linea(cuentaRenta, CERO, renta));
    lineas.push(esCobro ? linea(cuentaDocumento, CERO, monto) : linea(cuentaDocumento, monto, CERO));
    return lineas;
  }

  const cuentaCaja = formaPago === "EFECTIVO" ? CUENTAS.CAJA : CUENTAS.BANCOS;
  return esCobro
    ? [linea(cuentaCaja, monto, CERO), linea(cuentaDocumento, CERO, monto)]
    : [linea(cuentaDocumento, monto, CERO), linea(cuentaCaja, CERO, monto)];
}

interface MontosMovimientoCaja {
  tipo: "INGRESO" | "EGRESO";
  monto: Prisma.Decimal;
}

export function lineasPorMovimientoCaja({ tipo, monto }: MontosMovimientoCaja): LineaAsientoInput[] {
  return tipo === "INGRESO"
    ? [linea(CUENTAS.CAJA, monto, CERO), linea(CUENTAS.OTROS_INGRESOS, CERO, monto)]
    : [linea(CUENTAS.GASTOS_OPERATIVOS, monto, CERO), linea(CUENTAS.CAJA, CERO, monto)];
}

interface MontosNomina {
  sueldoBase: Prisma.Decimal;
  valorHorasSuplementarias: Prisma.Decimal;
  valorHorasExtraordinarias: Prisma.Decimal;
  otrosIngresos: Prisma.Decimal;
  fondoReservaValor: Prisma.Decimal;
  aportePersonalIess: Prisma.Decimal;
  aportePatronalIess: Prisma.Decimal;
  otrosDescuentos: Prisma.Decimal;
  netoAPagar: Prisma.Decimal;
  // EFECTIVO sale de Caja, cualquier otra forma (normalmente transferencia)
  // sale de Bancos — mismo criterio que lineasPorPago.
  formaPago: "EFECTIVO" | "OTRO";
}

// Asiento al "Pagar" un rol de pagos (ver routes/rolDePagos.ts). El aporte
// patronal NUNCA se descuenta del empleado (es gasto puro de la empresa,
// no reduce netoAPagar) — por eso entra por su cuenta de gasto propia y
// sale por IESS por Pagar, no por Banco/Caja.
export function lineasPorNomina({
  sueldoBase,
  valorHorasSuplementarias,
  valorHorasExtraordinarias,
  otrosIngresos,
  fondoReservaValor,
  aportePersonalIess,
  aportePatronalIess,
  otrosDescuentos,
  netoAPagar,
  formaPago,
}: MontosNomina): LineaAsientoInput[] {
  const bruto = sueldoBase.add(valorHorasSuplementarias).add(valorHorasExtraordinarias).add(otrosIngresos).add(fondoReservaValor);
  const iessPorPagar = aportePersonalIess.add(aportePatronalIess);
  const cuentaCaja = formaPago === "EFECTIVO" ? CUENTAS.CAJA : CUENTAS.BANCOS;

  const lineas: LineaAsientoInput[] = [
    linea(CUENTAS.GASTO_SUELDOS, bruto, CERO),
    linea(CUENTAS.GASTO_APORTE_PATRONAL_IESS, aportePatronalIess, CERO),
    linea(CUENTAS.IESS_POR_PAGAR, CERO, iessPorPagar),
  ];
  if (otrosDescuentos.gt(0)) lineas.push(linea(CUENTAS.OTROS_DESCUENTOS_EMPLEADOS, CERO, otrosDescuentos));
  lineas.push(linea(cuentaCaja, CERO, netoAPagar));
  return lineas;
}

export function validarAsientoCuadrado(lineas: LineaAsientoInput[]): boolean {
  const totalDebe = lineas.reduce((acc, l) => acc.add(l.debe), new Prisma.Decimal(0));
  const totalHaber = lineas.reduce((acc, l) => acc.add(l.haber), new Prisma.Decimal(0));
  return totalDebe.eq(totalHaber);
}
