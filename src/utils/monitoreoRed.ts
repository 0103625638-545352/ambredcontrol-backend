// Monitoreo automático de la red GPON (Centro de Control): historial de
// señal óptica por ONU, detección de cortes masivos por puerto PON y de
// señal degradada por ONU. Lo alimenta sincronizarOlt (routes/olts.ts) en
// cada pasada del polling, y jobs/monitoreoRed.ts revisa la degradación una
// vez por hora.
//
// Las funciones "puras" de arriba (sin I/O) se testean aparte en
// monitoreoRed.test.ts; las de abajo asumen que ya se está DENTRO de
// ejecutarConEmpresa (igual que el resto del código que usa "prisma").
import { prisma, empresaActiva } from "../db";
import { enviarCorreoTextoPlano } from "./email";

// Por debajo de esto una ONU GPON clase B+ ya está al borde de perder
// sincronismo (la sensibilidad típica del receptor es -27/-28 dBm).
export const UMBRAL_SENAL_CRITICA_DBM = Number(process.env.OLT_UMBRAL_SENAL_CRITICA_DBM) || -27;
// Caída respecto al promedio de la propia ONU en los días anteriores que ya
// indica un problema físico (conector sucio, fibra doblada, empalme flojo)
// aunque la señal todavía no llegue al umbral crítico.
export const CAIDA_DB_DEGRADACION = Number(process.env.OLT_CAIDA_DB_DEGRADACION) || 3;
// Mínimo de ONUs del mismo puerto que tienen que caerse en la MISMA pasada
// del polling para considerarlo un corte masivo y no una casualidad.
export const MINIMO_CAIDAS_CORTE_MASIVO = Number(process.env.OLT_MINIMO_CAIDAS_CORTE) || 3;
export const DIAS_RETENCION_LECTURAS = 90;
const MINUTOS_ENTRE_LECTURAS = 55; // ~1 lectura por hora por ONU

export interface EvaluacionSenal {
  degradada: boolean;
  motivo: string | null;
}

// promedioPrevio = promedio de la propia ONU en los días anteriores (null si
// todavía no hay historial suficiente — en ese caso solo aplica el umbral
// crítico absoluto).
export function evaluarSenal(actualDbm: number, promedioPrevioDbm: number | null): EvaluacionSenal {
  if (actualDbm <= UMBRAL_SENAL_CRITICA_DBM) {
    return { degradada: true, motivo: `Señal crítica: ${actualDbm.toFixed(2)} dBm (umbral ${UMBRAL_SENAL_CRITICA_DBM} dBm)` };
  }
  if (promedioPrevioDbm !== null && promedioPrevioDbm - actualDbm >= CAIDA_DB_DEGRADACION) {
    return {
      degradada: true,
      motivo: `Bajó ${(promedioPrevioDbm - actualDbm).toFixed(2)} dB respecto a su promedio (${promedioPrevioDbm.toFixed(2)} → ${actualDbm.toFixed(2)} dBm)`,
    };
  }
  return { degradada: false, motivo: null };
}

// "caidasEnCiclo" = ONUs del puerto que estaban ONLINE en la pasada anterior
// y ahora están OFFLINE; "totalPuerto" = ONUs activas en ese puerto. Exige
// las dos cosas: un mínimo absoluto (para no disparar con 2 casas que
// apagaron el equipo a la vez) y al menos la mitad del puerto (para no
// disparar en un puerto de 64 clientes porque 3 se fueron a dormir).
export function esCorteMasivo(caidasEnCiclo: number, totalPuerto: number): boolean {
  if (totalPuerto <= 0) return false;
  return caidasEnCiclo >= MINIMO_CAIDAS_CORTE_MASIVO && caidasEnCiclo / totalPuerto >= 0.5;
}

// Un corte se da por resuelto cuando quedan menos del 20% del puerto caído
// (algunas casas pueden seguir con el equipo apagado por su cuenta).
export function puertoRecuperado(offlineAhora: number, totalPuerto: number): boolean {
  if (totalPuerto <= 0) return true;
  return offlineAhora / totalPuerto < 0.2;
}

// --- Con base de datos ---

