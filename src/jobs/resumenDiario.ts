// Resumen diario por correo: cuentas por cobrar pendientes, stock bajo,
// comprobantes atascados sin autorizar y aviso de certificado por caducar —
// las mismas cuatro cosas que ya se ven en vivo en el Dashboard (ver
// utils/alertasNegocio.ts, que es donde vive el cálculo real), mandadas una
// vez al día para quien no entra a mirar la pantalla todos los días.
//
// A diferencia del job de reintentos SRI (jobs/reintentoAutorizacionSri.ts),
// este NO corre inmediatamente al arrancar el servidor: ese job "pone al día"
// trabajo pendiente sin importar la hora, pero acá correr en cada reinicio
// mandaría correos duplicados sin relación con la hora configurada. Por eso
// solo revisa cada 15 minutos si ya es la hora y si no se mandó todavía hoy.

import { ejecutarConEmpresa, empresaActiva } from "../db";
import { listarEmpresas } from "../utils/empresas";
import { enviarCorreoTextoPlano } from "../utils/email";
import {
  obtenerStockBajo,
  obtenerCuentasPorCobrarPendientes,
  obtenerDocumentosPendientesAutorizacion,
  obtenerCertificadoPorCaducar,
  obtenerCertificadoInvalido,
  obtenerEstadoBackupBaseDatos,
} from "../utils/alertasNegocio";

const QUINCE_MINUTOS_MS = 15 * 60_000;

// Fecha (YYYY-MM-DD, hora local) del último envío — evita mandar el resumen
// dos veces el mismo día si el reloj sigue cayendo dentro de la hora
// configurada en revisiones sucesivas.
let ultimaFechaEnviada: string | null = null;

