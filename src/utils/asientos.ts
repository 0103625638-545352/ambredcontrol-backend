// Capa de I/O transaccional del libro diario: numera, resuelve cuentas por
// código y persiste. Las líneas en sí (qué cuenta, cuánto debe/haber) las
// calculan las funciones puras de utils/contabilidad.ts — este archivo solo
// sabe cómo guardarlas.
//
// Un asiento nunca se edita ni se borra una vez creado — un error se corrige
// con su reverso (mismo criterio "nunca editar, solo revertir" que ya usa
// MovimientoInventario: una compra anulada genera una SALIDA compensatoria,
// nunca borra la ENTRADA original).

import { Prisma } from "@prisma/client";
import { LineaAsientoInput, validarAsientoCuadrado } from "./contabilidad";
import { empresaActiva } from "../db";
import { fechaLocalDeString } from "./rangoFechas";

type OrigenAsiento =
  | "FACTURA"
  | "NOTA_VENTA"
  | "NOTA_CREDITO"
  | "COMPRA"
  | "DEVOLUCION_COMPRA"
  | "PAGO"
  | "MOVIMIENTO_CAJA"
  | "MANUAL"
  | "NOMINA";

interface CrearAsientoInput {
  origen: OrigenAsiento;
  origenId?: number;
  descripcion: string;
  lineas: LineaAsientoInput[];
  usuarioId?: number;
  fecha?: Date;
}

async function siguienteNumeroAsiento(tx: Prisma.TransactionClient): Promise<string> {
  const secuencial = await tx.secuencial.upsert({
    where: { puntoVenta_establecimiento_tipoComprobante: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "ASIENTO" } },
    create: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "ASIENTO", ultimoNumero: 1 },
    update: { ultimoNumero: { increment: 1 } },
  });
  return `AST-${String(secuencial.ultimoNumero).padStart(9, "0")}`;
}

export async function crearAsiento(tx: Prisma.TransactionClient, input: CrearAsientoInput) {
  if (!validarAsientoCuadrado(input.lineas)) {
    throw new Error("ASIENTO_DESCUADRADO");
  }

  // Único punto de creación de CUALQUIER asiento (automático o manual) —
  // acá es donde hay que frenar un asiento con fecha en un período ya
  // cerrado, sin importar desde dónde se llame. En la práctica solo el
  // asiento manual puede disparar esto: los orígenes automáticos nunca
  // pasan "fecha" (siempre postean "ahora"), así que jamás caen antes de
  // un cierre ya fijado.
  const cierreHasta = empresaActiva().cierreContableHasta;
  if (cierreHasta) {
    const fechaAsiento = input.fecha ?? new Date();
    if (fechaAsiento <= fechaLocalDeString(cierreHasta, true)) {
      throw new Error("PERIODO_CERRADO");
    }
  }

  const codigos = [...new Set(input.lineas.map((l) => l.cuentaCodigo))];
  const cuentas = await tx.cuentaContable.findMany({ where: { codigo: { in: codigos } } });
  const idPorCodigo = new Map(cuentas.map((c) => [c.codigo, c.id]));

  for (const codigo of codigos) {
    if (!idPorCodigo.has(codigo)) throw new Error(`CUENTA_CONTABLE_NO_ENCONTRADA:${codigo}`);
  }

  const numero = await siguienteNumeroAsiento(tx);

  return tx.asientoContable.create({
    data: {
      numero,
      fecha: input.fecha,
      descripcion: input.descripcion,
      origen: input.origen,
      origenId: input.origenId,
      usuarioId: input.usuarioId,
      lineas: {
        create: input.lineas.map((l) => ({
          cuentaId: idPorCodigo.get(l.cuentaCodigo)!,
          debe: l.debe,
          haber: l.haber,
          glosa: l.glosa,
        })),
      },
    },
    include: { lineas: { include: { cuenta: true } } },
  });
}

// Busca el asiento original (no una reversión ya existente) generado por un
// documento y crea su espejo exacto (debe/haber invertidos). Mejor esfuerzo:
// si no encuentra nada — típicamente un documento de antes de que existiera
// este módulo — loguea y sigue sin lanzar, nunca bloquea la anulación en sí.
export async function revertirAsientoDeOrigen(tx: Prisma.TransactionClient, origen: OrigenAsiento, origenId: number, usuarioId?: number) {
  const original = await tx.asientoContable.findFirst({
    where: { origen, origenId, asientoRevertidoId: null },
    include: { lineas: true },
  });

  if (!original) {
    console.warn(`[contabilidad] No se encontró asiento contable para revertir (origen=${origen}, origenId=${origenId})`);
    return null;
  }

  const numero = await siguienteNumeroAsiento(tx);

  return tx.asientoContable.create({
    data: {
      numero,
      descripcion: `Reversión: ${original.descripcion}`,
      origen,
      origenId,
      asientoRevertidoId: original.id,
      usuarioId,
      lineas: {
        create: original.lineas.map((l) => ({
          cuentaId: l.cuentaId,
          debe: l.haber,
          haber: l.debe,
          glosa: l.glosa,
        })),
      },
    },
    include: { lineas: { include: { cuenta: true } } },
  });
}
