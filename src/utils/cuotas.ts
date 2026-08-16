// Validación del plan de Cuotas al vender a crédito (ver modelo Cuota en
// schema.prisma) — compartido entre routes/facturas.ts y
// routes/notasVenta.ts para no duplicar la misma lógica dos veces. Lanza
// Error("CODIGO") en vez de responder HTTP directamente, mismo criterio que
// validarDatosPago en routes/facturas.ts.
export interface CuotaInput {
  numero: number;
  monto: number;
  fechaVencimiento: string;
}

// Solo valida que el plan esté bien formado (numeración 1..N sin huecos,
// montos positivos, fechas válidas) — a propósito NO exige que la suma
// coincida con el total del documento: la venta y el registro del abono
// inicial son dos llamadas separadas (ver PuntoDeVentaPage.tsx), así que acá
// no se conoce cuánto se pagó de entrada. El reparto correcto (saldo restante
// ÷ número de cuotas) es responsabilidad del frontend al armar el plan.
export function validarPlanCuotas(cuotas: CuotaInput[]): void {
  if (cuotas.length === 0) throw new Error("CUOTAS_VACIAS");

  for (let i = 0; i < cuotas.length; i++) {
    const cuota = cuotas[i];
    if (cuota.numero !== i + 1) throw new Error("CUOTAS_NUMERO_INVALIDO");
    if (typeof cuota.monto !== "number" || Number.isNaN(cuota.monto) || cuota.monto <= 0) {
      throw new Error("CUOTAS_MONTO_INVALIDO");
    }
    if (!cuota.fechaVencimiento || Number.isNaN(new Date(cuota.fechaVencimiento).getTime())) {
      throw new Error("CUOTAS_FECHA_INVALIDA");
    }
  }
}
