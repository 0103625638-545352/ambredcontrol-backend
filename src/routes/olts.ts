// Catálogo de OLT Huawei del ISP y las ONUs que se detectan en cada una —
// ver el comentario "Módulo de OLT" en schema.prisma sobre el alcance real:
// esto es SOLO LECTURA contra el equipo (SNMP), nunca se aprovisiona ni se
// configura la OLT desde acá. Lo único que "escribe" este módulo es el
// vínculo ONU↔Cliente dentro de nuestra propia base de datos. Gateado por el
// permiso "olt" (ver utils/permisos.ts), montado en index.ts.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { guardarLecturasSenal, evaluarCortesMasivos } from "../utils/monitoreoRed";
import { registrarAuditoria } from "../utils/auditoria";
import { probarConexionSnmp, explorarOid, listarOnusDeOlt, type OnuDetectada } from "../utils/oltHuawei";
import { probarConexionSsh, ejecutarComandoSshCrudo, listarOntsDePuertoSsh, type ConfigSsh } from "../utils/oltHuaweiSsh";
import type { ConfigSnmp } from "../utils/snmp";

export const oltsRouter = Router();

const MODELOS_VALIDOS = ["MA5608T", "MA5800-X7"];

// Umbrales de alerta para la Vista por puerto GPON — mismo umbral de señal
// óptica débil que ya usa el Mapa de Red (ver UMBRAL_SENAL_DEBIL_DBM en
// utils/estadoRedCliente.ts), más uno de temperatura propio de este módulo
// (no existía antes porque SNMP no traía este dato).
const UMBRAL_SENAL_DEBIL_DBM = -27;
const UMBRAL_TEMPERATURA_ALTA_C = 60;

// Nunca se exponen los secretos SNMP/SSH al frontend — mismo criterio que
// mikrotikPassword en routes/nodosRed.ts. Al editar, dejarlos vacíos
// significa "no cambiar".
function sinCredenciales<T extends { snmpComunidad: string | null; snmpAuthPassword: string | null; snmpPrivPassword: string | null; sshPassword: string | null }>(olt: T) {
  const { snmpComunidad, snmpAuthPassword, snmpPrivPassword, sshPassword, ...resto } = olt;
  return resto;
}

function configSnmpDeOlt(olt: {
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
    direccionIp: olt.direccionIp,
    snmpPuerto: olt.snmpPuerto,
    snmpVersion: olt.snmpVersion,
    snmpComunidad: olt.snmpComunidad,
    snmpUsuario: olt.snmpUsuario,
    snmpAuthProtocolo: olt.snmpAuthProtocolo,
    snmpAuthPassword: olt.snmpAuthPassword,
    snmpPrivProtocolo: olt.snmpPrivProtocolo,
    snmpPrivPassword: olt.snmpPrivPassword,
  };
}

// Falta cualquiera de los 3 campos = SSH no configurado en esta OLT; se
// devuelve null en vez de tirar error para que el caller decida cómo
// avisarlo (la Vista por puerto GPON queda deshabilitada para esa OLT, pero
// SNMP sigue funcionando igual).
function configSshDeOlt(olt: { direccionIp: string; sshPuerto: number; sshUsuario: string | null; sshPassword: string | null }): ConfigSsh | null {
  if (!olt.sshUsuario || !olt.sshPassword) return null;
  return { direccionIp: olt.direccionIp, sshPuerto: olt.sshPuerto, sshUsuario: olt.sshUsuario, sshPassword: olt.sshPassword };
}

