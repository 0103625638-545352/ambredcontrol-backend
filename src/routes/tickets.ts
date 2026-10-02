// Tickets de soporte — bandeja de reclamos/pedidos de clientes con tiempos
// de atención (SLA por prioridad, ver utils/controlInterno.ts). Entran a mano
// (llamada, en persona) o solos por WhatsApp (ver utils/tickets.ts →
// procesarMensajeEntrante). Gateado por el permiso "tickets" en index.ts.
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma, empresaActiva } from "../db";
import { SELECT_EMPLEADO_SEGURO } from "../utils/empleados";
import { registrarAuditoria } from "../utils/auditoria";
import { calcularSla, PRIORIDADES_TICKET } from "../utils/controlInterno";
import { CANALES_TICKET, CATEGORIAS_TICKET, normalizarTelefonoTicket, alertaCorteDelCliente } from "../utils/tickets";
import { fechaLocalDeString, aClaveDia } from "../utils/rangoFechas";
import { enviarTextoWhatsapp } from "../utils/whatsapp";

export const ticketsRouter = Router();

const ESTADOS = ["ABIERTO", "EN_PROCESO", "RESUELTO", "CANCELADO"] as const;
type EstadoTicket = (typeof ESTADOS)[number];
const VENTANA_WHATSAPP_MS = 24 * 3600_000;

const INCLUDE_LISTADO = {
  cliente: { select: { id: true, razonSocial: true, telefono: true, direccion: true } },
  asignadoEmpleado: { select: SELECT_EMPLEADO_SEGURO },
  visitaTecnica: { select: { id: true, estado: true, fechaLlegadaReal: true, rutaVisita: { select: { fecha: true } } } },
  alertaRed: { select: { id: true, tipo: true, mensaje: true, fechaFin: true } },
  creadoPorUsuario: { select: { id: true, nombre: true } },
} satisfies Prisma.TicketSoporteInclude;

function conSla<T extends { prioridad: string; createdAt: Date; fechaResolucion: Date | null }>(ticket: T) {
  return { ...ticket, sla: calcularSla(ticket, new Date()) };
}

