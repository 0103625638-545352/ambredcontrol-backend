// Catálogo de nodos de red del ISP — cada nodo es un punto de conexión
// físico (ej. un armario de un sector) con su propio Mikrotik a cargo de
// los clientes de esa zona (ver NodoRed en schema.prisma). Mismo criterio
// de CRUD con borrado suave que routes/planesInternet.ts, gateado por el
// permiso "mikrotik".
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { registrarAuditoria } from "../utils/auditoria";
import {
  cerrarConexionNodo,
  probarConexionAdHoc,
  configurarReglasSuspension,
  estadoReglasSuspension,
  respaldarConfiguracionNodo,
  restaurarConfiguracionNodo,
  listarVlans,
  crearVlanEnRouter,
  editarVlanEnRouter,
  eliminarVlanDelRouter,
  type RespaldoContenido,
} from "../utils/mikrotik";

export const nodosRedRouter = Router();

// Nunca se expone mikrotikPassword al frontend — ni en la lista ni al
// traer uno solo. Se manda de vuelta solo cuando el propio formulario de
// edición lo necesita para precargar... en realidad tampoco: el frontend
// simplemente deja el campo vacío al editar (igual criterio que
// CERTIFICADO_P12_PASSWORD en Ajustes) — "vacío" significa "no cambiar".
function sinPassword<T extends { mikrotikPassword: string }>(nodo: T) {
  const { mikrotikPassword, ...resto } = nodo;
  return resto;
}

// GET /nodos-red
nodosRedRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const nodos = await prisma.nodoRed.findMany({ where: { activo: true }, orderBy: { nombre: "asc" } });
    res.json(nodos.map(sinPassword));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los nodos de red" });
  }
});

function ipAEntero(ip: string): number {
  return ip.split(".").reduce((acumulado, octeto) => (acumulado << 8) + Number(octeto), 0) >>> 0;
}
function enteroAIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

// Compartido entre GET /:id/ips-libres (rango del nodo completo) y GET
// /:id/vlans/:vlanNodoId/ips-libres (rango de una VLAN puntual) — mismo
// criterio en los dos: no reserva nada ni gestiona un pool real, solo
// compara el rango contra las IPs YA asignadas a algún cliente en la base
// (direccionIp es única en todo el sistema, sin importar nodo/VLAN).
async function calcularIpsLibres(rangoIpInicio: string | null, rangoIpFin: string | null, ipAExcluir: string): Promise<string[]> {
  if (!rangoIpInicio || !rangoIpFin) return [];

  const inicio = ipAEntero(rangoIpInicio);
  const fin = ipAEntero(rangoIpFin);
  if (fin < inicio) throw new Error("El rango de IP está invertido (fin antes que inicio)");
  if (fin - inicio > 20_000) throw new Error("El rango es demasiado grande para sugerir IPs libres — ingrésala a mano");

  const usadas = new Set([
    ipAExcluir,
    ...(await prisma.cliente.findMany({ where: { direccionIp: { not: null } }, select: { direccionIp: true } })).map((c) => c.direccionIp),
  ]);

  const LIMITE = 2000;
  const libres: string[] = [];
  for (let n = inicio; n <= fin && libres.length < LIMITE; n++) {
    const ip = enteroAIp(n);
    if (!usadas.has(ip)) libres.push(ip);
  }
  return libres;
}

// GET /nodos-red/:id/ips-libres
// Sugerencias de IP libre dentro del rango del nodo, para el formulario de
// Cliente cuando NO elige una VLAN puntual (ver GET
// /:id/vlans/:vlanNodoId/ips-libres para el caso con VLAN).
nodosRedRouter.get("/:id/ips-libres", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const nodo = await prisma.nodoRed.findUnique({ where: { id } });
    if (!nodo) return res.status(404).json({ error: "Nodo de red no encontrado" });
    res.json(await calcularIpsLibres(nodo.rangoIpInicio, nodo.rangoIpFin, nodo.mikrotikHost));
  } catch (error: any) {
    if (error instanceof Error && (error.message.includes("invertido") || error.message.includes("demasiado grande"))) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: "Error al calcular las IPs libres de este nodo" });
  }
});

// --- VLANs de un nodo — ver comentario en el modelo VlanNodo
// (schema.prisma) sobre por qué esto es organizativo/informativo y no
// cambia la lógica de suspensión.