// Trae AHORA MISMO la tabla de ONUs de la OLT por SNMP y la concilia contra
// lo que ya está guardado: agrega las nuevas, actualiza las que ya existían
// (marcando en OltEvento las transiciones de estado) y desactiva las que ya
// no se detectan. Exportada para que jobs/pollingOlt.ts la reuse (mismo
// criterio que enviarFacturaAlSri en routes/facturas.ts, reusada por
// jobs/reintentoAutorizacionSri.ts).
export async function sincronizarOlt(oltId: number) {
  const olt = await prisma.olt.findUnique({ where: { id: oltId } });
  if (!olt) throw new Error("OLT no encontrada");

  const detectadas: OnuDetectada[] = await listarOnusDeOlt(configSnmpDeOlt(olt));

  const existentes = await prisma.oltOnu.findMany({ where: { oltId, activo: true } });
  const existentesPorClave = new Map(existentes.map((o) => [`${o.slot}.${o.puerto}.${o.onuIndex}`, o]));
  const clavesVistas = new Set<string>();

  let nuevas = 0;
  let actualizadas = 0;
  let desaparecidas = 0;
  // ONLINE → OFFLINE de esta pasada, por puerto PON — para detectar cortes
  // masivos (ver utils/monitoreoRed.ts).
  const caidasPorPuerto = new Map<string, number>();

  for (const onu of detectadas) {
    const clave = `${onu.slot}.${onu.puerto}.${onu.onuIndex}`;
    clavesVistas.add(clave);
    const previa = existentesPorClave.get(clave);

    if (!previa) {
      const creada = await prisma.oltOnu.upsert({
        where: { oltId_slot_puerto_onuIndex: { oltId, slot: onu.slot, puerto: onu.puerto, onuIndex: onu.onuIndex } },
        create: {
          oltId,
          slot: onu.slot,
          puerto: onu.puerto,
          onuIndex: onu.onuIndex,
          serial: onu.serial,
          descripcion: onu.descripcion,
          estado: onu.estado,
          rxPowerDbm: onu.rxPowerDbm,
          txPowerDbm: onu.txPowerDbm,
          ultimaLectura: new Date(),
          activo: true,
        },
        // Cubre el caso de una ONU que había desaparecido (activo=false) y
        // reaparece en el mismo slot/puerto/índice.
        update: {
          serial: onu.serial,
          descripcion: onu.descripcion,
          estado: onu.estado,
          rxPowerDbm: onu.rxPowerDbm,
          txPowerDbm: onu.txPowerDbm,
          ultimaLectura: new Date(),
          activo: true,
        },
      });
      nuevas++;
      await prisma.oltEvento.create({
        data: { oltId, oltOnuId: creada.id, tipo: "ONU_NUEVA", mensaje: `Detectada en slot ${onu.slot}/puerto ${onu.puerto} — serial ${onu.serial}` },
      });
      continue;
    }

    actualizadas++;
    if (previa.estado === "ONLINE" && onu.estado === "OFFLINE") {
      const clavePuerto = `${onu.slot}.${onu.puerto}`;
      caidasPorPuerto.set(clavePuerto, (caidasPorPuerto.get(clavePuerto) ?? 0) + 1);
    }
    if (previa.estado !== onu.estado) {
      await prisma.oltEvento.create({
        data: { oltId, oltOnuId: previa.id, tipo: onu.estado === "ONLINE" ? "ONU_ONLINE" : "ONU_OFFLINE", mensaje: `Serial ${onu.serial}` },
      });
    }
    await prisma.oltOnu.update({
      where: { id: previa.id },
      data: {
        serial: onu.serial,
        descripcion: onu.descripcion,
        estado: onu.estado,
        rxPowerDbm: onu.rxPowerDbm,
        txPowerDbm: onu.txPowerDbm,
        ultimaLectura: new Date(),
      },
    });
  }

  for (const previa of existentes) {
    const clave = `${previa.slot}.${previa.puerto}.${previa.onuIndex}`;
    if (clavesVistas.has(clave)) continue;
    desaparecidas++;
    await prisma.oltOnu.update({ where: { id: previa.id }, data: { activo: false } });
    await prisma.oltEvento.create({
      data: { oltId, oltOnuId: previa.id, tipo: "ONU_DESAPARECIO", mensaje: `Ya no se detecta en la OLT (serial ${previa.serial})` },
    });
  }

  await prisma.olt.update({ where: { id: oltId }, data: { ultimaConexionExitosa: new Date() } });

  // Centro de Control: historial de señal y detección de cortes masivos —
  // ambas best-effort, nunca rompen la sincronización en sí.
  await guardarLecturasSenal(oltId);
  await evaluarCortesMasivos(oltId, olt.nombre, caidasPorPuerto);

  return { totalDetectadas: detectadas.length, nuevas, actualizadas, desaparecidas };
}

// GET /olts
oltsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const olts = await prisma.olt.findMany({
      where: { activo: true },
      include: { nodo: { select: { id: true, nombre: true } } },
      orderBy: { nombre: "asc" },
    });
    res.json(olts.map(sinCredenciales));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las OLT" });
  }
});