// GET /tickets?estado=ABIERTO,EN_PROCESO&q=texto
// Sin "estado" trae los pendientes (ABIERTO + EN_PROCESO) más los cerrados
// de los últimos 30 días.
ticketsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const estados = typeof req.query.estado === "string" && req.query.estado
      ? req.query.estado.split(",").filter((e): e is EstadoTicket => (ESTADOS as readonly string[]).includes(e))
      : null;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const where: Prisma.TicketSoporteWhereInput = {
      ...(estados
        ? { estado: { in: estados } }
        : { OR: [{ estado: { in: ["ABIERTO", "EN_PROCESO"] } }, { fechaResolucion: { gte: new Date(Date.now() - 30 * 24 * 3600_000) } }] }),
      ...(q && {
        AND: [
          {
            OR: [
              { asunto: { contains: q, mode: "insensitive" } },
              { nombreContacto: { contains: q, mode: "insensitive" } },
              { telefono: { contains: q } },
              { cliente: { razonSocial: { contains: q, mode: "insensitive" } } },
              ...(Number.isInteger(Number(q)) ? [{ id: Number(q) }] : []),
            ],
          },
        ],
      }),
    };

    const tickets = await prisma.ticketSoporte.findMany({
      where,
      include: { ...INCLUDE_LISTADO, _count: { select: { mensajes: true } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    res.json(tickets.map(conSla));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los tickets" });
  }
});

// GET /tickets/resumen — tarjetas de arriba de la pantalla + tiempos por
// técnico de los últimos 30 días.
ticketsRouter.get("/resumen", async (_req: Request, res: Response) => {
  try {
    const hace30 = new Date(Date.now() - 30 * 24 * 3600_000);
    const [pendientes, resueltos30] = await Promise.all([
      prisma.ticketSoporte.findMany({ where: { estado: { in: ["ABIERTO", "EN_PROCESO"] } }, select: { estado: true, prioridad: true, createdAt: true, fechaResolucion: true } }),
      prisma.ticketSoporte.findMany({
        where: { estado: "RESUELTO", fechaResolucion: { gte: hace30 } },
        select: { prioridad: true, createdAt: true, fechaResolucion: true, asignadoEmpleado: { select: { id: true, nombres: true, apellidos: true } } },
      }),
    ]);

    const ahora = new Date();
    const porTecnico = new Map<number | "sin", { nombre: string; resueltos: number; horas: number; dentroSla: number }>();
    for (const t of resueltos30) {
      const clave = t.asignadoEmpleado?.id ?? ("sin" as const);
      const fila = porTecnico.get(clave) ?? {
        nombre: t.asignadoEmpleado ? `${t.asignadoEmpleado.nombres} ${t.asignadoEmpleado.apellidos}` : "Sin asignar",
        resueltos: 0,
        horas: 0,
        dentroSla: 0,
      };
      const sla = calcularSla(t, ahora);
      fila.resueltos++;
      fila.horas += sla.horasTranscurridas;
      if (!sla.vencido) fila.dentroSla++;
      porTecnico.set(clave, fila);
    }

    res.json({
      abiertos: pendientes.filter((t) => t.estado === "ABIERTO").length,
      enProceso: pendientes.filter((t) => t.estado === "EN_PROCESO").length,
      vencidos: pendientes.filter((t) => calcularSla(t, ahora).vencido).length,
      resueltos30Dias: resueltos30.length,
      porcentajeDentroSla30Dias:
        resueltos30.length > 0 ? Math.round((resueltos30.filter((t) => !calcularSla(t, ahora).vencido).length / resueltos30.length) * 100) : null,
      porTecnico: [...porTecnico.values()]
        .map((f) => ({ nombre: f.nombre, resueltos: f.resueltos, horasPromedio: Math.round((f.horas / f.resueltos) * 10) / 10, porcentajeDentroSla: Math.round((f.dentroSla / f.resueltos) * 100) }))
        .sort((a, b) => b.resueltos - a.resueltos),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al calcular el resumen de tickets" });
  }
});

// GET /tickets/tecnicos — para asignar/agendar sin depender del permiso de
// Nómina (GET /empleados lo exige); solo nombre e id, nada sensible.
ticketsRouter.get("/tecnicos", async (_req: Request, res: Response) => {
  try {
    const empleados = await prisma.empleado.findMany({
      where: { activo: true },
      select: { id: true, nombres: true, apellidos: true, cargo: true },
      orderBy: [{ nombres: "asc" }, { apellidos: "asc" }],
    });
    res.json(empleados);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los técnicos" });
  }
});

// GET /tickets/:id — con la conversación completa
ticketsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const ticket = await prisma.ticketSoporte.findUnique({
      where: { id: Number(req.params.id) },
      include: { ...INCLUDE_LISTADO, mensajes: { orderBy: { createdAt: "asc" }, include: { usuario: { select: { nombre: true } } } } },
    });
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });

    // ¿Se le puede contestar por WhatsApp con texto libre? Solo dentro de
    // las 24h desde el último mensaje del cliente (regla de Meta).
    const ultimoDelCliente = [...ticket.mensajes].reverse().find((m) => m.autor === "CLIENTE");
    const puedeResponderWhatsapp =
      ticket.canal === "WHATSAPP" &&
      !!ticket.telefono &&
      !!ultimoDelCliente &&
      Date.now() - ultimoDelCliente.createdAt.getTime() < VENTANA_WHATSAPP_MS &&
      !!empresaActiva().whatsappAccessToken;

    res.json({ ...conSla(ticket), puedeResponderWhatsapp });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener el ticket" });
  }
});