// GET /nodos-red/:id/vlans
nodosRedRouter.get("/:id/vlans", async (req: Request, res: Response) => {
  try {
    const nodoId = Number(req.params.id);
    const vlans = await prisma.vlanNodo.findMany({ where: { nodoId, activo: true }, orderBy: { vlanId: "asc" } });
    res.json(vlans);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las VLANs de este nodo" });
  }
});

// GET /nodos-red/:id/vlans/detectar
// Lee AHORA MISMO del Mikrotik qué VLANs tiene configuradas — no guarda
// nada, solo devuelve lo que encontró para que el admin elija cuáles
// importar (ver POST /:id/vlans). Read-only, seguro de llamar en cualquier
// momento.
nodosRedRouter.get("/:id/vlans/detectar", async (req: Request, res: Response) => {
  try {
    const nodoId = Number(req.params.id);
    const detectadas = await listarVlans(nodoId);
    res.json(detectadas);
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo consultar las VLANs en el Mikrotik" });
  }
});

// POST /nodos-red/:id/vlans
// Body: { nombre, vlanId, interfaz?, mascaraRed?, rangoIpInicio?, rangoIpFin?, yaExisteEnRouter? }
// "yaExisteEnRouter: true" es lo que manda el botón "Importar" de "Detectar
// VLANs" — esa VLAN ya está configurada en el Mikrotik, así que esto solo
// la guarda en el catálogo. Sin ese flag (el formulario "+ Agregar VLAN"),
// además de guardarla se CREA la interfaz VLAN de verdad en el router
// (requiere "interfaz", que ahí es la interfaz física/bridge padre) — si el
// Mikrotik la rechaza (ID repetido, interfaz padre inexistente, etc.) no se
// guarda nada en el catálogo, para no quedar con un registro que no
// corresponde a la configuración real del equipo.
nodosRedRouter.post("/:id/vlans", async (req: Request, res: Response) => {
  try {
    const nodoId = Number(req.params.id);
    const nodo = await prisma.nodoRed.findUnique({ where: { id: nodoId } });
    if (!nodo) return res.status(404).json({ error: "Nodo de red no encontrado" });

    const { nombre, vlanId, interfaz, mascaraRed, rangoIpInicio, rangoIpFin, yaExisteEnRouter } = req.body;
    if (!nombre || vlanId === undefined || vlanId === null || vlanId === "") {
      return res.status(400).json({ error: "nombre y vlanId son obligatorios" });
    }
    if (!yaExisteEnRouter && !interfaz) {
      return res.status(400).json({ error: "La interfaz padre es obligatoria para crear la VLAN en el Mikrotik" });
    }

    if (!yaExisteEnRouter) {
      try {
        await crearVlanEnRouter(nodoId, { nombre, vlanId: Number(vlanId), interfaz });
      } catch (error: any) {
        return res.status(502).json({ error: error?.message || "No se pudo crear la VLAN en el Mikrotik" });
      }
    }

    const vlan = await prisma.vlanNodo.create({
      data: {
        nodoId,
        nombre,
        vlanId: Number(vlanId),
        interfaz: interfaz || null,
        mascaraRed: mascaraRed ? Number(mascaraRed) : null,
        rangoIpInicio: rangoIpInicio || null,
        rangoIpFin: rangoIpFin || null,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_VLAN_NODO",
      entidad: "VlanNodo",
      entidadId: vlan.id,
      detalle: `${nodo.nombre}: ${vlan.nombre} (VLAN ${vlan.vlanId})`,
    });

    res.status(201).json(vlan);
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe una VLAN con ese ID guardada en este nodo" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear la VLAN" });
  }
});