// Guarda una lectura de señal por ONU como máximo cada ~hora. Se llama al
// final de cada sincronizarOlt — best-effort, nunca rompe el polling.
export async function guardarLecturasSenal(oltId: number): Promise<void> {
  try {
    const onus = await prisma.oltOnu.findMany({
      where: { oltId, activo: true, estado: "ONLINE", rxPowerDbm: { not: null } },
      select: { id: true, rxPowerDbm: true },
    });
    if (onus.length === 0) return;

    const ultimas = await prisma.lecturaSenalOnu.groupBy({
      by: ["oltOnuId"],
      where: { oltOnuId: { in: onus.map((o) => o.id) } },
      _max: { fecha: true },
    });
    const ultimaPorOnu = new Map(ultimas.map((u) => [u.oltOnuId, u._max.fecha]));
    const limite = new Date(Date.now() - MINUTOS_ENTRE_LECTURAS * 60_000);

    const nuevas = onus
      .filter((o) => {
        const ultima = ultimaPorOnu.get(o.id);
        return !ultima || ultima < limite;
      })
      .map((o) => ({ oltOnuId: o.id, rxPowerDbm: o.rxPowerDbm! }));

    if (nuevas.length > 0) await prisma.lecturaSenalOnu.createMany({ data: nuevas });
  } catch (error: any) {
    console.error(`[monitoreo-red] No se pudieron guardar las lecturas de señal de la OLT ${oltId}:`, error.message);
  }
}

async function avisarPorCorreo(asunto: string, lineas: string[]): Promise<void> {
  const empresa = empresaActiva();
  const destinatario = (empresa.emailResumenDestinatario || "").trim();
  if (!destinatario) return;
  try {
    await enviarCorreoTextoPlano({ destinatario, asunto: `${asunto} — ${empresa.nombre}`, textoPlano: lineas.join("\n") });
  } catch (error: any) {
    console.error("[monitoreo-red] No se pudo enviar el aviso por correo:", error.message);
  }
}

// Se llama al final de sincronizarOlt con las caídas (ONLINE → OFFLINE) de
// ESTA pasada, agrupadas por puerto PON ("slot.puerto"). Abre una alerta de
// corte masivo por puerto si corresponde, y cierra las que ya se
// recuperaron. Best-effort, igual que guardarLecturasSenal.
export async function evaluarCortesMasivos(oltId: number, nombreOlt: string, caidasPorPuerto: Map<string, number>): Promise<void> {
  try {
    const onus = await prisma.oltOnu.findMany({ where: { oltId, activo: true }, select: { slot: true, puerto: true, estado: true } });
    const conteo = new Map<string, { total: number; offline: number }>();
    for (const o of onus) {
      const clave = `${o.slot}.${o.puerto}`;
      const c = conteo.get(clave) ?? { total: 0, offline: 0 };
      c.total++;
      if (o.estado === "OFFLINE") c.offline++;
      conteo.set(clave, c);
    }

    const abiertas = await prisma.alertaRed.findMany({ where: { oltId, tipo: "CORTE_MASIVO", fechaFin: null } });
    const abiertasPorPuerto = new Map(abiertas.map((a) => [`${a.slot}.${a.puerto}`, a]));

    const nuevas: string[] = [];
    for (const [clave, caidas] of caidasPorPuerto) {
      const c = conteo.get(clave);
      if (!c || !esCorteMasivo(caidas, c.total) || abiertasPorPuerto.has(clave)) continue;
      const [slot, puerto] = clave.split(".").map(Number);
      const mensaje = `${caidas} de ${c.total} ONU(s) del puerto PON ${slot}/${puerto} de ${nombreOlt} se desconectaron a la vez — posible corte de fibra o falla de splitter.`;
      await prisma.alertaRed.create({ data: { tipo: "CORTE_MASIVO", oltId, slot, puerto, cantidadAfectadas: caidas, mensaje } });
      nuevas.push(mensaje);
    }

    for (const alerta of abiertas) {
      const c = conteo.get(`${alerta.slot}.${alerta.puerto}`);
      if (puertoRecuperado(c?.offline ?? 0, c?.total ?? 0)) {
        await prisma.alertaRed.update({ where: { id: alerta.id }, data: { fechaFin: new Date() } });
      }
    }

    if (nuevas.length > 0) {
      console.warn(`[monitoreo-red] ${nuevas.length} corte(s) masivo(s) detectado(s) en ${nombreOlt}.`);
      await avisarPorCorreo(`🚨 Posible corte de fibra en ${nombreOlt}`, [
        "El monitoreo de la OLT detectó caídas simultáneas de clientes en el mismo puerto PON:",
        "",
        ...nuevas.map((m) => `  - ${m}`),
        "",
        "Revisa el Centro de Control para ver los clientes afectados.",
      ]);
    }
  } catch (error: any) {
    console.error(`[monitoreo-red] Error evaluando cortes masivos de la OLT ${oltId}:`, error.message);
  }
}