// POST /olts/probar
// Body: datos SNMP sueltos (misma forma que Olt) — prueba credenciales ANTES
// de guardar, usando solo OID estándar (ver utils/oltHuawei.ts).
oltsRouter.post("/probar", async (req: Request, res: Response) => {
  try {
    const { direccionIp, snmpPuerto, snmpVersion, snmpComunidad, snmpUsuario, snmpAuthProtocolo, snmpAuthPassword, snmpPrivProtocolo, snmpPrivPassword } = req.body;
    if (!direccionIp) return res.status(400).json({ error: "direccionIp es obligatoria" });

    const estado = await probarConexionSnmp({
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

// POST /olts/probar-ssh
// Body: { direccionIp, sshPuerto?, sshUsuario, sshPassword } — prueba
// credenciales SSH ANTES de guardar, mismo criterio que /olts/probar (SNMP).
oltsRouter.post("/probar-ssh", async (req: Request, res: Response) => {
  try {
    const { direccionIp, sshPuerto, sshUsuario, sshPassword } = req.body;
    if (!direccionIp || !sshUsuario || !sshPassword) {
      return res.status(400).json({ error: "direccionIp, sshUsuario y sshPassword son obligatorios" });
    }
    const resumen = await probarConexionSsh({ direccionIp, sshPuerto: Number(sshPuerto) || 22, sshUsuario, sshPassword });
    res.json({ resumen });
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo conectar por SSH con esas credenciales" });
  }
});

// POST /olts
oltsRouter.post("/", async (req: Request, res: Response) => {
  try {
    const {
      nombre, modelo, direccionIp, snmpPuerto, snmpVersion, snmpComunidad,
      snmpUsuario, snmpAuthProtocolo, snmpAuthPassword, snmpPrivProtocolo, snmpPrivPassword,
      sshPuerto, sshUsuario, sshPassword,
      ubicacion, nodoId,
    } = req.body;

    if (!nombre || !modelo || !direccionIp) {
      return res.status(400).json({ error: "nombre, modelo y direccionIp son obligatorios" });
    }
    if (!MODELOS_VALIDOS.includes(modelo)) {
      return res.status(400).json({ error: `modelo debe ser uno de: ${MODELOS_VALIDOS.join(", ")}` });
    }

    const olt = await prisma.olt.create({
      data: {
        nombre,
        modelo,
        direccionIp,
        snmpPuerto: snmpPuerto ? Number(snmpPuerto) : 161,
        snmpVersion: snmpVersion || "2c",
        snmpComunidad: snmpComunidad || null,
        snmpUsuario: snmpUsuario || null,
        snmpAuthProtocolo: snmpAuthProtocolo || null,
        snmpAuthPassword: snmpAuthPassword || null,
        snmpPrivProtocolo: snmpPrivProtocolo || null,
        snmpPrivPassword: snmpPrivPassword || null,
        sshPuerto: sshPuerto ? Number(sshPuerto) : 22,
        sshUsuario: sshUsuario || null,
        sshPassword: sshPassword || null,
        ubicacion: ubicacion || null,
        nodoId: nodoId ? Number(nodoId) : null,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_OLT",
      entidad: "Olt",
      entidadId: olt.id,
      detalle: `${olt.nombre} (${olt.modelo}, ${olt.direccionIp})`,
    });

    // Primera sincronización, mejor esfuerzo — si la OLT no responde en este
    // momento la ficha de todos modos queda creada; se puede reintentar con
    // "Sincronizar ahora".
    let advertenciaSnmp: string | undefined;
    try {
      await sincronizarOlt(olt.id);
    } catch (error: any) {
      advertenciaSnmp = `La OLT se creó, pero no se pudo sincronizar por SNMP: ${error?.message || "error desconocido"}. Podés reintentar con "Sincronizar ahora".`;
    }

    res.status(201).json({ ...sinCredenciales(olt), advertenciaSnmp });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear la OLT" });
  }
});

// PUT /olts/:id
// Los 3 campos secretos vacíos/omitidos = no cambiar los que ya tenía.
oltsRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const {
      nombre, modelo, direccionIp, snmpPuerto, snmpVersion, snmpComunidad,
      snmpUsuario, snmpAuthProtocolo, snmpAuthPassword, snmpPrivProtocolo, snmpPrivPassword,
      sshPuerto, sshUsuario, sshPassword,
      ubicacion, nodoId,
    } = req.body;

    if (!nombre || !modelo || !direccionIp) {
      return res.status(400).json({ error: "nombre, modelo y direccionIp son obligatorios" });
    }
    if (!MODELOS_VALIDOS.includes(modelo)) {
      return res.status(400).json({ error: `modelo debe ser uno de: ${MODELOS_VALIDOS.join(", ")}` });
    }

    const olt = await prisma.olt.update({
      where: { id },
      data: {
        nombre,
        modelo,
        direccionIp,
        snmpPuerto: snmpPuerto ? Number(snmpPuerto) : 161,
        snmpVersion: snmpVersion || "2c",
        ...(snmpComunidad ? { snmpComunidad } : {}),
        snmpUsuario: snmpUsuario || null,
        snmpAuthProtocolo: snmpAuthProtocolo || null,
        ...(snmpAuthPassword ? { snmpAuthPassword } : {}),
        snmpPrivProtocolo: snmpPrivProtocolo || null,
        ...(snmpPrivPassword ? { snmpPrivPassword } : {}),
        sshPuerto: sshPuerto ? Number(sshPuerto) : 22,
        sshUsuario: sshUsuario || null,
        ...(sshPassword ? { sshPassword } : {}),
        ubicacion: ubicacion || null,
        nodoId: nodoId ? Number(nodoId) : null,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_OLT",
      entidad: "Olt",
      entidadId: olt.id,
      detalle: `${olt.nombre} (${olt.modelo}, ${olt.direccionIp})`,
    });

    res.json(sinCredenciales(olt));
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "OLT no encontrada" });
    console.error(error);
    res.status(500).json({ error: "Error al editar la OLT" });
  }
});

// DELETE /olts/:id — borrado suave; las ONUs/eventos ya guardados se
// conservan (solo deja de sincronizarse y de aparecer como opción activa).
oltsRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const olt = await prisma.olt.update({ where: { id }, data: { activo: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_OLT",
      entidad: "Olt",
      entidadId: olt.id,
      detalle: olt.nombre,
    });

    res.json({ mensaje: "OLT desactivada", olt: sinCredenciales(olt) });
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "OLT no encontrada" });
    console.error(error);
    res.status(500).json({ error: "Error al desactivar la OLT" });
  }
});