// PUT /nodos-red/:id/vlans/:vlanNodoId
// Igual que al crear: primero se aplica el cambio de verdad en el Mikrotik
// (buscando la interfaz por el nombre que tenía ANTES de este edit) y solo
// si eso funciona se actualiza el catálogo — así nunca queda un registro
// "editado" que no corresponde a lo que el router realmente tiene.
nodosRedRouter.put("/:id/vlans/:vlanNodoId", async (req: Request, res: Response) => {
  try {
    const nodoId = Number(req.params.id);
    const vlanNodoId = Number(req.params.vlanNodoId);
    const { nombre, vlanId, interfaz, mascaraRed, rangoIpInicio, rangoIpFin } = req.body;
    if (!nombre || vlanId === undefined || vlanId === null || vlanId === "") {
      return res.status(400).json({ error: "nombre y vlanId son obligatorios" });
    }
    if (!interfaz) {
      return res.status(400).json({ error: "La interfaz padre es obligatoria para editar la VLAN en el Mikrotik" });
    }

    const existente = await prisma.vlanNodo.findFirst({ where: { id: vlanNodoId, nodoId } });
    if (!existente) return res.status(404).json({ error: "VLAN no encontrada en este nodo" });

    try {
      await editarVlanEnRouter(nodoId, existente.nombre, { nombre, vlanId: Number(vlanId), interfaz });
    } catch (error: any) {
      return res.status(502).json({ error: error?.message || "No se pudo editar la VLAN en el Mikrotik" });
    }

    const vlan = await prisma.vlanNodo.update({
      where: { id: vlanNodoId },
      data: {
        nombre,
        vlanId: Number(vlanId),
        interfaz: interfaz || null,
        mascaraRed: mascaraRed ? Number(mascaraRed) : null,
        rangoIpInicio: rangoIpInicio || null,
        rangoIpFin: rangoIpFin || null,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_VLAN_NODO",
      entidad: "VlanNodo",
      entidadId: vlan.id,
      detalle: `${vlan.nombre} (VLAN ${vlan.vlanId})`,
    });

    res.json(vlan);
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe una VLAN con ese ID guardada en este nodo" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar la VLAN" });
  }
});

// DELETE /nodos-red/:id/vlans/:vlanNodoId
// Elimina la interfaz VLAN de verdad del Mikrotik y RECIÉN si eso funciona
// (o si ya no estaba ahí) hace el borrado suave en el catálogo — los
// clientes que ya están vinculados a esta VLAN la conservan igual, solo
// deja de aparecer como opción para clientes nuevos. Si el router rechaza
// el remove (ej. la interfaz sigue en uso en otra config), no se toca el
// catálogo, para no quedar con un registro "desactivado" que sigue viva en
// el equipo real.
nodosRedRouter.delete("/:id/vlans/:vlanNodoId", async (req: Request, res: Response) => {
  try {
    const nodoId = Number(req.params.id);
    const vlanNodoId = Number(req.params.vlanNodoId);
    const existente = await prisma.vlanNodo.findFirst({ where: { id: vlanNodoId, nodoId } });
    if (!existente) return res.status(404).json({ error: "VLAN no encontrada en este nodo" });

    try {
      await eliminarVlanDelRouter(nodoId, existente.nombre);
    } catch (error: any) {
      return res.status(502).json({ error: error?.message || "No se pudo eliminar la VLAN en el Mikrotik" });
    }

    const vlan = await prisma.vlanNodo.update({ where: { id: vlanNodoId }, data: { activo: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_VLAN_NODO",
      entidad: "VlanNodo",
      entidadId: vlan.id,
      detalle: `${vlan.nombre} (VLAN ${vlan.vlanId})`,
    });

    res.json({ mensaje: "VLAN desactivada", vlan });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al desactivar la VLAN" });
  }
});

// GET /nodos-red/:id/vlans/:vlanNodoId/ips-libres
// Igual que GET /:id/ips-libres, pero acotado al rango de ESTA VLAN puntual
// — usado por el formulario de Cliente cuando se elige una VLAN dentro del
// nodo, en vez del rango plano de todo el nodo.
nodosRedRouter.get("/:id/vlans/:vlanNodoId/ips-libres", async (req: Request, res: Response) => {
  try {
    const nodoId = Number(req.params.id);
    const vlanNodoId = Number(req.params.vlanNodoId);
    const nodo = await prisma.nodoRed.findUnique({ where: { id: nodoId } });
    if (!nodo) return res.status(404).json({ error: "Nodo de red no encontrado" });
    const vlan = await prisma.vlanNodo.findFirst({ where: { id: vlanNodoId, nodoId } });
    if (!vlan) return res.status(404).json({ error: "VLAN no encontrada en este nodo" });

    res.json(await calcularIpsLibres(vlan.rangoIpInicio, vlan.rangoIpFin, nodo.mikrotikHost));
  } catch (error: any) {
    if (error instanceof Error && (error.message.includes("invertido") || error.message.includes("demasiado grande"))) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: "Error al calcular las IPs libres de esta VLAN" });
  }
});

