// Emparejamiento de marcaciones de entrada/salida en sesiones de trabajo,
// para calcular horas trabajadas (ver routes/marcaciones.ts:
// GET /marcaciones/horas-trabajadas, que alimenta el formulario de Rol de
// Pagos). Función pura, mismo estilo que utils/iess.ts.
//
// A propósito NO clasifica horas en suplementarias/extraordinarias — eso
// exige saber qué fue nocturno/fin de semana/feriado, algo que este sistema
// no tiene forma de saber de forma confiable a partir de solo dos
// timestamps. Solo suma horas trabajadas; la clasificación queda a criterio
// del admin (ver el formulario de Rol de Pagos).
export interface PuntoMarcacion {
  tipo: "ENTRADA" | "SALIDA";
  fecha: Date;
}

export interface Sesion {
  entrada: Date;
  salida: Date;
  horas: number;
}

export interface Anomalia {
  // ENTRADA_SIN_SALIDA: quedó abierta (sea porque el empleado sigue
  // trabajando, sea porque olvidó marcar la salida).
  // SALIDA_SIN_ENTRADA: no había ninguna entrada abierta para cerrar.
  tipo: "ENTRADA_SIN_SALIDA" | "SALIDA_SIN_ENTRADA";
  fecha: Date;
}

const MS_POR_HORA = 60 * 60 * 1000;

// Camina la lista en orden cronológico con una sola "entrada abierta" a la
// vez — no intenta adivinar en los casos ambiguos (dos ENTRADA seguidas, una
// SALIDA suelta), los reporta como anomalía en vez de inventar un
// emparejamiento. Funciona igual para turnos que cruzan medianoche: la resta
// es sobre el timestamp completo, no por día calendario.
export function emparejarMarcaciones(marcaciones: PuntoMarcacion[]): { sesiones: Sesion[]; anomalias: Anomalia[] } {
  const ordenadas = [...marcaciones].sort((a, b) => a.fecha.getTime() - b.fecha.getTime());

  const sesiones: Sesion[] = [];
  const anomalias: Anomalia[] = [];
  let entradaAbierta: Date | null = null;

  for (const m of ordenadas) {
    if (m.tipo === "ENTRADA") {
      if (entradaAbierta) {
        anomalias.push({ tipo: "ENTRADA_SIN_SALIDA", fecha: entradaAbierta });
      }
      entradaAbierta = m.fecha;
    } else {
      if (!entradaAbierta) {
        anomalias.push({ tipo: "SALIDA_SIN_ENTRADA", fecha: m.fecha });
        continue;
      }
      const horas = (m.fecha.getTime() - entradaAbierta.getTime()) / MS_POR_HORA;
      sesiones.push({ entrada: entradaAbierta, salida: m.fecha, horas });
      entradaAbierta = null;
    }
  }

  if (entradaAbierta) {
    anomalias.push({ tipo: "ENTRADA_SIN_SALIDA", fecha: entradaAbierta });
  }

  return { sesiones, anomalias };
}

export function calcularHorasTrabajadas(sesiones: Sesion[]): number {
  return sesiones.reduce((acc, s) => acc + s.horas, 0);
}
