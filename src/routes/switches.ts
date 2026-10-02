// Switches TP-Link instalados en el domicilio de cada cliente (ver
// "SwitchCliente" en schema.prisma) — a diferencia de la OLT (un equipo
// central que reporta muchas ONUs), acá cada switch es independiente, uno
// por cliente, con su propia IP. SOLO LECTURA por SNMP — nunca se configura
// nada del switch desde acá (mismo criterio que routes/olts.ts). Gateado por
// el permiso "switches" (ver utils/permisos.ts), montado en index.ts.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { registrarAuditoria } from "../utils/auditoria";
import { probarConexionSwitch, explorarOidSwitch, listarPuertosDeSwitch, type PuertoDetectado } from "../utils/switchTpLink";
import type { ConfigSnmp } from "../utils/snmp";

export const switchesRouter = Router();

// Nunca se exponen los secretos SNMP al frontend — mismo criterio que
// snmpComunidad/snmpAuthPassword en routes/olts.ts.
function sinCredenciales<T extends { snmpComunidad: string | null; snmpAuthPassword: string | null; snmpPrivPassword: string | null }>(sw: T) {
  const { snmpComunidad, snmpAuthPassword, snmpPrivPassword, ...resto } = sw;
  return resto;
}

function configSnmpDeSwitch(sw: {
  direccionIp: string;
  snmpPuerto: number;
  snmpVersion: string;
  snmpComunidad: string | null;
  snmpUsuario: string | null;
  snmpAuthProtocolo: string | null;
  snmpAuthPassword: string | null;
  snmpPrivProtocolo: string | null;
  snmpPrivPassword: string | null;
}): ConfigSnmp {
  return {
    direccionIp: sw.direccionIp,
    snmpPuerto: sw.snmpPuerto,
    snmpVersion: sw.snmpVersion,
    snmpComunidad: sw.snmpComunidad,
    snmpUsuario: sw.snmpUsuario,
    snmpAuthProtocolo: sw.snmpAuthProtocolo,
    snmpAuthPassword: sw.snmpAuthPassword,
    snmpPrivProtocolo: sw.snmpPrivProtocolo,
    snmpPrivPassword: sw.snmpPrivPassword,
  };
}

// Tasa de tráfico (bytes/seg) entre la lectura anterior y la actual — null
// si es la primera lectura, o si el contador retrocedió (equipo reiniciado
// o contador reseteado), para nunca mostrar una tasa negativa sin sentido.
function calcularTasaBps(
  contadorPrevio: bigint | null,
  fechaPrevia: Date | null,
  contadorNuevo: bigint | null,
  ahora: Date
): number | null {
  if (contadorPrevio === null || fechaPrevia === null || contadorNuevo === null) return null;
  const segundos = (ahora.getTime() - fechaPrevia.getTime()) / 1000;
  if (segundos <= 0 || contadorNuevo < contadorPrevio) return null;
  return Number((contadorNuevo - contadorPrevio) * BigInt(8)) / segundos;
}