// POST /nodos-red/probar
// Body: { mikrotikHost, mikrotikPuerto?, mikrotikUsuario, mikrotikPassword }
// Prueba credenciales sueltas ANTES de guardar el nodo (ver utils/mikrotik.ts).
nodosRedRouter.post("/probar", async (req: Request, res: Response) => {
  try {
    const { mikrotikHost, mikrotikPuerto, mikrotikUsuario, mikrotikPassword } = req.body;
    if (!mikrotikHost || !mikrotikUsuario || !mikrotikPassword) {
      return res.status(400).json({ error: "mikrotikHost, mikrotikUsuario y mikrotikPassword son obligatorios" });
    }
    const estado = await probarConexionAdHoc({
      host: mikrotikHost,
      port: Number(mikrotikPuerto) || 8728,
      user: mikrotikUsuario,
      password: mikrotikPassword,
    });
    res.json(estado);
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo conectar con esas credenciales" });
  }
});

// GET /nodos-red/:id/estado-suspension
// Solo lectura (a diferencia de POST /:id/configurar-suspension) — para que
// NodosPage.tsx pueda mostrar "Reglas configuradas" o "Configurar reglas"
// según el estado REAL del router en este momento, no según si alguna vez
// se corrió el botón (alguien pudo haberlas borrado a mano después).
nodosRedRouter.get("/:id/estado-suspension", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const estado = await estadoReglasSuspension(id);
    res.json(estado);
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo consultar el estado de las reglas en el Mikrotik" });
  }
});

// POST /nodos-red/:id/configurar-suspension
// Crea (si hace falta) las reglas de Filter Rules que hacen que la lista
// "Suspendido" corte de verdad el tráfico (ver utils/mikrotik.ts) — se
// llama sola al crear un nodo nuevo; esta ruta es para reintentar a mano
// (falló la primera vez) o para ponerse al día los nodos que ya existían
// antes de que esto se automatizara.
nodosRedRouter.post("/:id/configurar-suspension", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const resultado = await configurarReglasSuspension(id);

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CONFIGURAR_REGLAS_SUSPENSION",
      entidad: "NodoRed",
      entidadId: id,
      detalle: `Creadas: ${resultado.creadas.join(", ") || "ninguna"} · Ya existían: ${resultado.yaExistian.join(", ") || "ninguna"}`,
    });

    res.json(resultado);
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudieron configurar las reglas en el Mikrotik" });
  }
});

