// Alerta dedicada e inmediata (no espera al resumen diario a las
// RESUMEN_DIARIO_HORA) para comprobantes SRI atascados en ENVIADA más allá
// de un umbral. El job de reintentos (jobs/reintentoAutorizacionSri.ts) ya
// los reintenta cada pocos minutos, así que si un comprobante sigue
// atascado pasado el umbral, sobrevivió muchos reintentos sin resolverse —
// es la señal más alarmante que puede dar el sistema (SRI caído, certificado
// que dejó de servir a medio camino, etc.) y alguien debe enterarse el mismo
// día, no mezclado con cuentas por cobrar y stock en el resumen de la tarde.
//
// Mismo patrón de "revisar cada 15 minutos" que alertaVencimientosProximos.ts,
// pero a diferencia de ese (que solo manda a una hora fija configurada), acá
// se manda apenas se detecta algo atascado — como mucho un aviso por día por
// empresa, para no repetir el mismo correo cada 15 minutos mientras el
// problema sigue sin resolverse.
import { ejecutarConEmpresa, empresaActiva } from "../db";
import { listarEmpresas } from "../utils/empresas";
import { enviarCorreoTextoPlano } from "../utils/email";
import { obtenerDocumentosSriAtascados, type DocumentoSriAtascado } from "../utils/alertasNegocio";

const QUINCE_MINUTOS_MS = 15 * 60_000;
const UMBRAL_MINUTOS = Number(process.env.SRI_ALERTA_ATASCO_MINUTOS) || 60;

const ETIQUETA_TIPO: Record<DocumentoSriAtascado["tipo"], string> = {
  FACTURA: "Factura",
  NOTA_CREDITO: "Nota de crédito",
  RETENCION: "Retención",
  GUIA_REMISION: "Guía de remisión",
};

// Fecha (YYYY-MM-DD) del último aviso YA MANDADO, por empresa — a diferencia
// de resumenDiario.ts/alertaVencimientosProximos.ts (un solo string
// compartido, porque procesan todas las empresas en la misma pasada a una
// hora fija), acá cada empresa puede cruzar el umbral en un momento distinto
// dentro de la misma revisión de 15 minutos, así que el control es por
// empresa.
const ultimaFechaEnviadaPorEmpresa = new Map<string, string>();

function fechaLocalYMD(fecha: Date): string {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Revisa y (si corresponde) manda el aviso de la empresa ACTIVA — debe
// llamarse desde dentro de ejecutarConEmpresa. Devuelve true si se mandó.
// Exportada aparte para poder probarla directo, sin esperar al reloj, mismo
// criterio que componerYEnviarResumenEmpresa/componerYEnviarAlertaVencimientos.
export async function revisarYAlertarSriAtascadoEmpresaActiva(): Promise<boolean> {
  const empresa = empresaActiva();
  const destinatario = (empresa.emailResumenDestinatario || "").trim();
  if (!destinatario) return false;

  const hoy = fechaLocalYMD(new Date());
  if (ultimaFechaEnviadaPorEmpresa.get(empresa.id) === hoy) return false;

  const atascados = await obtenerDocumentosSriAtascados(UMBRAL_MINUTOS);
  if (atascados.length === 0) return false;

  const lineas: string[] = [];
  lineas.push(`${atascados.length} comprobante(s) llevan más de ${UMBRAL_MINUTOS} minuto(s) sin autorizarse — ${empresa.nombre} (${hoy})`);
  lineas.push("");
  lineas.push("El sistema ya los reintenta automáticamente cada pocos minutos; si siguen así, revisa el estado del servicio del SRI o el certificado.");
  lineas.push("");
  for (const d of atascados) {
    lineas.push(`  - ${ETIQUETA_TIPO[d.tipo]} ${d.secuencial} · atascado hace ${d.minutosAtascado} minuto(s)`);
  }

  const enviado = await enviarCorreoTextoPlano({
    destinatario,
    asunto: `⚠️ ${atascados.length} comprobante(s) atascado(s) sin autorizar — ${empresa.nombre}`,
    textoPlano: lineas.join("\n"),
  });

  if (enviado) ultimaFechaEnviadaPorEmpresa.set(empresa.id, hoy);
  return enviado;
}

async function revisarTodasLasEmpresas() {
  for (const empresa of listarEmpresas()) {
    try {
      await ejecutarConEmpresa(empresa.id, () => revisarYAlertarSriAtascadoEmpresaActiva());
    } catch (error: any) {
      console.error(`[alerta-sri-atascado] Error revisando "${empresa.nombre}":`, error.message);
    }
  }
}

export function iniciarAlertaSriAtascado(): void {
  console.log(
    `[alerta-sri-atascado] Job activado: revisa cada 15 minutos si hay comprobantes atascados más de ${UMBRAL_MINUTOS} minuto(s) sin autorizar (máximo un aviso por día por empresa).`
  );
  setInterval(revisarTodasLasEmpresas, QUINCE_MINUTOS_MS);
}