// POST /olts/:id/sincronizar
oltsRouter.post("/:id/sincronizar", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const resultado = await sincronizarOlt(id);

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "SINCRONIZAR_OLT",
      entidad: "Olt",
      entidadId: id,
      detalle: `${resultado.totalDetectadas} ONU(s) detectadas — ${resultado.nuevas} nueva(s), ${resultado.actualizadas} actualizada(s), ${resultado.desaparecidas} desaparecida(s)`,
    });

    res.json(resultado);
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo sincronizar la OLT por SNMP" });
  }
});

// POST /olts/:id/puertos/consultar
// Body: { frame?, slot, puerto } — la "Vista por puerto GPON" del Mapa de
// Red: consulta AHORA MISMO por SSH todas las ONT de un puerto puntual (con
// temperatura y distancia, que SNMP no trae — ver utils/oltHuaweiSsh.ts),
// concilia contra OltOnu igual que sincronizarOlt (crea eventos en las
// transiciones de estado) y devuelve un resumen listo para pintar: si el
// puerto entero está caído (ningún ONT en línea, típico corte de fibra/tarjeta
// PON) contra si solo algunos clientes puntuales están mal.
oltsRouter.post("/:id/puertos/consultar", async (req: Request, res: Response) => {
  try {
    const oltId = Number(req.params.id);
    const frame = req.body.frame !== undefined ? Number(req.body.frame) : 0;
    const slot = Number(req.body.slot);
    const puerto = Number(req.body.puerto);
    if (!Number.isFinite(slot) || !Number.isFinite(puerto)) {
      return res.status(400).json({ error: "slot y puerto son obligatorios" });
    }

    const olt = await prisma.olt.findUnique({ where: { id: oltId } });
    if (!olt) return res.status(404).json({ error: "OLT no encontrada" });

    const configSsh = configSshDeOlt(olt);
    if (!configSsh) {
      return res.status(400).json({ error: "Esta OLT no tiene credenciales SSH configuradas — completalas en \"Editar\" para usar la Vista por puerto GPON." });
    }

    const detectadas = await listarOntsDePuertoSsh(configSsh, frame, slot, puerto);

    const filas = [];
    for (const ont of detectadas) {
      const previa = await prisma.oltOnu.findUnique({ where: { oltId_slot_puerto_onuIndex: { oltId, slot, puerto, onuIndex: ont.onuIndex } } });

      const actualizada = await prisma.oltOnu.upsert({
        where: { oltId_slot_puerto_onuIndex: { oltId, slot, puerto, onuIndex: ont.onuIndex } },
        create: {
          oltId,
          frame,
          slot,
          puerto,
          onuIndex: ont.onuIndex,
          serial: ont.serial || `SIN-SERIAL-${frame}.${slot}.${puerto}.${ont.onuIndex}`,
          estado: ont.estado,
          rxPowerDbm: ont.rxPowerDbm,
          txPowerDbm: ont.txPowerDbm,
          temperaturaCelsius: ont.temperaturaCelsius,
          distanciaMetros: ont.distanciaMetros,
          ipGestion: ont.ipGestion,
          ultimaLectura: new Date(),
          activo: true,
        },
        update: {
          frame,
          ...(ont.serial ? { serial: ont.serial } : {}),
          estado: ont.estado,
          rxPowerDbm: ont.rxPowerDbm,
          txPowerDbm: ont.txPowerDbm,
          temperaturaCelsius: ont.temperaturaCelsius,
          distanciaMetros: ont.distanciaMetros,
          ipGestion: ont.ipGestion,
          ultimaLectura: new Date(),
          activo: true,
        },
        include: { cliente: { select: { id: true, razonSocial: true, identificacion: true } } },
      });

      if (previa && previa.estado !== actualizada.estado) {
        await prisma.oltEvento.create({
          data: {
            oltId,
            oltOnuId: actualizada.id,
            tipo: actualizada.estado === "ONLINE" ? "ONU_ONLINE" : "ONU_OFFLINE",
            mensaje: `Serial ${actualizada.serial} (puerto ${frame}/${slot}/${puerto}, consulta manual por SSH)`,
          },
        });
      }

      const alerta =
        actualizada.estado === "ONLINE" &&
        ((actualizada.rxPowerDbm !== null && actualizada.rxPowerDbm.toNumber() < UMBRAL_SENAL_DEBIL_DBM) ||
          (actualizada.temperaturaCelsius !== null && actualizada.temperaturaCelsius.toNumber() > UMBRAL_TEMPERATURA_ALTA_C));

      filas.push({
        id: actualizada.id,
        onuIndex: actualizada.onuIndex,
        serial: actualizada.serial,
        estado: actualizada.estado,
        rxPowerDbm: actualizada.rxPowerDbm,
        txPowerDbm: actualizada.txPowerDbm,
        temperaturaCelsius: actualizada.temperaturaCelsius,
        distanciaMetros: actualizada.distanciaMetros,
        ipGestion: actualizada.ipGestion,
        cliente: actualizada.cliente,
        alerta,
      });
    }

    const total = filas.length;
    const enLinea = filas.filter((f) => f.estado === "ONLINE").length;
    const desconectadas = filas.filter((f) => f.estado === "OFFLINE").length;
    const conAlertas = filas.filter((f) => f.alerta).length;

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CONSULTAR_PUERTO_OLT",
      entidad: "Olt",
      entidadId: oltId,
      detalle: `Puerto ${frame}/${slot}/${puerto}: ${total} ONT(s) — ${enLinea} en línea, ${desconectadas} desconectada(s), ${conAlertas} con alerta`,
    });

    res.json({
      frame,
      slot,
      puerto,
      totales: { total, enLinea, desconectadas, conAlertas },
      todoElPuertoCaido: total > 0 && enLinea === 0,
      onts: filas,
    });
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo consultar este puerto por SSH" });
  }
});

