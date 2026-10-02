// Calcula el estado de conexión de un Cliente para el Mapa de Red (ver
// routes/mapaRed.ts) a partir de las señales que ya recolecta el sistema:
// ping ICMP (jobs/pingClientes.ts), estado/señal óptica de su ONU (OLT,
// jobs/pollingOlt.ts) y si el Mikrotik de su nodo sigue respondiendo
// (NodoRed.ultimaConexionExitosa). Función pura para poder testearla sin
// tocar la base de datos — routes/mapaRed.ts arma los parámetros con lo que
// ya trajo de Prisma.
export type EstadoRedCliente =
  | "OK"
  | "SENAL_DEBIL"
  | "LATENCIA_ALTA"
  | "INESTABLE"
  | "SIN_RESPUESTA"
  | "ONU_OFFLINE"
  | "NODO_CAIDO"
  | "SIN_DATOS";

// Umbrales — ajustables acá sin tocar la lógica. La señal óptica GPON
// "normal" ronda entre -8 y -27 dBm; por debajo de -27 dBm se considera
// débil (cable/conector en mal estado, ONU lejos de la OLT, splitter sucio).
const UMBRAL_SENAL_DEBIL_DBM = -27;
const UMBRAL_LATENCIA_ALTA_MS = 150;
const UMBRAL_EVENTOS_INESTABLE = 3; // transiciones online/offline para considerarla "inestable"
const UMBRAL_NODO_CAIDO_MINUTOS = 10;

export interface EntradaEstadoCliente {
  pingEstado: "OK" | "SIN_RESPUESTA" | null;
  pingMs: number | null;
  onuEstado: "ONLINE" | "OFFLINE" | null;
  onuRxPowerDbm: number | null;
  onuSerial: string | null;
  transicionesRecientes: number; // eventos ONU_ONLINE/ONU_OFFLINE en las últimas horas, ver routes/mapaRed.ts
  nodoNombre: string | null;
  nodoMinutosSinConexion: number | null; // null = nodo nunca configurado o sin dato
}

export interface ResultadoEstadoCliente {
  estado: EstadoRedCliente;
  detalle: string;
}

export function calcularEstadoCliente(e: EntradaEstadoCliente): ResultadoEstadoCliente {
  if (e.nodoMinutosSinConexion !== null && e.nodoMinutosSinConexion >= UMBRAL_NODO_CAIDO_MINUTOS) {
    return { estado: "NODO_CAIDO", detalle: `El nodo "${e.nodoNombre}" no responde hace ${e.nodoMinutosSinConexion} min` };
  }
  if (e.onuEstado === "OFFLINE") {
    return { estado: "ONU_OFFLINE", detalle: `ONU offline${e.onuSerial ? ` (serial ${e.onuSerial})` : ""}` };
  }
  if (e.pingEstado === "SIN_RESPUESTA") {
    return { estado: "SIN_RESPUESTA", detalle: "No responde a ping" };
  }
  if (e.transicionesRecientes >= UMBRAL_EVENTOS_INESTABLE) {
    return { estado: "INESTABLE", detalle: `La ONU se cayó ${e.transicionesRecientes} veces en las últimas horas` };
  }
  if (e.pingMs !== null && e.pingMs > UMBRAL_LATENCIA_ALTA_MS) {
    return { estado: "LATENCIA_ALTA", detalle: `Latencia de ${e.pingMs} ms` };
  }
  if (e.onuRxPowerDbm !== null && e.onuRxPowerDbm < UMBRAL_SENAL_DEBIL_DBM) {
    return { estado: "SENAL_DEBIL", detalle: `Señal óptica baja (${e.onuRxPowerDbm} dBm)` };
  }
  if (e.onuEstado === null && e.pingEstado === null) {
    return { estado: "SIN_DATOS", detalle: "Sin ONU vinculada ni ping medido todavía" };
  }
  return { estado: "OK", detalle: "Conexión normal" };
}
