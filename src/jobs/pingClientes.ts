// Ping ICMP periódico a la IP de cada cliente activo — alimenta el Mapa de
// Red (ver routes/mapaRed.ts, utils/estadoRedCliente.ts). Es un dato
// puramente informativo: nunca dispara suspensión ni ninguna otra lógica de
// negocio (eso lo sigue haciendo jobs/suspensionInternetPorFaltaPago.ts por
// su cuenta). Mismo patrón multiempresa que jobs/pollingOlt.ts.
import { prisma, ejecutarConEmpresa } from "../db";
import { pingHost } from "../utils/pingHost";
import { listarEmpresas } from "../utils/empresas";

const UN_MINUTO_MS = 60_000;
const INTERVALO_MS = (Number(process.env.PING_CLIENTES_INTERVALO_MINUTOS) || 2) * UN_MINUTO_MS;

// Cuántos pings en vuelo al mismo tiempo — con miles de clientes, lanzarlos
// todos a la vez saturaría el proceso (cada uno abre un subproceso "ping"
// del sistema operativo).
const CONCURRENCIA = 25;

let corriendoActualmente = false;

async function pingearEnLotes(clientes: { id: number; direccionIp: string }[]) {
  for (let i = 0; i < clientes.length; i += CONCURRENCIA) {
    const lote = clientes.slice(i, i + CONCURRENCIA);
    await Promise.all(
      lote.map(async (c) => {
        try {
          const resultado = await pingHost(c.direccionIp);
          await prisma.cliente.update({
            where: { id: c.id },
            data: {
              pingUltimoEstado: resultado.alcanzable ? "OK" : "SIN_RESPUESTA",
              pingUltimoMs: resultado.tiempoMs,
              pingUltimaMedicion: new Date(),
            },
          });
        } catch (error: any) {
          console.error(`[ping-clientes] Error al hacer ping a cliente ${c.id} (${c.direccionIp}):`, error.message);
        }
      })
    );
  }
}

async function pingearClientesDeEmpresaActual() {
  const clientes = await prisma.cliente.findMany({
    where: { activo: true, direccionIp: { not: null } },
    select: { id: true, direccionIp: true },
  });
  await pingearEnLotes(clientes as { id: number; direccionIp: string }[]);
}

// Multiempresa: mismo criterio que los demás jobs — "prisma" solo resuelve a
// la base correcta mientras estamos DENTRO de ejecutarConEmpresa.
async function correrCicloDePing() {
  if (corriendoActualmente) {
    console.log("[ping-clientes] La corrida anterior todavía no termina, se salta este ciclo.");
    return;
  }

  corriendoActualmente = true;
  try {
    for (const empresa of listarEmpresas()) {
      await ejecutarConEmpresa(empresa.id, pingearClientesDeEmpresaActual);
    }
  } catch (error: any) {
    console.error("[ping-clientes] Error inesperado en el ciclo de ping:", error.message);
  } finally {
    corriendoActualmente = false;
  }
}

export function iniciarPingClientes() {
  const minutos = INTERVALO_MS / UN_MINUTO_MS;
  console.log(`[ping-clientes] Job activado: hace ping a los clientes con IP cada ${minutos} minuto(s).`);

  correrCicloDePing();
  setInterval(correrCicloDePing, INTERVALO_MS);
}
