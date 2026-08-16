// Aviso propio y enfocado de cobros (facturas/notas de venta a clientes) Y
// pagos (compras a proveedores) que están a pocos días de vencer — a
// diferencia de jobs/resumenDiario.ts (que ya lista TODAS las cuentas por
// cobrar pendientes mezcladas con stock bajo, certificado, etc.), esto manda
// un correo aparte solo cuando hay algo cerca de su vencimiento, para que no
// se pierda como una línea más en un resumen largo.
//
// Mismo criterio que resumenDiario.ts/backupDiario.ts: NO corre de
// inmediato al arrancar el servidor, solo revisa cada 15 minutos si ya es
// la hora y si no se ejecutó todavía hoy.
import { ejecutarConEmpresa, empresaActiva, prisma } from "../db";
import { listarEmpresas } from "../utils/empresas";
import { enviarCorreoTextoPlano } from "../utils/email";
import { obtenerCuentasProximasAVencer, obtenerCuentasPorPagarProximasAVencer } from "../utils/alertasNegocio";
import { calcularDiasParaVencer } from "../utils/vencimientos";

const QUINCE_MINUTOS_MS = 15 * 60_000;

let ultimaFechaEnviada: string | null = null;

function fechaLocalYMD(fecha: Date): string {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Arma y manda el aviso de la empresa ACTIVA (debe llamarse desde dentro de
// ejecutarConEmpresa). Devuelve true si se mandó el correo, false si se
// omitió (sin destinatario configurado, sin SMTP configurado, o sin ningún
// documento por vencer pronto). Exportada aparte para poder probarla
// directo, sin esperar al reloj — mismo criterio que
// componerYEnviarResumenEmpresa en resumenDiario.ts.
export async function componerYEnviarAlertaVencimientos(): Promise<boolean> {
  const empresa = empresaActiva();
  const destinatario = (empresa.emailResumenDestinatario || "").trim();
  if (!destinatario) {
    console.log(`[alerta-vencimientos] "${empresa.nombre}" no tiene correo de resumen configurado — se omite el envío.`);
    return false;
  }

  const umbralDias = Number(process.env.ALERTA_VENCIMIENTOS_DIAS_ANTES) || 3;
  const proximas = await obtenerCuentasProximasAVencer(umbralDias);
  const proximasPorPagar = await obtenerCuentasPorPagarProximasAVencer(umbralDias);

  // Cuotas de un plan a plazos (ver modelo Cuota) que vencen pronto — control
  // de proximidad por CUOTA individual, no por documento completo (ver
  // GET /reportes/cuotas-por-cobrar y /reportes/cuotas-por-pagar para el
  // detalle en pantalla). Una sola consulta trae las de cobro Y las de pago
  // — cuál relación viene no-nula (factura/notaVenta vs. compra) distingue
  // el tipo, mismo criterio que Pago.
  const ahora = new Date();
  const cuotasPendientes = await prisma.cuota.findMany({
    where: { estado: "PENDIENTE" },
    include: {
      factura: { select: { secuencial: true, cliente: { select: { razonSocial: true } } } },
      notaVenta: { select: { secuencial: true, cliente: { select: { razonSocial: true } } } },
      compra: { select: { numeroFactura: true, proveedor: { select: { razonSocial: true } } } },
    },
    orderBy: { fechaVencimiento: "asc" },
  });
  const cuotasProximas = cuotasPendientes.filter((c: (typeof cuotasPendientes)[number]) => {
    const dias = calcularDiasParaVencer(c.fechaVencimiento, ahora);
    return dias !== null && dias <= umbralDias;
  });
  const cuotasCobroProximas = cuotasProximas.filter((c: (typeof cuotasProximas)[number]) => !c.compra);
  const cuotasPagoProximas = cuotasProximas.filter((c: (typeof cuotasProximas)[number]) => c.compra);

  // Un aviso de "no hay nada por vencer" sería puro ruido diario — a
  // diferencia del resumen general (que sí siempre se manda por ser un
  // digest), este correo solo tiene sentido cuando hay algo que avisar.
  if (proximas.length === 0 && proximasPorPagar.length === 0 && cuotasProximas.length === 0) {
    return false;
  }

  const lineas: string[] = [];
  lineas.push(`Cobros y pagos que vencen en ${umbralDias} día(s) o menos — ${empresa.nombre} (${fechaLocalYMD(new Date())})`);

  if (proximas.length > 0) {
    lineas.push("");
    lineas.push("Documentos por cobrar:");
    for (const c of proximas) {
      const fecha = c.fechaVencimiento ? new Date(c.fechaVencimiento).toISOString().slice(0, 10) : "—";
      lineas.push(
        `  - ${c.tipo === "FACTURA" ? "Factura" : "Nota de venta"} ${c.secuencial} · ${c.clienteNombre} · saldo $${c.saldo} · vence ${fecha}`
      );
    }
  }
  if (cuotasCobroProximas.length > 0) {
    lineas.push("");
    lineas.push("Cuotas por cobrar (planes a plazos con clientes):");
    for (const c of cuotasCobroProximas) {
      const documento = c.factura ?? c.notaVenta;
      const tipoTexto = c.factura ? "Factura" : "Nota de venta";
      const fecha = c.fechaVencimiento.toISOString().slice(0, 10);
      lineas.push(
        `  - ${tipoTexto} ${documento!.secuencial} · ${documento!.cliente.razonSocial} · cuota ${c.numero} · $${c.monto.toFixed(2)} · vence ${fecha}`
      );
    }
  }
  if (proximasPorPagar.length > 0) {
    lineas.push("");
    lineas.push("Compras por pagar:");
    for (const c of proximasPorPagar) {
      const fecha = c.fechaVencimiento ? new Date(c.fechaVencimiento).toISOString().slice(0, 10) : "—";
      lineas.push(`  - Compra ${c.numeroFactura} · ${c.proveedorNombre} · saldo $${c.saldo} · vence ${fecha}`);
    }
  }
  if (cuotasPagoProximas.length > 0) {
    lineas.push("");
    lineas.push("Cuotas por pagar (planes a plazos con proveedores):");
    for (const c of cuotasPagoProximas) {
      const fecha = c.fechaVencimiento.toISOString().slice(0, 10);
      lineas.push(
        `  - Compra ${c.compra!.numeroFactura} · ${c.compra!.proveedor.razonSocial} · cuota ${c.numero} · $${c.monto.toFixed(2)} · vence ${fecha}`
      );
    }
  }

  const totalAvisos = proximas.length + proximasPorPagar.length + cuotasProximas.length;
  return enviarCorreoTextoPlano({
    destinatario,
    asunto: `⏰ ${totalAvisos} aviso(s) de cobro/pago en ${umbralDias} día(s) o menos — ${empresa.nombre}`,
    textoPlano: lineas.join("\n"),
  });
}

async function enviarAlertaVencimientosTodasLasEmpresas() {
  for (const empresa of listarEmpresas()) {
    try {
      await ejecutarConEmpresa(empresa.id, () => componerYEnviarAlertaVencimientos());
    } catch (error: any) {
      console.error(`[alerta-vencimientos] Error armando el aviso de "${empresa.nombre}":`, error.message);
    }
  }
}

function debeEnviarAhora(): boolean {
  const horaConfigurada = Number(process.env.ALERTA_VENCIMIENTOS_HORA);
  if (Number.isNaN(horaConfigurada)) return false;

  const ahora = new Date();
  if (ahora.getHours() !== horaConfigurada) return false;

  const hoy = fechaLocalYMD(ahora);
  return hoy !== ultimaFechaEnviada;
}

async function revisarSiTocaEnviar() {
  if (!debeEnviarAhora()) return;

  ultimaFechaEnviada = fechaLocalYMD(new Date());
  console.log("[alerta-vencimientos] Revisando vencimientos próximos de todas las empresas...");
  await enviarAlertaVencimientosTodasLasEmpresas();
}

export function iniciarAlertaVencimientosProximos(): void {
  console.log("[alerta-vencimientos] Job activado: revisa cada 15 minutos si toca enviar el aviso de vencimientos próximos.");
  setInterval(revisarSiTocaEnviar, QUINCE_MINUTOS_MS);
}