// POST /tickets
// Body: { clienteId?, nombreContacto?, telefono?, canal, categoria, prioridad?, asunto, descripcion?, asignadoEmpleadoId? }
ticketsRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { clienteId, nombreContacto, telefono, canal, categoria, prioridad, asunto, descripcion, asignadoEmpleadoId } = req.body;

    if (!CANALES_TICKET.includes(canal)) return res.status(400).json({ error: "canal inválido" });
    if (!CATEGORIAS_TICKET.includes(categoria)) return res.status(400).json({ error: "categoria inválida" });
    if (prioridad && !PRIORIDADES_TICKET.includes(prioridad)) return res.status(400).json({ error: "prioridad inválida" });
    if (!asunto?.trim()) return res.status(400).json({ error: "El asunto es obligatorio" });

    let nombreFinal: string | undefined = nombreContacto?.trim();
    let telefonoFinal: string | null = normalizarTelefonoTicket(telefono);
    if (clienteId) {
      const cliente = await prisma.cliente.findUnique({ where: { id: Number(clienteId) } });
      if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });
      nombreFinal = nombreFinal || cliente.razonSocial;
      telefonoFinal = telefonoFinal ?? normalizarTelefonoTicket(cliente.telefono);
    }
    if (!nombreFinal) return res.status(400).json({ error: "Elegí un cliente o escribí el nombre de contacto" });

    const alertaRedId = clienteId && categoria === "SIN_SERVICIO" ? await alertaCorteDelCliente(Number(clienteId)) : null;

    const ticket = await prisma.ticketSoporte.create({
      data: {
        clienteId: clienteId ? Number(clienteId) : null,
        nombreContacto: nombreFinal,
        telefono: telefonoFinal,
        canal,
        categoria,
        prioridad: prioridad || "MEDIA",
        asunto: asunto.trim(),
        asignadoEmpleadoId: asignadoEmpleadoId ? Number(asignadoEmpleadoId) : null,
        alertaRedId,
        creadoPorUsuarioId: req.usuario!.usuarioId,
        mensajes: {
          create: [
            ...(descripcion?.trim() ? [{ autor: "CLIENTE", texto: descripcion.trim() }] : []),
            ...(alertaRedId
              ? [{ autor: "SISTEMA", texto: "Este cliente está en un puerto PON con un corte masivo ya detectado — probablemente no es un problema de su domicilio." }]
              : []),
          ],
        },
      },
      include: INCLUDE_LISTADO,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_TICKET_SOPORTE",
      entidad: "TicketSoporte",
      entidadId: ticket.id,
      detalle: `${ticket.nombreContacto}: ${ticket.asunto}`,
    });
    res.status(201).json(conSla(ticket));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear el ticket" });
  }
});

// PATCH /tickets/:id
// Body (todo opcional): { estado, prioridad, categoria, asignadoEmpleadoId, clienteId, solucion }
// Los tiempos se llevan solos: primera vez en EN_PROCESO → fechaPrimeraAtencion;
// RESUELTO/CANCELADO → fechaResolucion; reabrir la limpia.
ticketsRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const actual = await prisma.ticketSoporte.findUnique({ where: { id } });
    if (!actual) return res.status(404).json({ error: "Ticket no encontrado" });

    const { estado, prioridad, categoria, asignadoEmpleadoId, clienteId, solucion } = req.body;
    if (estado !== undefined && !ESTADOS.includes(estado)) return res.status(400).json({ error: "estado inválido" });
    if (prioridad !== undefined && !PRIORIDADES_TICKET.includes(prioridad)) return res.status(400).json({ error: "prioridad inválida" });
    if (categoria !== undefined && !CATEGORIAS_TICKET.includes(categoria)) return res.status(400).json({ error: "categoria inválida" });
    if (estado === "RESUELTO" && !(solucion ?? actual.solucion)?.trim()) {
      return res.status(400).json({ error: "Para resolver el ticket, describí la solución" });
    }

    const ahora = new Date();
    const data: Prisma.TicketSoporteUncheckedUpdateInput = {};
    if (prioridad !== undefined) data.prioridad = prioridad;
    if (categoria !== undefined) data.categoria = categoria;
    if (solucion !== undefined) data.solucion = solucion?.trim() || null;
    if (asignadoEmpleadoId !== undefined) data.asignadoEmpleadoId = asignadoEmpleadoId ? Number(asignadoEmpleadoId) : null;
    if (clienteId !== undefined) data.clienteId = clienteId ? Number(clienteId) : null;
    if (estado !== undefined && estado !== actual.estado) {
      data.estado = estado;
      if (estado === "EN_PROCESO" && !actual.fechaPrimeraAtencion) data.fechaPrimeraAtencion = ahora;
      if (estado === "RESUELTO" || estado === "CANCELADO") {
        data.fechaResolucion = ahora;
        if (!actual.fechaPrimeraAtencion) data.fechaPrimeraAtencion = ahora;
      }
      if (estado === "ABIERTO" || estado === "EN_PROCESO") data.fechaResolucion = null;
    }

    const ticket = await prisma.ticketSoporte.update({ where: { id }, data, include: INCLUDE_LISTADO });

    if (estado !== undefined && estado !== actual.estado) {
      await prisma.mensajeTicket.create({
        data: { ticketId: id, autor: "SISTEMA", texto: `Estado: ${actual.estado} → ${estado}`, usuarioId: req.usuario!.usuarioId },
      });
      await registrarAuditoria(prisma, {
        usuarioId: req.usuario!.usuarioId,
        accion: "CAMBIAR_ESTADO_TICKET",
        entidad: "TicketSoporte",
        entidadId: id,
        detalle: `${actual.estado} → ${estado}`,
      });
    }
    res.json(conSla(ticket));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar el ticket" });
  }
});