// POST /olts/:id/ssh/ejecutar
// Body: { comandos: string[] } — herramienta de calibración gemela de
// /explorar-oid pero para SSH (ver utils/oltHuaweiSsh.ts): manda los
// comandos tal cual el técnico los usaría a mano y devuelve la salida cruda
// completa de la consola, para comparar contra los parsers cuando
// /puertos/consultar no encuentra nada en un puerto que sí tiene ONTs.
oltsRouter.post("/:id/ssh/ejecutar", async (req: Request, res: Response) => {
  try {
    const oltId = Number(req.params.id);
    const comandos: string[] = Array.isArray(req.body.comandos) ? req.body.comandos.filter((c: unknown) => typeof c === "string" && c.trim()) : [];
    if (comandos.length === 0) return res.status(400).json({ error: "comandos (array de strings) es obligatorio" });

    const olt = await prisma.olt.findUnique({ where: { id: oltId } });
    if (!olt) return res.status(404).json({ error: "OLT no encontrada" });

    const configSsh = configSshDeOlt(olt);
    if (!configSsh) return res.status(400).json({ error: "Esta OLT no tiene credenciales SSH configuradas" });

    const salida = await ejecutarComandoSshCrudo(configSsh, comandos);
    res.json({ salida });
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo ejecutar el comando por SSH en la OLT" });
  }
});