function fechaLocalYMD(fecha: Date): string {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Arma y manda el resumen de la empresa ACTIVA (debe llamarse desde dentro de
// ejecutarConEmpresa). Devuelve true si se intentó el envío, false si se
// omitió (sin destinatario configurado para ESTA empresa, o sin SMTP
// configurado — ambos casos ya los distingue enviarCorreoTextoPlano).
// Exportada aparte para poder probarla directo, sin esperar al reloj.
export async function componerYEnviarResumenEmpresa(): Promise<boolean> {
  const empresa = empresaActiva();
  const destinatario = (empresa.emailResumenDestinatario || "").trim();
  if (!destinatario) {
    console.log(`[resumen-diario] "${empresa.nombre}" no tiene correo de resumen configurado — se omite el envío.`);
    return false;
  }

  const [cuentasPorCobrar, stockBajo, documentosPendientes] = await Promise.all([
    obtenerCuentasPorCobrarPendientes(),
    obtenerStockBajo(),
    obtenerDocumentosPendientesAutorizacion(),
  ]);
  const certificadoPorCaducar = obtenerCertificadoPorCaducar();
  const certificadoInvalido = obtenerCertificadoInvalido();

  const lineas: string[] = [];
  lineas.push(`Resumen diario — ${empresa.nombre} (${fechaLocalYMD(new Date())})`);
  lineas.push("");

  const totalPorCobrar = cuentasPorCobrar.reduce((acc, c) => acc + Number(c.saldo), 0);
  lineas.push(`CUENTAS POR COBRAR PENDIENTES: ${cuentasPorCobrar.length} documento(s), $${totalPorCobrar.toFixed(2)}`);
  for (const c of cuentasPorCobrar.slice(0, 20)) {
    lineas.push(`  - ${c.tipo === "FACTURA" ? "Factura" : "Nota de venta"} ${c.secuencial} · ${c.clienteNombre} · saldo $${c.saldo}`);
  }
  if (cuentasPorCobrar.length > 20) lineas.push(`  ... y ${cuentasPorCobrar.length - 20} más.`);
  lineas.push("");

  lineas.push(`STOCK BAJO: ${stockBajo.length} producto(s)`);
  for (const p of stockBajo.slice(0, 20)) {
    const sucursal = p.sucursalNombre ? ` (${p.sucursalNombre})` : "";
    lineas.push(`  - ${p.productoNombre}${sucursal}: ${p.stockActual} / mínimo ${p.stockMinimo}`);
  }
  if (stockBajo.length > 20) lineas.push(`  ... y ${stockBajo.length - 20} más.`);
  lineas.push("");

  lineas.push(`COMPROBANTES SIN AUTORIZAR (atascados en ENVIADA): ${documentosPendientes.length}`);
  for (const d of documentosPendientes.slice(0, 20)) {
    lineas.push(`  - ${d.tipo === "FACTURA" ? "Factura" : "Nota de crédito"} ${d.secuencial}`);
  }
  if (documentosPendientes.length > 20) lineas.push(`  ... y ${documentosPendientes.length - 20} más.`);
  lineas.push("");

  if (certificadoInvalido) {
    lineas.push(`CERTIFICADO SRI: ¡NO SE PUEDE USAR! ${certificadoInvalido.motivo} — nada se firma/envía hasta que se solucione.`);
  } else if (certificadoPorCaducar) {
    lineas.push(
      certificadoPorCaducar.vencido
        ? `CERTIFICADO SRI: VENCIDO desde hace ${Math.abs(certificadoPorCaducar.diasRestantes)} día(s) (${certificadoPorCaducar.fechaExpiracion.toISOString().slice(0, 10)}).`
        : `CERTIFICADO SRI: vence en ${certificadoPorCaducar.diasRestantes} día(s) (${certificadoPorCaducar.fechaExpiracion.toISOString().slice(0, 10)}).`
    );
  } else {
    lineas.push("CERTIFICADO SRI: sin novedad.");
  }

  // Solo se avisa si el respaldo automático está configurado — sin
  // BACKUP_DB_PATH, "atrasado" sería siempre true y sería puro ruido.
  if (process.env.BACKUP_DB_PATH) {
    const backup = obtenerEstadoBackupBaseDatos();
    lineas.push(
      backup.atrasado
        ? `RESPALDO DE BASE DE DATOS: ATRASADO${backup.ultimoExitoso ? ` (último exitoso: ${backup.ultimoExitoso.slice(0, 10)})` : " (todavía no se ha completado ninguno)"}.`
        : `RESPALDO DE BASE DE DATOS: al día (último exitoso: ${backup.ultimoExitoso!.slice(0, 10)}).`
    );
  }

  return enviarCorreoTextoPlano({
    destinatario,
    asunto: `Resumen diario — ${empresa.nombre}`,
    textoPlano: lineas.join("\n"),
  });
}

async function enviarResumenDiarioTodasLasEmpresas() {
  for (const empresa of listarEmpresas()) {
    try {
      await ejecutarConEmpresa(empresa.id, () => componerYEnviarResumenEmpresa());
    } catch (error: any) {
      console.error(`[resumen-diario] Error armando el resumen de "${empresa.nombre}":`, error.message);
    }
  }
}

function debeEnviarAhora(): boolean {
  const horaConfigurada = Number(process.env.RESUMEN_DIARIO_HORA);
  if (Number.isNaN(horaConfigurada)) return false;

  const ahora = new Date();
  if (ahora.getHours() !== horaConfigurada) return false;

  const hoy = fechaLocalYMD(ahora);
  return hoy !== ultimaFechaEnviada;
}

async function revisarSiTocaEnviar() {
  if (!debeEnviarAhora()) return;

  ultimaFechaEnviada = fechaLocalYMD(new Date());
  console.log("[resumen-diario] Armando y enviando el resumen diario de todas las empresas...");
  await enviarResumenDiarioTodasLasEmpresas();
}

// Arranca el job: NO corre de inmediato (ver comentario arriba), solo agenda
// la revisión periódica. Se llama una sola vez, al arrancar el servidor.
export function iniciarResumenDiario() {
  console.log("[resumen-diario] Job activado: revisa cada 15 minutos si toca enviar el resumen diario.");
  setInterval(revisarSiTocaEnviar, QUINCE_MINUTOS_MS);
}
