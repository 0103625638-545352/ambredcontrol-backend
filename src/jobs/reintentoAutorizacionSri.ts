// Reintento automático de autorización SRI.
//
// Recordatorio del flujo: cuando se envía un comprobante (factura o nota de
// crédito) al SRI, "Recepción" solo revisa que la estructura/firma estén
// bien, y "Autorización" es donde se valida todo a fondo. El SRI a veces
// tarda en terminar esa validación, así que si consultamos Autorización
// demasiado pronto, la respuesta es "EN_PROCESO" — ni autorizado ni
// rechazado, solo "todavía no termino".
//
// Antes, si un comprobante quedaba "EN_PROCESO", alguien tenía que acordarse
// de volver más tarde y pedir "consultar autorización" a mano. Este job
// corre en segundo plano cada cierto tiempo y hace esa consulta automática
// por todos los comprobantes en estado ENVIADA — sin que nadie tenga que
// entrar a preguntar.

import { prisma, ejecutarConEmpresa } from "../db";
import { verificarYActualizarAutorizacionFactura, enviarFacturaAlSri } from "../routes/facturas";
import { verificarYActualizarAutorizacionNotaCredito, enviarNotaCreditoAlSri } from "../routes/notasCredito";
import { verificarYActualizarAutorizacionRetencion, enviarRetencionAlSri } from "../routes/retenciones";
import { verificarYActualizarAutorizacionGuiaRemision, enviarGuiaRemisionAlSri } from "../routes/guiasRemision";
import { listarEmpresas } from "../utils/empresas";

const UN_MINUTO_MS = 60_000;
const INTERVALO_MS = (Number(process.env.SRI_REINTENTO_INTERVALO_MINUTOS) || 5) * UN_MINUTO_MS;

// Pausa entre cada consulta individual, para no bombardear el servicio del
// SRI si hay muchos comprobantes pendientes a la vez.
const PAUSA_ENTRE_CONSULTAS_MS = 1500;

// Evita que dos corridas se pisen si una consulta al SRI tarda más que el
// intervalo entre corridas (ej. el servicio del SRI está lento ese día).
let corriendoActualmente = false;

