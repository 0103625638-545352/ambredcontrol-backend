// Chequeo periódico de conectividad con el Mikrotik de cada nodo (ver
// utils/monitoreoNodos.ts). Mismo patrón multiempresa que el resto de jobs.
import { ejecutarConEmpresa } from "../db";
import { listarEmpresas } from "../utils/empresas";
import { revisarNodosEmpresaActual } from "../utils/monitoreoNodos";

const UN_MINUTO_MS = 60_000;
const INTERVALO_MS = (Number(process.env.NODOS_MONITOREO_INTERVALO_MINUTOS) || 5) * UN_MINUTO_MS;

let corriendoActualmente = false;

async function revisarTodasLasEmpresas() {
  if (corriendoActualmente) return;
  corriendoActualmente = true;
  try {
    for (const empresa of listarEmpresas()) {
      try {
        await ejecutarConEmpresa(empresa.id, () => revisarNodosEmpresaActual());
      } catch (error: any) {
        console.error(`[monitoreo-nodos] Error revisando "${empresa.nombre}":`, error.message);
      }
    }
  } finally {
    corriendoActualmente = false;
  }
}

export function iniciarMonitoreoNodos(): void {
  console.log(`[monitoreo-nodos] Job activado: revisa la conexión con cada nodo (Mikrotik) cada ${INTERVALO_MS / UN_MINUTO_MS} minuto(s).`);
  setTimeout(revisarTodasLasEmpresas, 30_000);
  setInterval(revisarTodasLasEmpresas, INTERVALO_MS);
}
