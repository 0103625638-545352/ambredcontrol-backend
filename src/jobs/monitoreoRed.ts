// Revisión horaria del Centro de Control: señal óptica degradada por ONU y
// depuración del historial de lecturas viejo. Los cortes masivos NO se
// revisan acá — se detectan en el momento, dentro de cada pasada del polling
// de OLT (ver jobs/pollingOlt.ts → sincronizarOlt → evaluarCortesMasivos).
// Mismo patrón multiempresa que el resto de jobs: recorre todas las empresas
// y entra al contexto de cada una.
import { ejecutarConEmpresa } from "../db";
import { listarEmpresas } from "../utils/empresas";
import { evaluarSenalDegradada, depurarLecturasAntiguas } from "../utils/monitoreoRed";

const UNA_HORA_MS = 60 * 60_000;

let corriendoActualmente = false;

async function revisarTodasLasEmpresas() {
  if (corriendoActualmente) return;
  corriendoActualmente = true;
  try {
    for (const empresa of listarEmpresas()) {
      try {
        await ejecutarConEmpresa(empresa.id, async () => {
          const nuevas = await evaluarSenalDegradada();
          const borradas = await depurarLecturasAntiguas();
          if (nuevas > 0 || borradas > 0) {
            console.log(`[monitoreo-red] "${empresa.nombre}": ${nuevas} alerta(s) de señal degradada nueva(s), ${borradas} lectura(s) vieja(s) depurada(s).`);
          }
        });
      } catch (error: any) {
        console.error(`[monitoreo-red] Error revisando "${empresa.nombre}":`, error.message);
      }
    }
  } finally {
    corriendoActualmente = false;
  }
}

export function iniciarMonitoreoRed(): void {
  console.log("[monitoreo-red] Job activado: revisa la señal óptica de las ONUs cada hora.");
  // Arranca 10 minutos después del servidor, para que el polling de OLT ya
  // haya traído datos frescos en su primera pasada.
  setTimeout(revisarTodasLasEmpresas, 10 * 60_000);
  setInterval(revisarTodasLasEmpresas, UNA_HORA_MS);
}
