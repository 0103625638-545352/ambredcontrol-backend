// Reglas de control interno del Centro de Control — funciones puras (sin
// I/O), mismo estilo que utils/geocercas.ts, testeadas en
// controlInterno.test.ts. Las consultas a la base que las alimentan viven en
// routes/centroControl.ts.
import { calcularDistanciaMetros } from "./geocercas";

// ---------------------------------------------------------------------------
// Visitas técnicas: ¿el técnico estuvo realmente en la casa del cliente?
// ---------------------------------------------------------------------------

// Un GPS de celular típico tiene 10-50 m de error, y la ubicación planeada
// viene copiada de un mensaje de WhatsApp (puede estar corrida una cuadra) —
// por eso el umbral es holgado. Pasado esto, ya no es "error de GPS".
export const DISTANCIA_SOSPECHOSA_METROS = Number(process.env.VISITA_DISTANCIA_SOSPECHOSA_METROS) || 300;
// Ventana alrededor de la hora de "Llegué" en la que se busca un punto del
// rastreo GPS de fondo (UbicacionTecnico) cerca del cliente.
const VENTANA_RASTRO_MINUTOS = 45;

export interface PuntoGps {
  latitud: number;
  longitud: number;
  fecha: Date;
}

export interface VisitaParaEvaluar {
  latitud: number; // punto PLANEADO de la visita
  longitud: number;
  distanciaAlPunto: number | null; // calculada al marcar "Llegué"
  fechaLlegadaReal: Date | null;
}

export interface EvaluacionVisita {
  sospechosa: boolean;
  motivos: string[];
  distanciaRastroMetros: number | null; // punto del rastreo de fondo más cercano al cliente, dentro de la ventana
}

// "rastroDelDia" = todos los puntos del rastreo GPS de fondo del técnico ese
// día (vacío si el técnico no usa la app nativa con rastreo — en ese caso
// solo se evalúa la distancia al marcar "Llegué", nunca se lo acusa por no
// tener rastro).
export function evaluarVisita(visita: VisitaParaEvaluar, rastroDelDia: PuntoGps[]): EvaluacionVisita {
  const motivos: string[] = [];
  let distanciaRastroMetros: number | null = null;

  if (visita.distanciaAlPunto !== null && visita.distanciaAlPunto > DISTANCIA_SOSPECHOSA_METROS) {
    motivos.push(`Marcó "Llegué" a ${Math.round(visita.distanciaAlPunto)} m del cliente`);
  }

  if (visita.fechaLlegadaReal && rastroDelDia.length > 0) {
    const centro = visita.fechaLlegadaReal.getTime();
    const ventanaMs = VENTANA_RASTRO_MINUTOS * 60_000;
    const enVentana = rastroDelDia.filter((p) => Math.abs(p.fecha.getTime() - centro) <= ventanaMs);

    if (enVentana.length === 0) {
      motivos.push(`Su GPS de fondo no reportó nada ±${VENTANA_RASTRO_MINUTOS} min alrededor de la llegada`);
    } else {
      distanciaRastroMetros = Math.min(
        ...enVentana.map((p) => calcularDistanciaMetros(visita.latitud, visita.longitud, p.latitud, p.longitud))
      );
      if (distanciaRastroMetros > DISTANCIA_SOSPECHOSA_METROS) {
        motivos.push(`Su GPS de fondo nunca estuvo a menos de ${Math.round(distanciaRastroMetros)} m del cliente en esa hora`);
      }
    }
  }

  return { sospechosa: motivos.length > 0, motivos, distanciaRastroMetros };
}

// ---------------------------------------------------------------------------
// Combustible: cargas con consumo anormal
// ---------------------------------------------------------------------------

export interface CargaParaEvaluar {
  id: number;
  vehiculoId: number;
  fecha: Date;
  kilometraje: number;
  galones: number;
}

export interface AnomaliaCombustible {
  cargaId: number;
  motivo: string;
  rendimiento: number | null; // km/gal de ESTA carga
  rendimientoMediano: number | null; // mediana histórica del vehículo
}

// Una carga rinde "anormalmente poco" si da menos del 70% de la mediana de
// ese mismo vehículo — se compara cada unidad contra sí misma, nunca contra
// la flota (una camioneta rinde menos que un auto por diseño).
const FRACCION_RENDIMIENTO_ANORMAL = 0.7;
const MINIMO_CARGAS_PARA_MEDIANA = 3;

function mediana(valores: number[]): number {
  const orden = [...valores].sort((a, b) => a - b);
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 === 0 ? (orden[medio - 1] + orden[medio]) / 2 : orden[medio];
}