// POST /olts/:id/explorar-oid
// Body: { oidBase } — herramienta de calibración (ver utils/oltHuawei.ts):
// devuelve crudo lo que la OLT responde bajo ese OID, para comparar contra
// OIDS_HUAWEI_GPON cuando listarOnusDeOlt no encuentra nada en un equipo que
// sí tiene ONUs conectadas. Se limita a 500 filas para no devolver una
// respuesta gigante si el OID base es demasiado amplio.
oltsRouter.post("/:id/explorar-oid", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { oidBase } = req.body;
    if (!oidBase) return res.status(400).json({ error: "oidBase es obligatorio" });

    const olt = await prisma.olt.findUnique({ where: { id } });
    if (!olt) return res.status(404).json({ error: "OLT no encontrada" });

    const filas = await explorarOid(configSnmpDeOlt(olt), oidBase);
    res.json({ total: filas.length, filas: filas.slice(0, 500), truncado: filas.length > 500 });
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo explorar ese OID en la OLT" });
  }
});

// GET /olts/:id/onus
oltsRouter.get("/:id/onus", async (req: Request, res: Response) => {
  try {
    const oltId = Number(req.params.id);
    const incluirInactivas = req.query.incluirInactivas === "true";
    const onus = await prisma.oltOnu.findMany({
      where: { oltId, ...(incluirInactivas ? {} : { activo: true }) },
      include: { cliente: { select: { id: true, razonSocial: true, identificacion: true } } },
      orderBy: [{ slot: "asc" }, { puerto: "asc" }, { onuIndex: "asc" }],
    });
    res.json(onus);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las ONUs de esta OLT" });
  }
});

// PATCH /olts/:id/onus/:onuId/asignar-cliente
// Body: { clienteId: number | null } — null desvincula. Esta es la única
// acción de "aprovisionamiento" de este módulo: solo registra en nuestra
// base qué cliente corresponde a esta ONU, nunca toca la configuración real
// de la OLT (ver comentario de alcance al inicio del archivo).
oltsRouter.patch("/:id/onus/:onuId/asignar-cliente", async (req: Request, res: Response) => {
  try {
    const oltId = Number(req.params.id);
    const onuId = Number(req.params.onuId);
    const { clienteId } = req.body;

    const onu = await prisma.oltOnu.findFirst({ where: { id: onuId, oltId } });
    if (!onu) return res.status(404).json({ error: "ONU no encontrada en esta OLT" });

    if (clienteId !== null && clienteId !== undefined) {
      const cliente = await prisma.cliente.findUnique({ where: { id: Number(clienteId) } });
      if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const actualizada = await prisma.oltOnu.update({
      where: { id: onuId },
      data: { clienteId: clienteId === null || clienteId === undefined ? null : Number(clienteId) },
      include: { cliente: { select: { id: true, razonSocial: true, identificacion: true } } },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: actualizada.clienteId ? "ASIGNAR_CLIENTE_ONU" : "DESASIGNAR_CLIENTE_ONU",
      entidad: "OltOnu",
      entidadId: onu.id,
      detalle: `Serial ${onu.serial}${actualizada.cliente ? ` -> ${actualizada.cliente.razonSocial}` : ""}`,
    });

    res.json(actualizada);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al asignar el cliente a esta ONU" });
  }
});

// GET /olts/:id/eventos
oltsRouter.get("/:id/eventos", async (req: Request, res: Response) => {
  try {
    const oltId = Number(req.params.id);
    const oltOnuId = req.query.oltOnuId ? Number(req.query.oltOnuId) : undefined;
    const eventos = await prisma.oltEvento.findMany({
      where: { oltId, ...(oltOnuId ? { oltOnuId } : {}) },
      include: { oltOnu: { select: { id: true, serial: true, slot: true, puerto: true, onuIndex: true } } },
      orderBy: { fecha: "desc" },
      take: 200,
    });
    res.json(eventos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los eventos de esta OLT" });
  }
});