// POST /tickets/:id/mensajes  Body: { texto, enviarWhatsapp? }
// Nota interna, o respuesta al cliente por WhatsApp si el ticket entró por
// ahí y todavía está dentro de la ventana de 24h.
ticketsRouter.post("/:id/mensajes", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const texto = typeof req.body.texto === "string" ? req.body.texto.trim() : "";
    if (!texto) return res.status(400).json({ error: "El mensaje está vacío" });

    const ticket = await prisma.ticketSoporte.findUnique({ where: { id } });
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });

    let enviadoPorWhatsapp = false;
    if (req.body.enviarWhatsapp === true) {
      const ultimoDelCliente = await prisma.mensajeTicket.findFirst({ where: { ticketId: id, autor: "CLIENTE" }, orderBy: { createdAt: "desc" } });
      const empresa = empresaActiva();
      if (!ticket.telefono || !ultimoDelCliente || Date.now() - ultimoDelCliente.createdAt.getTime() >= VENTANA_WHATSAPP_MS) {
        return res.status(400).json({ error: "Ya pasaron más de 24 horas desde el último mensaje del cliente — WhatsApp no permite responderle con texto libre. Llamalo por teléfono." });
      }
      if (!empresa.whatsappAccessToken || !empresa.whatsappPhoneNumberId) {
        return res.status(400).json({ error: "WhatsApp Business no está configurado para esta empresa (Ajustes)" });
      }
      enviadoPorWhatsapp = await enviarTextoWhatsapp({ accessToken: empresa.whatsappAccessToken, phoneNumberId: empresa.whatsappPhoneNumberId, telefono: ticket.telefono, texto });
      if (!enviadoPorWhatsapp) return res.status(502).json({ error: "WhatsApp rechazó el mensaje — revisá el registro del servidor" });
    }

    const mensaje = await prisma.mensajeTicket.create({
      data: { ticketId: id, autor: "USUARIO", texto: enviadoPorWhatsapp ? `📤 ${texto}` : texto, usuarioId: req.usuario!.usuarioId },
      include: { usuario: { select: { nombre: true } } },
    });

    // Responderle al cliente cuenta como "primera atención".
    if (ticket.estado === "ABIERTO" && enviadoPorWhatsapp) {
      await prisma.ticketSoporte.update({ where: { id }, data: { estado: "EN_PROCESO", fechaPrimeraAtencion: ticket.fechaPrimeraAtencion ?? new Date() } });
    }
    res.status(201).json(mensaje);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al guardar el mensaje" });
  }
});

