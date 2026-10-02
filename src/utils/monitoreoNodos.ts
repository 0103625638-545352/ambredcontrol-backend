// Monitoreo de disponibilidad de los nodos de red (Mikrotik de cada sector).
// Antes, NodoRed.ultimaConexionExitosa solo se actualizaba cuando alguien
// abría la pantalla del Mikrotik — un nodo podía estar caído días sin que
// nadie se enterara. Ahora jobs/monitoreoNodos.ts lo revisa cada pocos
// minutos: guarda cada chequeo (ChequeoNodo, para calcular la disponibilidad)
// y abre/cierra una AlertaRed NODO_CAIDO con aviso por correo.
//
// Para no llenar de falsas alarmas una instalación donde algún nodo nunca
// fue alcanzable desde este servidor (sin VPN, router dado de baja sin
// desactivar, etc.), la alerta solo se abre si el nodo estuvo EN LÍNEA en
// algún chequeo anterior: se avisa la transición "funcionaba → dejó de
// funcionar", no un estado que ya era así desde siempre. Y exige dos
// chequeos fallidos seguidos, para no alarmar por un solo timeout.
//
// Las funciones puras de arriba se testean en monitoreoNodos.test.ts; el
// resto asume que ya se está dentro de ejecutarConEmpresa.
import { prisma, empresaActiva } from "../db";
import { probarConexion, cerrarConexionNodo } from "./mikrotik";
import { enviarCorreoTextoPlano } from "./email";

const TIMEOUT_CHEQUEO_MS = 15_000;
export const FALLOS_SEGUIDOS_PARA_ALERTA = 2;
const DIAS_RETENCION_CHEQUEOS = 90;

// "historial" = chequeos del nodo del más reciente al más antiguo (el
// primero es el que se acaba de hacer).
export function debeAbrirAlerta(historial: { enLinea: boolean }[], estuvoEnLineaAlgunaVez: boolean): boolean {
  if (!estuvoEnLineaAlgunaVez) return false;
  if (historial.length < FALLOS_SEGUIDOS_PARA_ALERTA) return false;
  return historial.slice(0, FALLOS_SEGUIDOS_PARA_ALERTA).every((c) => !c.enLinea);
}

// Porcentaje de chequeos en línea, con un decimal. null si no hay datos.
export function calcularDisponibilidad(enLinea: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((enLinea / total) * 1000) / 10;
}

export function formatearDuracion(minutos: number): string {
  if (minutos < 60) return `${Math.max(1, Math.round(minutos))} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 48) return `${horas} h ${Math.round(minutos % 60)} min`;
  return `${Math.floor(horas / 24)} días ${horas % 24} h`;
}

function conTimeout<T>(promesa: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Sin respuesta en ${ms / 1000} s`)), ms);
    promesa.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function avisar(asunto: string, lineas: string[]): Promise<void> {
  const empresa = empresaActiva();
  const destinatario = (empresa.emailResumenDestinatario || "").trim();
  if (!destinatario) return;
  try {
    await enviarCorreoTextoPlano({ destinatario, asunto: `${asunto} — ${empresa.nombre}`, textoPlano: lineas.join("\n") });
  } catch (error: any) {
    console.error("[monitoreo-nodos] No se pudo enviar el aviso:", error.message);
  }
}

export async function revisarNodosEmpresaActual(): Promise<{ revisados: number; caidos: number }> {
  const nodos = await prisma.nodoRed.findMany({ where: { activo: true }, select: { id: true, nombre: true, mikrotikHost: true } });
  let caidos = 0;

  for (const nodo of nodos) {
    const inicio = Date.now();
    let enLinea = false;
    let error: string | null = null;
    try {
      await conTimeout(probarConexion(nodo.id), TIMEOUT_CHEQUEO_MS);
      enLinea = true;
    } catch (e: any) {
      error = String(e?.message || e).slice(0, 200);
      // Una conexión cacheada medio muerta haría fallar todos los chequeos
      // siguientes aunque el router ya haya vuelto — se descarta.
      await cerrarConexionNodo(nodo.id).catch(() => {});
    }
    const latenciaMs = enLinea ? Date.now() - inicio : null;

    await prisma.chequeoNodo.create({ data: { nodoId: nodo.id, enLinea, latenciaMs, error } });
    if (enLinea) await prisma.nodoRed.update({ where: { id: nodo.id }, data: { ultimaConexionExitosa: new Date() } });
    else caidos++;

    const abierta = await prisma.alertaRed.findFirst({ where: { tipo: "NODO_CAIDO", nodoId: nodo.id, fechaFin: null } });
    const clientes = await prisma.cliente.count({ where: { nodoId: nodo.id, activo: true } });

    if (enLinea && abierta) {
      await prisma.alertaRed.update({ where: { id: abierta.id }, data: { fechaFin: new Date() } });
      const minutos = (Date.now() - abierta.fechaInicio.getTime()) / 60_000;
      await avisar(`✅ El ${nodo.nombre} volvió a responder`, [
        `El ${nodo.nombre} (${nodo.mikrotikHost}) volvió a responder después de ${formatearDuracion(minutos)} sin conexión.`,
        `${clientes} cliente(s) dependen de este nodo.`,
      ]);
      continue;
    }

    if (!enLinea && !abierta) {
      const historial = await prisma.chequeoNodo.findMany({
        where: { nodoId: nodo.id },
        orderBy: { fecha: "desc" },
        take: FALLOS_SEGUIDOS_PARA_ALERTA,
        select: { enLinea: true },
      });
      const estuvoEnLinea = (await prisma.chequeoNodo.count({ where: { nodoId: nodo.id, enLinea: true } })) > 0;
      if (debeAbrirAlerta(historial, estuvoEnLinea)) {
        const mensaje = `El ${nodo.nombre} (${nodo.mikrotikHost}) no responde — ${clientes} cliente(s) de ese sector pueden estar sin servicio. Último error: ${error}`;
        await prisma.alertaRed.create({ data: { tipo: "NODO_CAIDO", nodoId: nodo.id, cantidadAfectadas: clientes, mensaje } });
        console.warn(`[monitoreo-nodos] ${mensaje}`);
        await avisar(`🚨 ${nodo.nombre} sin conexión`, [
          mensaje,
          "",
          "Revisa energía, enlace y el router del nodo. El Centro de Control muestra los clientes afectados.",
        ]);
      }
    }
  }

  const limite = new Date(Date.now() - DIAS_RETENCION_CHEQUEOS * 24 * 3600_000);
  await prisma.chequeoNodo.deleteMany({ where: { fecha: { lt: limite } } });

  return { revisados: nodos.length, caidos };
}