// GET /nodos-red/:id/respaldos
// Historial de respaldos de configuración de este nodo, más reciente
// primero — solo los conteos (no el JSON completo, eso pesa y se pide aparte
// con GET /:id/respaldos/:respaldoId).
nodosRedRouter.get("/:id/respaldos", async (req: Request, res: Response) => {
  try {
    const nodoId = Number(req.params.id);
    const respaldos = await prisma.respaldoMikrotik.findMany({
      where: { nodoId },
      select: {
        id: true,
        createdAt: true,
        totalInterfaceLists: true,
        totalInterfaceListMembers: true,
        totalReglasFiltro: true,
        totalReglasNat: true,
        totalEntradasAddressList: true,
        usuario: { select: { id: true, nombre: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(respaldos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los respaldos de este nodo" });
  }
});

// GET /nodos-red/:id/respaldos/:respaldoId
// El contenido completo de un respaldo puntual — para descargar/inspeccionar.
nodosRedRouter.get("/:id/respaldos/:respaldoId", async (req: Request, res: Response) => {
  try {
    const nodoId = Number(req.params.id);
    const respaldoId = Number(req.params.respaldoId);
    const respaldo = await prisma.respaldoMikrotik.findFirst({ where: { id: respaldoId, nodoId } });
    if (!respaldo) return res.status(404).json({ error: "Respaldo no encontrado" });
    res.json(respaldo);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener el respaldo" });
  }
});

// POST /nodos-red/:id/respaldos
// Lee AHORA MISMO del Mikrotik de este nodo sus listas de interfaces,
// reglas de firewall (filter y NAT) y address-lists, y las guarda como un
// respaldo nuevo — para poder reponerlas después si el equipo se daña (ver
// utils/mikrotik.ts).
nodosRedRouter.post("/:id/respaldos", async (req: Request, res: Response) => {
  try {
    const nodoId = Number(req.params.id);
    const nodo = await prisma.nodoRed.findUnique({ where: { id: nodoId } });
    if (!nodo) return res.status(404).json({ error: "Nodo de red no encontrado" });

    const contenido = await respaldarConfiguracionNodo(nodoId);

    const respaldo = await prisma.respaldoMikrotik.create({
      data: {
        nodoId,
        contenido: contenido as any,
        totalInterfaceLists: contenido.interfaceLists.length,
        totalInterfaceListMembers: contenido.interfaceListMembers.length,
        totalReglasFiltro: contenido.firewallFilterRules.length,
        totalReglasNat: contenido.firewallNatRules.length,
        totalEntradasAddressList: contenido.addressListEntries.length,
        usuarioId: req.usuario!.usuarioId,
      },
      select: {
        id: true,
        createdAt: true,
        totalInterfaceLists: true,
        totalInterfaceListMembers: true,
        totalReglasFiltro: true,
        totalReglasNat: true,
        totalEntradasAddressList: true,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "RESPALDAR_MIKROTIK",
      entidad: "NodoRed",
      entidadId: nodoId,
      detalle: `${nodo.nombre}: ${contenido.interfaceLists.length} lista(s) de interfaces, ${contenido.firewallFilterRules.length} regla(s) de filtro, ${contenido.firewallNatRules.length} regla(s) NAT, ${contenido.addressListEntries.length} entrada(s) de address-list`,
    });

    res.status(201).json(respaldo);
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo respaldar la configuración del Mikrotik" });
  }
});

// POST /nodos-red/:id/respaldos/:respaldoId/restaurar
// Reaplica un respaldo guardado sobre el Mikrotik configurado ACTUALMENTE en
// este nodo (se asume que ya se reemplazó el equipo dañado y NodoRed.mikrotikHost
// apunta al reemplazo, de fábrica). Best-effort entrada por entrada — nunca
// se detiene por un solo error, ver utils/mikrotik.ts.
nodosRedRouter.post("/:id/respaldos/:respaldoId/restaurar", async (req: Request, res: Response) => {
  try {
    const nodoId = Number(req.params.id);
    const respaldoId = Number(req.params.respaldoId);
    const nodo = await prisma.nodoRed.findUnique({ where: { id: nodoId } });
    if (!nodo) return res.status(404).json({ error: "Nodo de red no encontrado" });

    const respaldo = await prisma.respaldoMikrotik.findFirst({ where: { id: respaldoId, nodoId } });
    if (!respaldo) return res.status(404).json({ error: "Respaldo no encontrado" });

    const resultado = await restaurarConfiguracionNodo(nodoId, respaldo.contenido as unknown as RespaldoContenido);

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "RESTAURAR_MIKROTIK",
      entidad: "NodoRed",
      entidadId: nodoId,
      detalle: `${nodo.nombre}: respaldo del ${respaldo.createdAt.toISOString()} — ${resultado.exitosos}/${resultado.total} aplicados`,
    });

    res.json(resultado);
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "No se pudo restaurar la configuración en el Mikrotik" });
  }
});

// PATCH /nodos-red/:id/ubicacion
// Body: { latitud, longitud } — separado del PUT normal de edición a
// propósito: se llama desde el mapa de Red Física (ver
// frontend/src/pages/RedFisicaPage.tsx), no desde el formulario de
// NodosPage.tsx. Sigue gateado por el permiso "mikrotik" del router (mismo
// criterio que el resto de este archivo) — mover dónde está ubicado un nodo
// es parte de administrar el nodo en sí, no del trazado de fibra.
nodosRedRouter.patch("/:id/ubicacion", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { latitud, longitud } = req.body;
    if (latitud === undefined || longitud === undefined) {
      return res.status(400).json({ error: "latitud y longitud son obligatorias" });
    }

    const nodo = await prisma.nodoRed.update({
      where: { id },
      data: { latitud: Number(latitud), longitud: Number(longitud) },
    });

    res.json(sinPassword(nodo));
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Nodo de red no encontrado" });
    console.error(error);
    res.status(500).json({ error: "Error al ubicar el nodo de red" });
  }
});

// POST /nodos-red
// Body: { nombre, descripcion?, mikrotikHost, mikrotikPuerto?, mikrotikUsuario, mikrotikPassword, mascaraRed?, rangoIpInicio?, rangoIpFin? }
nodosRedRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { nombre, descripcion, mikrotikHost, mikrotikPuerto, mikrotikUsuario, mikrotikPassword, mascaraRed, rangoIpInicio, rangoIpFin } = req.body;
    if (!nombre || !mikrotikHost || !mikrotikUsuario || !mikrotikPassword) {
      return res.status(400).json({ error: "nombre, mikrotikHost, mikrotikUsuario y mikrotikPassword son obligatorios" });
    }

    const nodo = await prisma.nodoRed.create({
      data: {
        nombre,
        descripcion: descripcion || null,
        mikrotikHost,
        mikrotikPuerto: mikrotikPuerto ? Number(mikrotikPuerto) : 8728,
        mikrotikUsuario,
        mikrotikPassword,
        mascaraRed: mascaraRed ? Number(mascaraRed) : null,
        rangoIpInicio: rangoIpInicio || null,
        rangoIpFin: rangoIpFin || null,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_NODO_RED",
      entidad: "NodoRed",
      entidadId: nodo.id,
      detalle: `${nodo.nombre} (${nodo.mikrotikHost})`,
    });

    // Deja el router del nodo listo para suspender clientes desde el minuto
    // uno (ver utils/mikrotik.ts) — best-effort: si el router está apagado
    // o las credenciales fallan en este momento puntual, el nodo de todos
    // modos queda creado; el admin puede reintentar luego con "Configurar
    // reglas" (ver PATCH /:id/configurar-suspension) o al editar el nodo.
    let advertenciaMikrotik: string | undefined;
    try {
      await configurarReglasSuspension(nodo.id);
    } catch (error: any) {
      advertenciaMikrotik = `El nodo se creó, pero no se pudieron configurar las reglas de suspensión en el Mikrotik: ${error?.message || "error desconocido"}. Podés reintentar luego con "Configurar reglas".`;
    }

    res.status(201).json({ ...sinPassword(nodo), advertenciaMikrotik });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear el nodo de red" });
  }
});

