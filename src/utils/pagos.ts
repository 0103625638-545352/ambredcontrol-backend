// Punto único de creación de un Pago (factura/notaVenta = cobro a cliente,
// compra = pago a proveedor) que además genera su asiento contable en la
// misma llamada — reemplaza los 5 `tx.pago.create(...)` que antes estaban
// duplicados en facturas.ts, compras.ts, notasVenta.ts, retenciones.ts y
// retencionesRecibidas.ts. NO toca montoPagado/estadoPago del documento
// padre: eso sigue en cada ruta, porque el modelo a actualizar (Factura/
// Compra/NotaVenta) difiere según el caso.
import { Prisma } from "@prisma/client";
import { lineasPorPago } from "./contabilidad";
import { crearAsiento } from "./asientos";

interface CrearPagoConAsientoInput {
  facturaId?: number;
  // Cobro de internet ANTES de que exista la factura del mes (ver
  // routes/facturasInternet.ts) — se llena SOLO cuando facturaId todavía es
  // null; una vez que "Facturar a todos los pagados" genera la factura,
  // este mismo Pago se actualiza con su facturaId (no se crea uno nuevo).
  clienteId?: number;
  compraId?: number;
  notaVentaId?: number;
  monto: Prisma.Decimal;
  formaPago: string;
  referencia?: string;
  // Solo cuando formaPago es TRANSFERENCIA/TARJETA/CHEQUE — ver validación en
  // routes/facturas.ts, compras.ts, notasVenta.ts.
  cuentaBancariaId?: number;
  // Datos de ORIGEN del pago (banco/cuenta/tarjeta de quien pagó) — todos
  // opcionales, ninguno se exige acá. Ver el comentario del modelo Pago en
  // schema.prisma para qué campos aplican según formaPago.
  bancoOrigenId?: number;
  numeroCuentaOrigen?: string;
  tarjetaUltimosDigitos?: string;
  tarjetaTipo?: string;
  tarjetaReferencia?: string;
  tarjetaLote?: string;
  chequeNumero?: string;
  chequeFechaCobro?: string; // fecha ISO ("2026-08-20"), se convierte a Date acá
  // Si este pago liquida una Cuota de un plan a plazos (ver modelo Cuota) —
  // quien llama ya validó que el monto coincide exacto con esa cuota.
  cuotaId?: number;
  descripcion: string;
  usuarioId?: number;
  fecha?: Date;
  // Solo cuando formaPago === "RETENCION": el desglose IVA/Renta de la
  // Retencion (a proveedores) o RetencionRecibida (de clientes) que generó
  // este pago.
  totalIvaRetencion?: Prisma.Decimal;
  totalRentaRetencion?: Prisma.Decimal;
}

export async function crearPagoConAsiento(tx: Prisma.TransactionClient, input: CrearPagoConAsientoInput) {
  const pago = await tx.pago.create({
    data: {
      facturaId: input.facturaId,
      clienteId: input.clienteId,
      compraId: input.compraId,
      notaVentaId: input.notaVentaId,
      monto: input.monto,
      formaPago: input.formaPago,
      referencia: input.referencia || undefined,
      cuentaBancariaId: input.cuentaBancariaId,
      bancoOrigenId: input.bancoOrigenId || undefined,
      numeroCuentaOrigen: input.numeroCuentaOrigen || undefined,
      tarjetaUltimosDigitos: input.tarjetaUltimosDigitos || undefined,
      tarjetaTipo: input.tarjetaTipo || undefined,
      tarjetaReferencia: input.tarjetaReferencia || undefined,
      tarjetaLote: input.tarjetaLote || undefined,
      chequeNumero: input.chequeNumero || undefined,
      chequeFechaCobro: input.chequeFechaCobro ? new Date(input.chequeFechaCobro) : undefined,
      cuotaId: input.cuotaId,
    },
  });

  const tipoDocumento = input.compraId ? "PAGO_PROVEEDOR" : "COBRO";
  const lineas = lineasPorPago({
    monto: input.monto,
    formaPago: input.formaPago,
    tipoDocumento,
    totalIvaRetencion: input.totalIvaRetencion,
    totalRentaRetencion: input.totalRentaRetencion,
  });

  await crearAsiento(tx, {
    origen: "PAGO",
    origenId: pago.id,
    descripcion: input.descripcion,
    lineas,
    usuarioId: input.usuarioId,
    fecha: input.fecha,
  });

  return pago;
}