// Revisión horaria (ver jobs/monitoreoRed.ts): compara la señal actual de
// cada ONU contra su propio promedio de 7 días atrás hasta hace 24h —
// excluye el último día para que una degradación de hoy no "contamine" el
// promedio contra el que se compara. Devuelve cuántas alertas nuevas abrió.
export async function evaluarSenalDegradada(): Promise<number> {
  const ahora = Date.now();
  const desde = new Date(ahora - 7 * 24 * 3600_000);
  const hasta = new Date(ahora - 24 * 3600_000);

  const onus = await prisma.oltOnu.findMany({
    where: { activo: true, estado: "ONLINE", rxPowerDbm: { not: null }, olt: { activo: true } },
    select: { id: true, oltId: true, slot: true, puerto: true, onuIndex: true, serial: true, rxPowerDbm: true, cliente: { select: { razonSocial: true } } },
  });
  if (onus.length === 0) return 0;

  const promedios = await prisma.lecturaSenalOnu.groupBy({
    by: ["oltOnuId"],
    where: { oltOnuId: { in: onus.map((o) => o.id) }, fecha: { gte: desde, lt: hasta } },
    _avg: { rxPowerDbm: true },
    _count: { _all: true },
  });
  // Con menos de 6 lecturas (~6 horas de historial) el promedio todavía no
  // es representativo — solo aplica el umbral crítico absoluto.
  const promedioPorOnu = new Map(
    promedios.filter((p) => p._count._all >= 6 && p._avg.rxPowerDbm !== null).map((p) => [p.oltOnuId, Number(p._avg.rxPowerDbm)])
  );

  const abiertas = await prisma.alertaRed.findMany({ where: { tipo: "SENAL_DEGRADADA", fechaFin: null } });
  const abiertaPorOnu = new Map(abiertas.map((a) => [a.oltOnuId, a]));
  // Una alerta que alguien cerró a mano ("ya lo sé, está programado") no se
  // vuelve a abrir cada hora — queda en silencio una semana para esa ONU.
  const silenciadas = await prisma.alertaRed.findMany({
    where: { tipo: "SENAL_DEGRADADA", cerradaManualmente: true, fechaFin: { gte: desde } },
    select: { oltOnuId: true },
  });
  const onusSilenciadas = new Set(silenciadas.map((a) => a.oltOnuId));

  const nuevas: string[] = [];
  for (const onu of onus) {
    const actual = Number(onu.rxPowerDbm);
    const evaluacion = evaluarSenal(actual, promedioPorOnu.get(onu.id) ?? null);
    const abierta = abiertaPorOnu.get(onu.id);

    if (evaluacion.degradada && !abierta && !onusSilenciadas.has(onu.id)) {
      const quien = onu.cliente?.razonSocial ?? `ONU ${onu.serial}`;
      const mensaje = `${quien} (PON ${onu.slot}/${onu.puerto}, ONU ${onu.onuIndex}): ${evaluacion.motivo}`;
      await prisma.alertaRed.create({
        data: { tipo: "SENAL_DEGRADADA", oltId: onu.oltId, slot: onu.slot, puerto: onu.puerto, oltOnuId: onu.id, mensaje },
      });
      nuevas.push(mensaje);
    } else if (!evaluacion.degradada && abierta) {
      await prisma.alertaRed.update({ where: { id: abierta.id }, data: { fechaFin: new Date() } });
    }
  }

  if (nuevas.length > 0) {
    await avisarPorCorreo(`📉 ${nuevas.length} cliente(s) con señal óptica degradada`, [
      "Estos clientes todavía tienen servicio, pero su señal de fibra se está deteriorando. Conviene revisarlos antes de que se queden sin internet:",
      "",
      ...nuevas.map((m) => `  - ${m}`),
    ]);
  }
  return nuevas.length;
}

export async function depurarLecturasAntiguas(): Promise<number> {
  const limite = new Date(Date.now() - DIAS_RETENCION_LECTURAS * 24 * 3600_000);
  const { count } = await prisma.lecturaSenalOnu.deleteMany({ where: { fecha: { lt: limite } } });
  return count;
}