// PUT /nodos-red/:id
// mikrotikPassword vacío/omitido = no cambiar la que ya tenía guardada.
nodosRedRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre, descripcion, mikrotikHost, mikrotikPuerto, mikrotikUsuario, mikrotikPassword, mascaraRed, rangoIpInicio, rangoIpFin } = req.body;
    if (!nombre || !mikrotikHost || !mikrotikUsuario) {
      return res.status(400).json({ error: "nombre, mikrotikHost y mikrotikUsuario son obligatorios" });
    }

    const nodo = await prisma.nodoRed.update({
      where: { id },
      data: {
        nombre,
        descripcion: descripcion || null,
        mikrotikHost,
        mikrotikPuerto: mikrotikPuerto ? Number(mikrotikPuerto) : 8728,
        mikrotikUsuario,
        ...(mikrotikPassword ? { mikrotikPassword } : {}),
        mascaraRed: mascaraRed ? Number(mascaraRed) : null,
        rangoIpInicio: rangoIpInicio || null,
        rangoIpFin: rangoIpFin || null,
      },
    });

    // La conexión cacheada (si había una) quedó apuntando a las credenciales
    // VIEJAS — se cierra para que el próximo uso reconecte con las nuevas.
    await cerrarConexionNodo(id);

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_NODO_RED",
      entidad: "NodoRed",
      entidadId: nodo.id,
      detalle: `${nodo.nombre} (${nodo.mikrotikHost})`,
    });

    res.json(sinPassword(nodo));
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Nodo de red no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar el nodo de red" });
  }
});

// DELETE /nodos-red/:id
// Borrado suave: los clientes que ya pertenecen a este nodo lo conservan
// (nodoId no se limpia), solo deja de aparecer como opción para clientes
// nuevos. Coherente con el resto de catálogos del sistema (TipoPrecio,
// PlanInternet).
nodosRedRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const nodo = await prisma.nodoRed.update({ where: { id }, data: { activo: false } });
    await cerrarConexionNodo(id);

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_NODO_RED",
      entidad: "NodoRed",
      entidadId: nodo.id,
      detalle: nodo.nombre,
    });

    res.json({ mensaje: "Nodo de red desactivado", nodo: sinPassword(nodo) });
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Nodo de red no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al desactivar el nodo de red" });
  }
});
