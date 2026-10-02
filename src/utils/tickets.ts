// Lógica compartida de tickets de soporte: la usan tanto la pantalla
// (routes/tickets.ts) como los mensajes que llegan por WhatsApp
// (routes/whatsappWebhook.ts → procesarMensajeEntrante). Asume que ya se
// está DENTRO de ejecutarConEmpresa.
import { prisma } from "../db";
import { normalizarTelefonoEcuador } from "./whatsapp";
import { interpretarCalificacion, type PrioridadTicket } from "./controlInterno";

export const CANALES_TICKET = ["WHATSAPP", "LLAMADA", "PRESENCIAL", "SISTEMA"] as const;
export const CATEGORIAS_TICKET = ["SIN_SERVICIO", "LENTITUD", "INTERMITENCIA", "FACTURACION", "CAMBIO_PLAN", "TRASLADO", "OTRO"] as const;

// Clasificación automática de un mensaje entrante — solo una primera
// sugerencia para ordenar la bandeja; quien atiende la corrige si hace falta.
export function sugerirCategoria(texto: string): { categoria: (typeof CATEGORIAS_TICKET)[number]; prioridad: PrioridadTicket } {
  const t = texto.toLowerCase();
  if (/sin (internet|servicio|se[ñn]al|conexi[oó]n|wifi)|no (hay|tengo|me llega) (el )?(internet|servicio|se[ñn]al|wifi)|no (funciona|sirve|conecta) (el )?(internet|servicio|wifi|m[oó]dem|router)|se (fue|cay[oó]) (el )?(internet|servicio)|luz roja|foco rojo/.test(t)) {
    return { categoria: "SIN_SERVICIO", prioridad: "ALTA" };
  }
  if (/intermiten|se (corta|va y viene)|a ratos|cada rato/.test(t)) return { categoria: "INTERMITENCIA", prioridad: "MEDIA" };
  if (/lent[oa]|despacio|velocidad|no carga/.test(t)) return { categoria: "LENTITUD", prioridad: "MEDIA" };
  if (/pag(o|u[eé]|ar)|factura|dep[oó]sit|transfer|cuenta|deuda|cobr/.test(t)) return { categoria: "FACTURACION", prioridad: "BAJA" };
  if (/cambi(o|ar) (de )?plan|subir (el )?plan|m[aá]s megas/.test(t)) return { categoria: "CAMBIO_PLAN", prioridad: "BAJA" };
  if (/traslad|mud(o|anza|arme)|cambio de (casa|domicilio)/.test(t)) return { categoria: "TRASLADO", prioridad: "BAJA" };
  return { categoria: "OTRO", prioridad: "MEDIA" };
}

export function normalizarTelefonoTicket(telefono: string | null | undefined): string | null {
  if (!telefono?.trim()) return null;
  return normalizarTelefonoEcuador(telefono) ?? telefono.trim();
}

// Cliente.telefono se guarda a mano sin formato fijo — se normalizan todos
// en memoria para comparar (miles de filas, una consulta liviana).
export async function buscarClientePorTelefono(telefonoNormalizado: string): Promise<{ id: number; razonSocial: string } | null> {
  const candidatos = await prisma.cliente.findMany({
    where: { telefono: { not: null } },
    select: { id: true, razonSocial: true, telefono: true, activo: true },
    orderBy: { activo: "desc" },
  });
  const encontrado = candidatos.find((c) => normalizarTelefonoEcuador(c.telefono!) === telefonoNormalizado);
  return encontrado ? { id: encontrado.id, razonSocial: encontrado.razonSocial } : null;
}

// Si el cliente cuelga de un puerto PON que YA tiene un corte masivo abierto,
// el ticket se vincula a esa alerta — quien atiende ve de inmediato que no
// es un problema de esa casa, y al resolver el corte se cierran juntos.
export async function alertaCorteDelCliente(clienteId: number): Promise<number | null> {
  // Nodo (Mikrotik) caído: afecta a todo el sector, con o sin fibra/OLT.
  const cliente = await prisma.cliente.findUnique({ where: { id: clienteId }, select: { nodoId: true } });
  if (cliente?.nodoId) {
    const nodoCaido = await prisma.alertaRed.findFirst({ where: { tipo: "NODO_CAIDO", nodoId: cliente.nodoId, fechaFin: null }, select: { id: true } });
    if (nodoCaido) return nodoCaido.id;
  }
  const onus = await prisma.oltOnu.findMany({ where: { clienteId, activo: true }, select: { oltId: true, slot: true, puerto: true } });
  for (const o of onus) {
    const alerta = await prisma.alertaRed.findFirst({
      where: { tipo: "CORTE_MASIVO", fechaFin: null, oltId: o.oltId, slot: o.slot, puerto: o.puerto },
      select: { id: true },
    });
    if (alerta) return alerta.id;
  }
  return null;
}