// Trae AHORA MISMO el estado de todos los puertos del switch por SNMP y lo
// concilia contra lo ya guardado — mismo patrón que sincronizarOlt en
// routes/olts.ts: actualiza el caché de cada SwitchPuerto (creándolo si es
// la primera vez) y registra en SwitchEvento las transiciones UP/DOWN.
// Exportada para que un futuro job de polling la reuse, igual que
// sincronizarOlt la reusa jobs/pollingOlt.ts.
export async function sincronizarSwitch(switchId: number) {
  const sw = await prisma.switchCliente.findUnique({ where: { id: switchId } });
  if (!sw) throw new Error("Switch no encontrado");

  const detectados: PuertoDetectado[] = await listarPuertosDeSwitch(configSnmpDeSwitch(sw), sw.cantidadPuertos);

  const existentes = await prisma.switchPuerto.findMany({ where: { switchId } });
  const existentesPorNumero = new Map(existentes.map((p) => [p.numeroPuerto, p]));

  const ahora = new Date();
  let puertosUp = 0;
  let transiciones = 0;

  for (const puerto of detectados) {
    if (puerto.estado === "UP") puertosUp++;
    const previo = existentesPorNumero.get(puerto.numeroPuerto);

    const trafficEntradaBps = calcularTasaBps(previo?.contadorEntradaBytes ?? null, previo?.ultimaLectura ?? null, puerto.contadorEntradaBytes, ahora);
    const trafficSalidaBps = calcularTasaBps(previo?.contadorSalidaBytes ?? null, previo?.ultimaLectura ?? null, puerto.contadorSalidaBytes, ahora);

    const actualizado = await prisma.switchPuerto.upsert({
      where: { switchId_numeroPuerto: { switchId, numeroPuerto: puerto.numeroPuerto } },
      create: {
        switchId,
        numeroPuerto: puerto.numeroPuerto,
        estado: puerto.estado,
        velocidadMbps: puerto.velocidadMbps,
        contadorEntradaBytes: puerto.contadorEntradaBytes,
        contadorSalidaBytes: puerto.contadorSalidaBytes,
        trafficEntradaBps: trafficEntradaBps !== null ? Math.round(trafficEntradaBps) : null,
        trafficSalidaBps: trafficSalidaBps !== null ? Math.round(trafficSalidaBps) : null,
        poeEstado: puerto.poeEstado,
        ultimaLectura: ahora,
      },
      update: {
        estado: puerto.estado,
        velocidadMbps: puerto.velocidadMbps,
        contadorEntradaBytes: puerto.contadorEntradaBytes,
        contadorSalidaBytes: puerto.contadorSalidaBytes,
        trafficEntradaBps: trafficEntradaBps !== null ? Math.round(trafficEntradaBps) : null,
        trafficSalidaBps: trafficSalidaBps !== null ? Math.round(trafficSalidaBps) : null,
        poeEstado: puerto.poeEstado,
        ultimaLectura: ahora,
      },
    });

    if (previo && previo.estado !== puerto.estado) {
      transiciones++;
      await prisma.switchEvento.create({
        data: {
          switchId,
          switchPuertoId: actualizado.id,
          tipo: puerto.estado === "UP" ? "PUERTO_UP" : "PUERTO_DOWN",
          mensaje: `Puerto ${puerto.numeroPuerto}`,
        },
      });
    }
  }

  await prisma.switchCliente.update({ where: { id: switchId }, data: { ultimaConexionExitosa: ahora } });

  return { totalPuertos: detectados.length, puertosUp, puertosDown: detectados.length - puertosUp, transiciones };
}

// GET /switches
switchesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const switches = await prisma.switchCliente.findMany({
      where: { activo: true },
      include: {
        cliente: { select: { id: true, razonSocial: true, identificacion: true } },
        puertos: { orderBy: { numeroPuerto: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(switches.map(sinCredenciales));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los switches" });
  }
});

// POST /switches/probar
switchesRouter.post("/probar", async (req: Request, res: Response) => {
  try {
    const { direccionIp, snmpPuerto, snmpVersion, snmpComunidad, snmpUsuario, snmpAuthProtocolo, snmpAuthPassword, snmpPrivProtocolo, snmpPrivPassword } = req.body;
    if (!direccionIp) return res.status(400).json({ error: "direccionIp es obligatoria" });

    const estado = await probarConexionSwitch({
      direccionIp,
      snmpPuerto: Number(snmpPuerto) || 161,
      snmpVersion: snmpVersion || "2c",
      snmpComunidad,
      snmpUsuario,
      snmpAuthProtocolo,
      snmpAuthPassword,
      snmpPrivProtocolo,
      snmpPrivPassword,
    });
    res.json(estado);
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo conectar por SNMP con esas credenciales" });
  }
});

// POST /switches
// Body: { clienteId, direccionIp, modelo?, cantidadPuertos?, snmp... }
switchesRouter.post("/", async (req: Request, res: Response) => {
  try {
    const {
      clienteId, direccionIp, modelo, cantidadPuertos,
      snmpPuerto, snmpVersion, snmpComunidad,
      snmpUsuario, snmpAuthProtocolo, snmpAuthPassword, snmpPrivProtocolo, snmpPrivPassword,
    } = req.body;

    if (!clienteId || !direccionIp) return res.status(400).json({ error: "clienteId y direccionIp son obligatorios" });

    const cliente = await prisma.cliente.findUnique({ where: { id: Number(clienteId) } });
    if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });

    const sw = await prisma.switchCliente.create({
      data: {
        clienteId: Number(clienteId),
        direccionIp,
        modelo: modelo || null,
        cantidadPuertos: cantidadPuertos ? Number(cantidadPuertos) : 8,
        snmpPuerto: snmpPuerto ? Number(snmpPuerto) : 161,
        snmpVersion: snmpVersion || "2c",
        snmpComunidad: snmpComunidad || "public",
        snmpUsuario: snmpUsuario || null,
        snmpAuthProtocolo: snmpAuthProtocolo || null,
        snmpAuthPassword: snmpAuthPassword || null,
        snmpPrivProtocolo: snmpPrivProtocolo || null,
        snmpPrivPassword: snmpPrivPassword || null,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_SWITCH_CLIENTE",
      entidad: "SwitchCliente",
      entidadId: sw.id,
      detalle: `${cliente.razonSocial} (${sw.direccionIp})`,
    });

    // Primera sincronización, mejor esfuerzo — mismo criterio que crear OLT.
    let advertenciaSnmp: string | undefined;
    try {
      await sincronizarSwitch(sw.id);
    } catch (error: any) {
      advertenciaSnmp = `El switch se creó, pero no se pudo sincronizar por SNMP: ${error?.message || "error desconocido"}. Podés reintentar con "Sincronizar ahora".`;
    }

    res.status(201).json({ ...sinCredenciales(sw), advertenciaSnmp });
  } catch (error: any) {
    if (error.code === "P2002") return res.status(409).json({ error: "Este cliente ya tiene un switch registrado" });
    console.error(error);
    res.status(500).json({ error: "Error al crear el switch" });
  }
});

// PUT /switches/:id — snmpComunidad/snmpAuthPassword/snmpPrivPassword vacíos/omitidos = no cambiar.
switchesRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const {
      direccionIp, modelo, cantidadPuertos,
      snmpPuerto, snmpVersion, snmpComunidad,
      snmpUsuario, snmpAuthProtocolo, snmpAuthPassword, snmpPrivProtocolo, snmpPrivPassword,
    } = req.body;

    if (!direccionIp) return res.status(400).json({ error: "direccionIp es obligatoria" });

    const sw = await prisma.switchCliente.update({
      where: { id },
      data: {
        direccionIp,
        modelo: modelo || null,
        cantidadPuertos: cantidadPuertos ? Number(cantidadPuertos) : 8,
        snmpPuerto: snmpPuerto ? Number(snmpPuerto) : 161,
        snmpVersion: snmpVersion || "2c",
        ...(snmpComunidad ? { snmpComunidad } : {}),
        snmpUsuario: snmpUsuario || null,
        snmpAuthProtocolo: snmpAuthProtocolo || null,
        ...(snmpAuthPassword ? { snmpAuthPassword } : {}),
        snmpPrivProtocolo: snmpPrivProtocolo || null,
        ...(snmpPrivPassword ? { snmpPrivPassword } : {}),
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_SWITCH_CLIENTE",
      entidad: "SwitchCliente",
      entidadId: sw.id,
      detalle: sw.direccionIp,
    });

    res.json(sinCredenciales(sw));
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Switch no encontrado" });
    console.error(error);
    res.status(500).json({ error: "Error al editar el switch" });
  }
});

