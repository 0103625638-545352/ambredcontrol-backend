// Polling periódico de los switches TP-Link de cliente registrados — sin
// esto, el estado de puertos/tráfico/PoE (ver SwitchPuerto) solo se
// actualizaría cuando alguien entra a la pantalla y aprieta "Sincronizar
// ahora". Mismo patrón exacto que jobs/pollingOlt.ts: recorre todas las
// empresas (multi-tenant) y dentro de cada una todos sus switches activos.
import { prisma, ejecutarConEmpresa } from "../db";
import { sincronizarSwitch } from "../routes/switches";
import { listarEmpresas } from "../utils/empresas";

const UN_MINUTO_MS = 60_000;
const INTERVALO_MS = (Number(process.env.SWITCH_POLLING_INTERVALO_MINUTOS) || 5) * UN_MINUTO_MS;

// Pausa entre cada switch — con potencialmente MILES de switches (uno por
// cliente, a diferencia de un puñado de OLT), sin esta pausa un ciclo
// dispararía una ráfaga de miles de sesiones SNMP simultáneas.
const PAUSA_ENTRE_SWITCHES_MS = 300;

let corriendoActualmente = false;

function pausa(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sincronizarSwitchesDeEmpresaActual() {
  const switches = await prisma.switchCliente.findMany({ where: { activo: true }, select: { id: true, direccionIp: true } });

  for (const sw of switches) {
    try {
      const resultado = await sincronizarSwitch(sw.id);
      if (resultado.transiciones > 0) {
        console.log(`[polling-switches] ${sw.direccionIp}: ${resultado.puertosUp}/${resultado.totalPuertos} puertos UP, ${resultado.transiciones} transición(es)`);
      }
    } catch (error: any) {
      console.error(`[polling-switches] Error sincronizando switch ${sw.direccionIp}:`, error.message);
    }
    await pausa(PAUSA_ENTRE_SWITCHES_MS);
  }
}

async function correrCicloDePolling() {
  if (corriendoActualmente) {
    console.log("[polling-switches] La corrida anterior todavía no termina, se salta este ciclo.");
    return;
  }

  corriendoActualmente = true;
  try {
    for (const empresa of listarEmpresas()) {
      await ejecutarConEmpresa(empresa.id, sincronizarSwitchesDeEmpresaActual);
    }
  } catch (error: any) {
    console.error("[polling-switches] Error inesperado en el ciclo de polling:", error.message);
  } finally {
    corriendoActualmente = false;
  }
}

// Arranca el job: corre una vez de inmediato y de ahí en adelante cada
// INTERVALO_MS. Se llama una sola vez, al arrancar el servidor (ver index.ts).
export function iniciarPollingSwitches() {
  const minutos = INTERVALO_MS / UN_MINUTO_MS;
  console.log(`[polling-switches] Job activado: sincroniza los switches de cliente registrados cada ${minutos} minuto(s).`);

  correrCicloDePolling();
  setInterval(correrCicloDePolling, INTERVALO_MS);
}
