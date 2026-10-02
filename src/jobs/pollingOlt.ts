// Polling periódico de las OLT Huawei registradas — sin esto, el estado y la
// señal óptica de cada ONU (ver OltOnu.estado/rxPowerDbm/txPowerDbm) solo se
// actualizarían cuando alguien entra a la pantalla y aprieta "Sincronizar
// ahora". Mismo patrón que jobs/reintentoAutorizacionSri.ts: recorre todas
// las empresas (multi-tenant, cada una con su propia base de datos) y dentro
// de cada una todas sus OLT activas, sincronizando una por una.
import { prisma, ejecutarConEmpresa } from "../db";
import { sincronizarOlt } from "../routes/olts";
import { listarEmpresas } from "../utils/empresas";

const UN_MINUTO_MS = 60_000;
const INTERVALO_MS = (Number(process.env.OLT_POLLING_INTERVALO_MINUTOS) || 5) * UN_MINUTO_MS;

// Pausa entre cada OLT, para no disparar ráfagas de SNMP simultáneas si hay
// varias OLT configuradas en la misma empresa.
const PAUSA_ENTRE_OLTS_MS = 1000;

let corriendoActualmente = false;

function pausa(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sincronizarOltsDeEmpresaActual() {
  const olts = await prisma.olt.findMany({ where: { activo: true }, select: { id: true, nombre: true } });

  for (const olt of olts) {
    try {
      const resultado = await sincronizarOlt(olt.id);
      if (resultado.nuevas > 0 || resultado.desaparecidas > 0) {
        console.log(`[polling-olt] ${olt.nombre}: ${resultado.totalDetectadas} ONU(s) — ${resultado.nuevas} nueva(s), ${resultado.desaparecidas} desaparecida(s)`);
      }
    } catch (error: any) {
      console.error(`[polling-olt] Error sincronizando OLT ${olt.nombre}:`, error.message);
    }
    await pausa(PAUSA_ENTRE_OLTS_MS);
  }
}

// Multiempresa: mismo criterio que correrCicloDeReintentos en
// reintentoAutorizacionSri.ts — "prisma" solo resuelve a la base correcta
// mientras estamos DENTRO de ejecutarConEmpresa.
async function correrCicloDePolling() {
  if (corriendoActualmente) {
    console.log("[polling-olt] La corrida anterior todavía no termina, se salta este ciclo.");
    return;
  }

  corriendoActualmente = true;
  try {
    for (const empresa of listarEmpresas()) {
      await ejecutarConEmpresa(empresa.id, sincronizarOltsDeEmpresaActual);
    }
  } catch (error: any) {
    console.error("[polling-olt] Error inesperado en el ciclo de polling:", error.message);
  } finally {
    corriendoActualmente = false;
  }
}

// Arranca el job: corre una vez de inmediato y de ahí en adelante cada
// INTERVALO_MS. Se llama una sola vez, al arrancar el servidor (ver index.ts).
export function iniciarPollingOlt() {
  const minutos = INTERVALO_MS / UN_MINUTO_MS;
  console.log(`[polling-olt] Job activado: sincroniza las OLT registradas cada ${minutos} minuto(s).`);

  correrCicloDePolling();
  setInterval(correrCicloDePolling, INTERVALO_MS);
}