// DELETE /switches/:id — borrado suave, mismo criterio que OLT.
switchesRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const sw = await prisma.switchCliente.update({ where: { id }, data: { activo: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_SWITCH_CLIENTE",
      entidad: "SwitchCliente",
      entidadId: sw.id,
      detalle: sw.direccionIp,
    });

    res.json({ mensaje: "Switch desactivado", switch: sinCredenciales(sw) });
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Switch no encontrado" });
    console.error(error);
    res.status(500).json({ error: "Error al desactivar el switch" });
  }
});

// POST /switches/:id/sincronizar
switchesRouter.post("/:id/sincronizar", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const resultado = await sincronizarSwitch(id);

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "SINCRONIZAR_SWITCH_CLIENTE",
      entidad: "SwitchCliente",
      entidadId: id,
      detalle: `${resultado.puertosUp}/${resultado.totalPuertos} puertos UP, ${resultado.transiciones} transición(es)`,
    });

    res.json(resultado);
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo sincronizar el switch por SNMP" });
  }
});

// POST /switches/:id/explorar-oid — calibración, mismo criterio que en OLT.
switchesRouter.post("/:id/explorar-oid", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { oidBase } = req.body;
    if (!oidBase) return res.status(400).json({ error: "oidBase es obligatorio" });

    const sw = await prisma.switchCliente.findUnique({ where: { id } });
    if (!sw) return res.status(404).json({ error: "Switch no encontrado" });

    const filas = await explorarOidSwitch(configSnmpDeSwitch(sw), oidBase);
    res.json({ total: filas.length, filas: filas.slice(0, 500), truncado: filas.length > 500 });
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo explorar ese OID en el switch" });
  }
});

// GET /switches/:id/eventos
switchesRouter.get("/:id/eventos", async (req: Request, res: Response) => {
  try {
    const switchId = Number(req.params.id);
    const eventos = await prisma.switchEvento.findMany({
      where: { switchId },
      include: { switchPuerto: { select: { id: true, numeroPuerto: true } } },
      orderBy: { fecha: "desc" },
      take: 200,
    });
    res.json(eventos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los eventos de este switch" });
  }
});
