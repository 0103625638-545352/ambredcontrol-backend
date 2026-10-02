// Recordatorio de "tu plan de internet vence pronto" por WhatsApp — avisa
// ANTES de que el cliente llegue al corte automático (ver
// jobs/suspensionInternetPorFaltaPago.ts), para darle oportunidad de pagar
// sin perder el servicio. Usa el MISMO cálculo de ciclo/día límite que ese
// job (ver utils/gestionServicioInternet.ts) — nunca debe decir "vence en 3
// días" con una cuenta distinta a la que en verdad corta el servicio.
//
// Mismo criterio "una vez al día, a la hora configurada" que
// jobs/alertaVencimientosProximos.ts, MÁS un registro en base de datos
// (RecordatorioInternetEnviado) para no duplicar el mensaje si el servidor
// se reinicia justo después de haberlo mandado — a diferencia de un aviso
// interno por correo, acá sí importa: es un mensaje real a un cliente real,
// no un resumen para el negocio.
//
// A diferencia de esos otros jobs (una sola hora para TODAS las empresas),
// acá la hora es editable POR EMPRESA (ver EmpresaConfig.whatsappRecordatorioHora
// en utils/empresas.ts, autoservicio desde Ajustes) — WHATSAPP_RECORDATORIO_HORA
// en .env queda solo como el default para quien no fije el suyo. Por eso el
// "ya revisé hoy" también se trackea por empresa (Map), no con una sola
// fecha global.
import { prisma, ejecutarConEmpresa, empresaActiva } from "../db";
import { listarEmpresas, whatsappConfigurado, type EmpresaConfig } from "../utils/empresas";
import { enviarPlantillaWhatsapp } from "../utils/whatsapp";
import { pagoDeEsteCiclo, enPrimerCiclo, ventanaCicloActual, fechaLimitePago } from "../utils/gestionServicioInternet";
import { calcularDiasParaVencer } from "../utils/vencimientos";

const QUINCE_MINUTOS_MS = 15 * 60_000;

const ultimaFechaRevisadaPorEmpresa = new Map<string, string>();

function fechaLocalYMD(fecha: Date): string {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function debeRevisarAhora(empresa: EmpresaConfig): boolean {
  const horaConfigurada = empresa.whatsappRecordatorioHora ?? Number(process.env.WHATSAPP_RECORDATORIO_HORA);
  if (Number.isNaN(horaConfigurada)) return false;

  const ahora = new Date();
  if (ahora.getHours() !== horaConfigurada) return false;

  const hoy = fechaLocalYMD(ahora);
  return hoy !== ultimaFechaRevisadaPorEmpresa.get(empresa.id);
}

// Revisa los clientes de internet de la empresa ACTIVA (debe llamarse desde
// dentro de ejecutarConEmpresa) y manda el recordatorio a quien esté
// exactamente a "diasAntes" días de su límite de pago, todavía no haya
// pagado este ciclo, y no se le haya avisado ya este mismo ciclo. Exportada
// aparte para poder probarla directo, sin esperar al reloj — mismo criterio
// que el resto de jobs/alerta*.ts. "diasAntes" default 3 si esta empresa no
// fijó el suyo propio (ver EmpresaConfig.whatsappRecordatorioDiasAntes).
export async function revisarClientesDeLaEmpresa(): Promise<void> {
  const empresa = empresaActiva();
  if (!whatsappConfigurado(empresa)) {
    console.log(`[recordatorio-internet] "${empresa.nombre}" no tiene WhatsApp Business configurado — se omite.`);
    return;
  }
  const diasAntes = empresa.whatsappRecordatorioDiasAntes ?? 3;

  const clientes = await prisma.cliente.findMany({
    where: { activo: true, planInternetId: { not: null }, nodoId: { not: null }, direccionIp: { not: null } },
    select: {
      id: true,
      razonSocial: true,
      telefono: true,
      fechaContrato: true,
      createdAt: true,
      planInternet: { select: { productoId: true, nombre: true, precio: true } },
    },
  });

  for (const cliente of clientes) {
    if (!cliente.telefono || !cliente.planInternet?.productoId) continue;
    if (enPrimerCiclo(cliente)) continue;

    try {
      const pagado = await pagoDeEsteCiclo(cliente.id, cliente.planInternet.productoId, cliente);
      if (pagado) continue;

      const limite = fechaLimitePago(cliente);
      const dias = calcularDiasParaVencer(limite, new Date());
      if (dias !== diasAntes) continue;

      const { inicio } = ventanaCicloActual(cliente);
      const yaEnviado = await prisma.recordatorioInternetEnviado.findUnique({
        where: { clienteId_cicloInicio: { clienteId: cliente.id, cicloInicio: inicio } },
      });
      if (yaEnviado) continue;

      const enviado = await enviarPlantillaWhatsapp({
        accessToken: empresa.whatsappAccessToken!,
        phoneNumberId: empresa.whatsappPhoneNumberId!,
        telefono: cliente.telefono,
        plantilla: empresa.whatsappTemplateRecordatorio!,
        idioma: empresa.whatsappTemplateIdioma,
        // Orden posicional {{1}}..{{5}} de la plantilla aprobada en Meta —
        // ver el checklist de configuración (nombre del cliente, nombre del
        // plan, precio, días restantes, fecha límite). El precio va SIN "$":
        // la plantilla ya lo trae escrito fijo ("(${{3}}/mes)").
        parametros: [
          cliente.razonSocial,
          cliente.planInternet.nombre,
          cliente.planInternet.precio.toFixed(2),
          String(dias),
          limite.toISOString().slice(0, 10),
        ],
      });

      if (enviado) {
        await prisma.recordatorioInternetEnviado.create({
          data: { clienteId: cliente.id, cicloInicio: inicio, canal: "whatsapp" },
        });
        console.log(`[recordatorio-internet] Recordatorio enviado a ${cliente.razonSocial} (${dias} día(s) antes del corte).`);
      }
    } catch (error: any) {
      console.error(`[recordatorio-internet] Error revisando a ${cliente.razonSocial}:`, error.message);
    }
  }
}

async function revisarTodasLasEmpresas() {
  for (const empresa of listarEmpresas()) {
    if (!debeRevisarAhora(empresa)) continue;

    ultimaFechaRevisadaPorEmpresa.set(empresa.id, fechaLocalYMD(new Date()));
    try {
      console.log(`[recordatorio-internet] Revisando clientes de internet próximos a vencer en "${empresa.nombre}"...`);
      await ejecutarConEmpresa(empresa.id, () => revisarClientesDeLaEmpresa());
    } catch (error: any) {
      console.error(`[recordatorio-internet] Error revisando "${empresa.nombre}":`, error.message);
    }
  }
}

export function iniciarRecordatorioVencimientoInternet(): void {
  console.log("[recordatorio-internet] Job activado: revisa cada 15 minutos si a alguna empresa ya le toca mandar el recordatorio de vencimiento.");
  setInterval(revisarTodasLasEmpresas, QUINCE_MINUTOS_MS);
}