// Mensaje que llega por WhatsApp de un cliente. Orden de prioridad:
//  1. respuesta a una encuesta de satisfacción pendiente (un "1".."5"),
//  2. mensaje adicional de un ticket que ya está abierto con ese número,
//  3. ticket nuevo.
export async function procesarMensajeEntrante(telefonoCrudo: string, nombrePerfil: string | null, texto: string): Promise<void> {
  const telefono = normalizarTelefonoTicket(telefonoCrudo);
  if (!telefono) return;
  const ahora = new Date();

  const encuestaPendiente = await prisma.encuestaVisita.findFirst({
    where: { telefono, calificacion: null, enviadaEn: { gte: new Date(ahora.getTime() - 72 * 3600_000) } },
    orderBy: { enviadaEn: "desc" },
    include: { visita: { select: { clienteId: true, nombreContacto: true } } },
  });
  const calificacion = interpretarCalificacion(texto);
  if (encuestaPendiente && calificacion !== null) {
    const comentario = texto.trim().replace(/^[1-5](\s*\/\s*5)?/, "").trim() || null;
    await prisma.encuestaVisita.update({ where: { id: encuestaPendiente.id }, data: { calificacion, comentario, respondidaEn: ahora } });
    // Una mala calificación no se pierde en un reporte: abre un ticket de
    // seguimiento para que alguien llame al cliente.
    if (calificacion <= 2) {
      await prisma.ticketSoporte.create({
        data: {
          clienteId: encuestaPendiente.visita.clienteId,
          nombreContacto: encuestaPendiente.visita.nombreContacto,
          telefono,
          canal: "WHATSAPP",
          categoria: "OTRO",
          prioridad: "MEDIA",
          asunto: `Calificó con ${calificacion}/5 la visita técnica — dar seguimiento`,
          mensajes: { create: { autor: "CLIENTE", texto } },
        },
      });
    }
    return;
  }

  // Comentario que el cliente manda justo después de calificar ("5" y luego
  // "muy amable el técnico") — se guarda en la encuesta, no abre ticket.
  const recienCalificada = await prisma.encuestaVisita.findFirst({
    where: { telefono, comentario: null, respondidaEn: { gte: new Date(ahora.getTime() - 30 * 60_000) } },
    orderBy: { respondidaEn: "desc" },
  });
  if (recienCalificada && (recienCalificada.calificacion ?? 0) >= 3) {
    await prisma.encuestaVisita.update({ where: { id: recienCalificada.id }, data: { comentario: texto.trim() } });
    return;
  }

  const abierto = await prisma.ticketSoporte.findFirst({
    where: { telefono, estado: { in: ["ABIERTO", "EN_PROCESO"] } },
    orderBy: { createdAt: "desc" },
  });
  if (abierto) {
    await prisma.mensajeTicket.create({ data: { ticketId: abierto.id, autor: "CLIENTE", texto } });
    return;
  }

  const cliente = await buscarClientePorTelefono(telefono);
  const { categoria, prioridad } = sugerirCategoria(texto);
  const alertaRedId = cliente && categoria === "SIN_SERVICIO" ? await alertaCorteDelCliente(cliente.id) : null;

  await prisma.ticketSoporte.create({
    data: {
      clienteId: cliente?.id ?? null,
      nombreContacto: cliente?.razonSocial ?? nombrePerfil ?? telefono,
      telefono,
      canal: "WHATSAPP",
      categoria,
      prioridad,
      asunto: texto.trim().slice(0, 120) || "(mensaje sin texto)",
      alertaRedId,
      mensajes: {
        create: [
          { autor: "CLIENTE", texto },
          ...(alertaRedId
            ? [{ autor: "SISTEMA", texto: "Este cliente está en un puerto PON con un corte masivo ya detectado — probablemente no es un problema de su domicilio." }]
            : []),
        ],
      },
    },
  });
}