// POST /tickets/:id/visita  Body: { empleadoId, fecha: "YYYY-MM-DD", latitud?, longitud? }
// Agenda la visita técnica para este ticket en la ruta de ese técnico ese
// día (la crea si no existe, mismo criterio que POST /visitas/urgente). Sin
// latitud/longitud usa la ubicación guardada del cliente.
ticketsRouter.post("/:id/visita", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { empleadoId, fecha, latitud, longitud } = req.body;
    if (!empleadoId || !fecha) return res.status(400).json({ error: "empleadoId y fecha son obligatorios" });

    const ticket = await prisma.ticketSoporte.findUnique({ where: { id }, include: { cliente: true } });
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    if (ticket.visitaTecnicaId) return res.status(409).json({ error: "Este ticket ya tiene una visita agendada" });

    const lat = latitud ?? ticket.cliente?.latitud?.toNumber();
    const lng = longitud ?? ticket.cliente?.longitud?.toNumber();
    if (lat == null || lng == null) {
      return res.status(400).json({ error: "El cliente no tiene ubicación guardada — pegá su ubicación para agendar la visita" });
    }

    const empleado = await prisma.empleado.findUnique({ where: { id: Number(empleadoId) } });
    if (!empleado) return res.status(404).json({ error: "Técnico no encontrado" });

    const dia = fechaLocalDeString(String(fecha), false);
    const resultado = await prisma.$transaction(async (tx) => {
      const ruta =
        (await tx.rutaVisita.findUnique({ where: { empleadoId_fecha: { empleadoId: empleado.id, fecha: dia } } })) ??
        (await tx.rutaVisita.create({ data: { empleadoId: empleado.id, fecha: dia } }));
      const { _max } = await tx.visitaTecnica.aggregate({ where: { rutaVisitaId: ruta.id }, _max: { orden: true } });
      const visita = await tx.visitaTecnica.create({
        data: {
          rutaVisitaId: ruta.id,
          clienteId: ticket.clienteId,
          nombreContacto: ticket.nombreContacto,
          direccion: ticket.cliente?.direccion ?? null,
          motivoVisita: `Ticket #${ticket.id}: ${ticket.asunto}`.slice(0, 250),
          latitud: new Prisma.Decimal(lat),
          longitud: new Prisma.Decimal(lng),
          orden: (_max.orden ?? 0) + 1,
          esUrgente: ticket.prioridad === "ALTA" && aClaveDia(dia) === aClaveDia(new Date()),
        },
      });
      await tx.ticketSoporte.update({
        where: { id },
        data: {
          visitaTecnicaId: visita.id,
          asignadoEmpleadoId: empleado.id,
          estado: "EN_PROCESO",
          fechaPrimeraAtencion: ticket.fechaPrimeraAtencion ?? new Date(),
        },
      });
      await tx.mensajeTicket.create({
        data: { ticketId: id, autor: "SISTEMA", texto: `Visita técnica agendada para ${aClaveDia(dia)} con ${empleado.nombres} ${empleado.apellidos}`, usuarioId: req.usuario!.usuarioId },
      });
      return visita;
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "AGENDAR_VISITA_TICKET",
      entidad: "TicketSoporte",
      entidadId: id,
      detalle: `Visita #${resultado.id} con ${empleado.nombres} ${empleado.apellidos} (${aClaveDia(dia)})`,
    });
    res.status(201).json(resultado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al agendar la visita" });
  }
});

// PATCH /tickets/alerta/:alertaRedId/resolver  Body: { solucion }
// Cierra de una vez todos los tickets pendientes vinculados a un corte
// masivo (cuando se repara la fibra, se resuelven todos juntos).
ticketsRouter.patch("/alerta/:alertaRedId/resolver", async (req: Request, res: Response) => {
  try {
    const alertaRedId = Number(req.params.alertaRedId);
    const solucion = typeof req.body.solucion === "string" && req.body.solucion.trim() ? req.body.solucion.trim() : "Se reparó el corte de red del sector";
    const ahora = new Date();
    const pendientes = await prisma.ticketSoporte.findMany({ where: { alertaRedId, estado: { in: ["ABIERTO", "EN_PROCESO"] } }, select: { id: true, fechaPrimeraAtencion: true } });
    for (const t of pendientes) {
      await prisma.ticketSoporte.update({
        where: { id: t.id },
        data: { estado: "RESUELTO", solucion, fechaResolucion: ahora, fechaPrimeraAtencion: t.fechaPrimeraAtencion ?? ahora },
      });
    }
    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "RESOLVER_TICKETS_ALERTA_RED",
      entidad: "AlertaRed",
      entidadId: alertaRedId,
      detalle: `${pendientes.length} ticket(s) resuelto(s): ${solucion}`,
    });
    res.json({ resueltos: pendientes.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al resolver los tickets" });
  }
});
