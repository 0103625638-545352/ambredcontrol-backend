// Wrapper sobre el paquete "ping" — hace ping ICMP shelleando al comando
// "ping" del sistema operativo (funciona igual en Windows/Linux, no
// requiere sockets crudos ni privilegios de administrador, a diferencia de
// una librería de ICMP puro). Usado por jobs/pingClientes.ts para el Mapa de
// Red — ver utils/estadoRedCliente.ts.
import { promise as pingPromise } from "ping";

const TIMEOUT_SEGUNDOS = 2;

export interface ResultadoPing {
  alcanzable: boolean;
  tiempoMs: number | null;
}

export async function pingHost(direccionIp: string): Promise<ResultadoPing> {
  const respuesta = await pingPromise.probe(direccionIp, { timeout: TIMEOUT_SEGUNDOS });
  if (!respuesta.alive) return { alcanzable: false, tiempoMs: null };

  // "time" es number la mayoría de las veces, pero la librería a veces
  // devuelve el string "unknown" si no pudo parsear el tiempo del ping vivo.
  const tiempo = typeof respuesta.time === "number" ? respuesta.time : Number(respuesta.time);
  return { alcanzable: true, tiempoMs: Number.isFinite(tiempo) ? Math.round(tiempo) : null };
}