// Recibe el historial de cargas (de uno o varios vehículos, en cualquier
// orden) y devuelve solo las que tienen algo raro.
export function detectarAnomaliasCombustible(cargas: CargaParaEvaluar[]): AnomaliaCombustible[] {
  const porVehiculo = new Map<number, CargaParaEvaluar[]>();
  for (const c of cargas) {
    const lista = porVehiculo.get(c.vehiculoId) ?? [];
    lista.push(c);
    porVehiculo.set(c.vehiculoId, lista);
  }

  const anomalias: AnomaliaCombustible[] = [];
  for (const lista of porVehiculo.values()) {
    lista.sort((a, b) => a.fecha.getTime() - b.fecha.getTime() || a.id - b.id);

    const rendimientos = new Map<number, number>();
    for (let i = 1; i < lista.length; i++) {
      const km = lista[i].kilometraje - lista[i - 1].kilometraje;
      if (km > 0 && lista[i].galones > 0) rendimientos.set(lista[i].id, km / lista[i].galones);
    }
    const valores = [...rendimientos.values()];
    const med = valores.length >= MINIMO_CARGAS_PARA_MEDIANA ? mediana(valores) : null;

    for (let i = 1; i < lista.length; i++) {
      const actual = lista[i];
      const anterior = lista[i - 1];
      if (actual.kilometraje <= anterior.kilometraje) {
        anomalias.push({
          cargaId: actual.id,
          motivo: `Odómetro ${actual.kilometraje} km no avanzó respecto a la carga anterior (${anterior.kilometraje} km)`,
          rendimiento: null,
          rendimientoMediano: med,
        });
        continue;
      }
      const rend = rendimientos.get(actual.id);
      if (rend !== undefined && med !== null && rend < med * FRACCION_RENDIMIENTO_ANORMAL) {
        anomalias.push({
          cargaId: actual.id,
          motivo: `Rindió ${rend.toFixed(1)} km/gal, muy por debajo de lo normal para este vehículo (${med.toFixed(1)} km/gal)`,
          rendimiento: rend,
          rendimientoMediano: med,
        });
      }
    }
  }
  return anomalias;
}

// ---------------------------------------------------------------------------
// Tickets de soporte: tiempo de atención (SLA)
// ---------------------------------------------------------------------------

export type PrioridadTicket = "BAJA" | "MEDIA" | "ALTA";
export const PRIORIDADES_TICKET: PrioridadTicket[] = ["BAJA", "MEDIA", "ALTA"];

// Horas máximas para RESOLVER un ticket según su prioridad. "ALTA" es un
// cliente sin servicio; "BAJA" un pedido administrativo.
export const HORAS_SLA: Record<PrioridadTicket, number> = { ALTA: 4, MEDIA: 24, BAJA: 72 };

export interface EstadoSla {
  horasTranscurridas: number;
  horasLimite: number;
  vencido: boolean;
}

// Para un ticket ya resuelto mide hasta fechaResolucion (queda fijo); para
// uno abierto, hasta "ahora" (sigue corriendo).
export function calcularSla(
  ticket: { prioridad: string; createdAt: Date; fechaResolucion: Date | null },
  ahora: Date
): EstadoSla {
  const horasLimite = HORAS_SLA[ticket.prioridad as PrioridadTicket] ?? HORAS_SLA.MEDIA;
  const fin = ticket.fechaResolucion ?? ahora;
  const horasTranscurridas = Math.max(0, (fin.getTime() - ticket.createdAt.getTime()) / 3_600_000);
  return { horasTranscurridas: Math.round(horasTranscurridas * 10) / 10, horasLimite, vencido: horasTranscurridas > horasLimite };
}

// ---------------------------------------------------------------------------
// Encuesta por WhatsApp: interpretar la respuesta del cliente
// ---------------------------------------------------------------------------

// Acepta "5", "5 excelente", "⭐⭐⭐⭐", "4/5" — devuelve null si el texto no
// es una calificación (entonces se trata como un mensaje normal: puede ser
// un reclamo nuevo, ver routes/whatsappWebhook.ts).
export function interpretarCalificacion(texto: string): number | null {
  const limpio = texto.trim();
  const numero = limpio.match(/^([1-5])(?:\s*\/\s*5)?(?:\D|$)/);
  if (numero) return Number(numero[1]);
  const estrellas = (limpio.match(/⭐|★/g) ?? []).length;
  if (estrellas >= 1 && estrellas <= 5 && limpio.replace(/⭐|★|\s/g, "").length === 0) return estrellas;
  return null;
}
