// Cálculo del "efectivo esperado" de una sesión de caja (apertura/cierre con
// arqueo, ver routes/caja.ts). Separado en funciones puras + una función de
// I/O, mismo criterio que estadoPago.ts/alertasNegocio.ts: la aritmética se
// testea sin base de datos, la consulta se verifica en vivo.

import { Prisma } from "@prisma/client";
import { prisma } from "../db";

export interface ComponentesEfectivoCaja {
  montoInicial: Prisma.Decimal;
  ventasEfectivo: Prisma.Decimal; // Pago EFECTIVO de Factura + NotaVenta de este punto de venta (o sucursal), en la ventana
  ingresosManuales: Prisma.Decimal; // suma MovimientoCaja tipo INGRESO de esta sesión
  comprasEfectivo: Prisma.Decimal; // Pago EFECTIVO de Compra de este punto de venta (o sucursal), en la ventana
  egresosManuales: Prisma.Decimal; // suma MovimientoCaja tipo EGRESO de esta sesión
}

// Función pura — sin I/O, fácil de testear con valores fijos.
export function calcularEfectivoEsperado(c: ComponentesEfectivoCaja): Prisma.Decimal {
  return c.montoInicial
    .add(c.ventasEfectivo)
    .add(c.ingresosManuales)
    .sub(c.comprasEfectivo)
    .sub(c.egresosManuales);
}

// Función pura — positivo = sobrante, negativo = faltante.
export function calcularDiferenciaCierre(montoContado: Prisma.Decimal, montoEsperado: Prisma.Decimal): Prisma.Decimal {
  return montoContado.sub(montoEsperado);
}

// Función de I/O — arma ComponentesEfectivoCaja consultando la BD. "hasta" es
// new Date() para una sesión abierta, o la fecha de cierre para recalcular
// el detalle exacto de una sesión ya cerrada.
//
// sesion.puntoVentaId decide CÓMO se filtran las ventas/compras en efectivo:
//   - con punto de venta: solo documentos de ESE punto de venta exacto —
//     así dos cajas abiertas a la vez en la misma sucursal (una por punto
//     de venta) nunca se mezclan entre sí.
//   - sin punto de venta (sucursal que no usa puntos de venta, o alguien
//     que abrió caja sin elegir uno): documentos de la sucursal CON
//     puntoVentaId null también — no basta con filtrar por sucursal sola,
//     porque si esa misma sucursal tiene otras cajas con punto de venta
//     abiertas en simultáneo, una caja "sin punto de venta" les robaría el
//     efectivo si no se excluyen explícitamente sus documentos.
export async function obtenerComponentesEfectivoCaja(
  sesion: { id: number; sucursalId: number; puntoVentaId: number | null; montoInicial: Prisma.Decimal; abiertaEn: Date },
  hasta: Date
): Promise<ComponentesEfectivoCaja> {
  const ventana = { gte: sesion.abiertaEn, lte: hasta };
  const filtroDocumento = sesion.puntoVentaId
    ? { puntoVentaId: sesion.puntoVentaId }
    : { sucursalId: sesion.sucursalId, puntoVentaId: null };

  const [ventas, compras, ingresos, egresos] = await Promise.all([
    prisma.pago.aggregate({
      where: {
        formaPago: "EFECTIVO",
        fecha: ventana,
        OR: [{ factura: filtroDocumento }, { notaVenta: filtroDocumento }],
      },
      _sum: { monto: true },
    }),
    prisma.pago.aggregate({
      where: { formaPago: "EFECTIVO", fecha: ventana, compra: filtroDocumento },
      _sum: { monto: true },
    }),
    prisma.movimientoCaja.aggregate({
      where: { cajaSesionId: sesion.id, tipo: "INGRESO" },
      _sum: { monto: true },
    }),
    prisma.movimientoCaja.aggregate({
      where: { cajaSesionId: sesion.id, tipo: "EGRESO" },
      _sum: { monto: true },
    }),
  ]);

  return {
    montoInicial: sesion.montoInicial,
    ventasEfectivo: ventas._sum.monto ?? new Prisma.Decimal(0),
    comprasEfectivo: compras._sum.monto ?? new Prisma.Decimal(0),
    ingresosManuales: ingresos._sum.monto ?? new Prisma.Decimal(0),
    egresosManuales: egresos._sum.monto ?? new Prisma.Decimal(0),
  };
}
