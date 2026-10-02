// Encuesta de satisfacción por WhatsApp después de cada visita técnica: una
// a tres horas después de que el técnico marcó "Llegué" (le da tiempo a
// terminar el trabajo), se le manda al cliente la plantilla
// EmpresaConfig.whatsappTemplateEncuesta pidiendo una nota del 1 al 5. La
// respuesta la recoge el webhook (routes/whatsappWebhook.ts →
// utils/tickets.ts) y queda ligada a la visita y, por ella, al técnico. Una
// nota de 1 o 2 abre sola un ticket de seguimiento.
//
// Solo se manda entre 8:00 y 20:00 (no se le escribe a un cliente de noche)
// y solo a visitas de las últimas 24 horas — nunca encuestas retroactivas de
// visitas viejas al activar la función.
import { prisma, ejecutarConEmpresa, empresaActiva } from "../db";
import { listarEmpresas } from "../utils/empresas";
import { enviarPlantillaWhatsapp, normalizarTelefonoEcuador } from "../utils/whatsapp";

const QUINCE_MINUTOS_MS = 15 * 60_000;
const HORA_INICIO = 8;
const HORA_FIN = 20;

let corriendoActualmente = false;

export async function enviarEncuestasPendientesEmpresaActiva(): Promise<number> {
  const empresa = empresaActiva();
  if (!empresa.whatsappAccessToken || !empresa.whatsappPhoneNumberId || !empresa.whatsappTemplateEncuesta) return 0;

  const ahora = Date.now();
  const visitas = await prisma.visitaTecnica.findMany({
    where: {
      estado: "COMPLETADA",
      fechaLlegadaReal: { gte: new Date(ahora - 24 * 3600_000), lte: new Date(ahora - 60 * 60_000) },
      encuesta: null,
      cliente: { telefono: { not: null } },
    },
    select: {
      id: true,
      cliente: { select: { razonSocial: true, telefono: true } },
      rutaVisita: { select: { empleado: { select: { nombres: true } } } },
    },
    take: 100,
  });

  let enviadas = 0;
  for (const visita of visitas) {
    const telefono = normalizarTelefonoEcuador(visita.cliente!.telefono!);
    if (!telefono) continue;

    // Un mismo cliente con dos visitas el mismo día recibe UNA encuesta.
    const yaTieneHoy = await prisma.encuestaVisita.findFirst({ where: { telefono, enviadaEn: { gte: new Date(ahora - 24 * 3600_000) } } });
    if (yaTieneHoy) continue;

    const enviado = await enviarPlantillaWhatsapp({
      accessToken: empresa.whatsappAccessToken,
      phoneNumberId: empresa.whatsappPhoneNumberId,
      telefono,
      plantilla: empresa.whatsappTemplateEncuesta,
      idioma: empresa.whatsappTemplateIdioma,
      parametros: [visita.cliente!.razonSocial, visita.rutaVisita.empleado.nombres.split(" ")[0]],
    });
    // Se registra aunque Meta lo rechace (número sin WhatsApp, etc.) para no
    // reintentar la misma visita cada 15 minutos — pero con teléfono vacío,
    // así una respuesta posterior de ese número nunca se confunde con la
    // de una encuesta que en realidad no le llegó, y el Centro de Control
    // no la cuenta como enviada.
    await prisma.encuestaVisita.create({ data: { visitaId: visita.id, telefono: enviado ? telefono : "" } });
    if (enviado) enviadas++;
  }
  return enviadas;
}

async function revisarTodasLasEmpresas() {
  const hora = new Date().getHours();
  if (hora < HORA_INICIO || hora >= HORA_FIN || corriendoActualmente) return;
  corriendoActualmente = true;
  try {
    for (const empresa of listarEmpresas()) {
      if (!empresa.whatsappTemplateEncuesta) continue;
      try {
        const enviadas = await ejecutarConEmpresa(empresa.id, () => enviarEncuestasPendientesEmpresaActiva());
        if (enviadas > 0) console.log(`[encuesta-visitas] "${empresa.nombre}": ${enviadas} encuesta(s) enviada(s).`);
      } catch (error: any) {
        console.error(`[encuesta-visitas] Error en "${empresa.nombre}":`, error.message);
      }
    }
  } finally {
    corriendoActualmente = false;
  }
}

export function iniciarEncuestaVisitas(): void {
  console.log("[encuesta-visitas] Job activado: manda la encuesta de satisfacción por WhatsApp 1 hora después de cada visita (8:00-20:00).");
  setInterval(revisarTodasLasEmpresas, QUINCE_MINUTOS_MS);
}
