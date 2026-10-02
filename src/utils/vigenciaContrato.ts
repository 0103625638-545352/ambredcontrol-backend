// Vigencia mínima de contrato de servicio (Cliente.fechaInicioServicio +
// vigenciaContratoMeses) y si procede multa por abandono/término
// injustificado cuando el cliente se da de baja antes de cumplirla (ver
// PATCH /clientes/:id/dar-de-baja). El sistema NO calcula el monto de la
// multa — solo indica si corresponde cobrarla (ej. "cobro de equipos" no
// devueltos); el admin decide el valor caso por caso.

// Únicos plazos que acepta el formulario — 6 meses, 1, 2 o 3 años.
export const OPCIONES_VIGENCIA_MESES = [6, 12, 24, 36] as const;

export interface VigenciaContrato {
  fechaFinVigencia: Date;
  cumplioVigencia: boolean;
  diasFaltantes: number; // 0 si ya cumplió (o está a punto de cumplir hoy)
}

// Mismo criterio que calcularMesesLaboradosEnRango (utils/decimos.ts): suma
// meses calendario dejando que Date resuelva el desborde de día (ej. 31-ene
// + 1 mes -> 3-mar) — de sobra para una vigencia de 6/12/24/36 meses.
export function calcularVigenciaContrato(
  fechaInicioServicio: Date,
  vigenciaContratoMeses: number,
  fechaComparacion: Date
): VigenciaContrato {
  const fechaFinVigencia = new Date(fechaInicioServicio);
  fechaFinVigencia.setMonth(fechaFinVigencia.getMonth() + vigenciaContratoMeses);

  const msFaltantes = fechaFinVigencia.getTime() - fechaComparacion.getTime();
  const diasFaltantes = Math.max(0, Math.ceil(msFaltantes / (1000 * 60 * 60 * 24)));

  return { fechaFinVigencia, cumplioVigencia: diasFaltantes === 0, diasFaltantes };
}