function pausa(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reintentarFacturasPendientes() {
  const pendientes = await prisma.factura.findMany({
    where: { estado: "ENVIADA" },
    select: { id: true, secuencial: true },
  });

  for (const f of pendientes) {
    try {
      const resultado = await verificarYActualizarAutorizacionFactura(f.id);
      if (resultado && resultado.estado !== "EN_PROCESO") {
        console.log(`[reintento-sri] Factura ${f.secuencial}: ahora ${resultado.estado}`);
      }
    } catch (error: any) {
      console.error(`[reintento-sri] Error consultando factura ${f.secuencial}:`, error.message);
    }
    await pausa(PAUSA_ENTRE_CONSULTAS_MS);
  }
}

const DOS_MINUTOS_MS = 2 * UN_MINUTO_MS;

// Red de seguridad del envío automático (ver el fire-and-forget al final de
// POST /facturas): si por lo que sea (sin certificado en ese momento, corte
// de internet, el server se reinició a medio proceso) una factura se quedó
// en CREADA sin siquiera llegar a intentarse, esto la recoge y la reintenta.
// El margen de 2 minutos evita pisarle el envío a una factura recién creada
// que todavía puede estar en pleno vuelo desde ese fire-and-forget.
async function reintentarFacturasCreadasSinEnviar() {
  const pendientes = await prisma.factura.findMany({
    where: { estado: "CREADA", claveAcceso: { not: null }, createdAt: { lte: new Date(Date.now() - DOS_MINUTOS_MS) } },
    select: { id: true, secuencial: true },
  });

  for (const f of pendientes) {
    try {
      const resultado = await enviarFacturaAlSri(f.id);
      console.log(`[reintento-sri] Factura ${f.secuencial} nunca se había enviado — ahora: ${resultado.paso}`);
    } catch (error: any) {
      console.error(`[reintento-sri] Error reenviando factura ${f.secuencial} que seguía en CREADA:`, error.message);
    }
    await pausa(PAUSA_ENTRE_CONSULTAS_MS);
  }
}

async function reintentarNotasCreditoPendientes() {
  const pendientes = await prisma.notaCredito.findMany({
    where: { estado: "ENVIADA" },
    select: { id: true, secuencial: true },
  });

  for (const n of pendientes) {
    try {
      const resultado = await verificarYActualizarAutorizacionNotaCredito(n.id);
      if (resultado && resultado.estado !== "EN_PROCESO") {
        console.log(`[reintento-sri] Nota de crédito ${n.secuencial}: ahora ${resultado.estado}`);
      }
    } catch (error: any) {
      console.error(`[reintento-sri] Error consultando nota de crédito ${n.secuencial}:`, error.message);
    }
    await pausa(PAUSA_ENTRE_CONSULTAS_MS);
  }
}

// Red de seguridad del envío automático de notas de crédito — mismo criterio
// que reintentarFacturasCreadasSinEnviar.
async function reintentarNotasCreditoCreadasSinEnviar() {
  const pendientes = await prisma.notaCredito.findMany({
    where: { estado: "CREADA", claveAcceso: { not: null }, createdAt: { lte: new Date(Date.now() - DOS_MINUTOS_MS) } },
    select: { id: true, secuencial: true },
  });

  for (const n of pendientes) {
    try {
      const resultado = await enviarNotaCreditoAlSri(n.id);
      console.log(`[reintento-sri] Nota de crédito ${n.secuencial} nunca se había enviado — ahora: ${resultado.paso}`);
    } catch (error: any) {
      console.error(`[reintento-sri] Error reenviando nota de crédito ${n.secuencial} que seguía en CREADA:`, error.message);
    }
    await pausa(PAUSA_ENTRE_CONSULTAS_MS);
  }
}

async function reintentarRetencionesPendientes() {
  const pendientes = await prisma.retencion.findMany({
    where: { estado: "ENVIADA" },
    select: { id: true, secuencial: true },
  });

  for (const r of pendientes) {
    try {
      const resultado = await verificarYActualizarAutorizacionRetencion(r.id);
      if (resultado && resultado.estado !== "EN_PROCESO") {
        console.log(`[reintento-sri] Retención ${r.secuencial}: ahora ${resultado.estado}`);
      }
    } catch (error: any) {
      console.error(`[reintento-sri] Error consultando retención ${r.secuencial}:`, error.message);
    }
    await pausa(PAUSA_ENTRE_CONSULTAS_MS);
  }
}

// Red de seguridad del envío automático de retenciones — mismo criterio que
// reintentarFacturasCreadasSinEnviar.
async function reintentarRetencionesCreadasSinEnviar() {
  const pendientes = await prisma.retencion.findMany({
    where: { estado: "CREADA", claveAcceso: { not: null }, createdAt: { lte: new Date(Date.now() - DOS_MINUTOS_MS) } },
    select: { id: true, secuencial: true },
  });

  for (const r of pendientes) {
    try {
      const resultado = await enviarRetencionAlSri(r.id);
      console.log(`[reintento-sri] Retención ${r.secuencial} nunca se había enviado — ahora: ${resultado.paso}`);
    } catch (error: any) {
      console.error(`[reintento-sri] Error reenviando retención ${r.secuencial} que seguía en CREADA:`, error.message);
    }
    await pausa(PAUSA_ENTRE_CONSULTAS_MS);
  }
}

async function reintentarGuiasRemisionPendientes() {
  const pendientes = await prisma.guiaRemision.findMany({
    where: { estado: "ENVIADA" },
    select: { id: true, secuencial: true },
  });

  for (const g of pendientes) {
    try {
      const resultado = await verificarYActualizarAutorizacionGuiaRemision(g.id);
      if (resultado && resultado.estado !== "EN_PROCESO") {
        console.log(`[reintento-sri] Guía de remisión ${g.secuencial}: ahora ${resultado.estado}`);
      }
    } catch (error: any) {
      console.error(`[reintento-sri] Error consultando guía de remisión ${g.secuencial}:`, error.message);
    }
    await pausa(PAUSA_ENTRE_CONSULTAS_MS);
  }
}

// Red de seguridad del envío automático de guías de remisión — mismo
// criterio que reintentarFacturasCreadasSinEnviar.
async function reintentarGuiasRemisionCreadasSinEnviar() {
  const pendientes = await prisma.guiaRemision.findMany({
    where: { estado: "CREADA", claveAcceso: { not: null }, createdAt: { lte: new Date(Date.now() - DOS_MINUTOS_MS) } },
    select: { id: true, secuencial: true },
  });

  for (const g of pendientes) {
    try {
      const resultado = await enviarGuiaRemisionAlSri(g.id);
      console.log(`[reintento-sri] Guía de remisión ${g.secuencial} nunca se había enviado — ahora: ${resultado.paso}`);
    } catch (error: any) {
      console.error(`[reintento-sri] Error reenviando guía de remisión ${g.secuencial} que seguía en CREADA:`, error.message);
    }
    await pausa(PAUSA_ENTRE_CONSULTAS_MS);
  }
}

// Multiempresa: cada empresa tiene su propia base de datos, así que este
// ciclo recorre TODAS las empresas registradas, una por una — "prisma" (el
// import de arriba) solo resuelve a la base correcta mientras estamos DENTRO
// de ejecutarConEmpresa, por eso ambas funciones de reintento se llaman
// adentro de ese callback, nunca sueltas.
async function correrCicloDeReintentos() {
  if (corriendoActualmente) {
    console.log("[reintento-sri] La corrida anterior todavía no termina, se salta este ciclo.");
    return;
  }

  corriendoActualmente = true;
  try {
    for (const empresa of listarEmpresas()) {
      await ejecutarConEmpresa(empresa.id, async () => {
        await reintentarFacturasPendientes();
        await reintentarFacturasCreadasSinEnviar();
        await reintentarNotasCreditoPendientes();
        await reintentarNotasCreditoCreadasSinEnviar();
        await reintentarRetencionesPendientes();
        await reintentarRetencionesCreadasSinEnviar();
        await reintentarGuiasRemisionPendientes();
        await reintentarGuiasRemisionCreadasSinEnviar();
      });
    }
  } catch (error: any) {
    console.error("[reintento-sri] Error inesperado en el ciclo de reintentos:", error.message);
  } finally {
    corriendoActualmente = false;
  }
}

// Arranca el job: corre una vez de inmediato (por si quedó algo pendiente de
// antes de que el servidor se reiniciara) y de ahí en adelante cada
// INTERVALO_MS. Se llama una sola vez, al arrancar el servidor (ver index.ts).
export function iniciarReintentoAutorizacionSri() {
  const minutos = INTERVALO_MS / UN_MINUTO_MS;
  console.log(`[reintento-sri] Job activado: reintenta autorizaciones pendientes cada ${minutos} minuto(s).`);

  correrCicloDeReintentos();
  setInterval(correrCicloDeReintentos, INTERVALO_MS);
}
