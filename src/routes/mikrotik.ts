// Control de red del ISP vía Mikrotik — TODAS las rutas acá son relativas a
// UN nodo en particular (ver NodoRed en schema.prisma), montadas en
// index.ts como "/mikrotik/:nodoId" — la empresa tiene varios nodos, cada
// uno con su propio router. El permiso "mikrotik" (ver utils/permisos.ts)
// ya se aplica a nivel de router en index.ts.
//
// No hay herramientas de PPPoE ni de Simple Queue acá a propósito: la red
// real de la empresa es IP fija por address-list (no PPPoE), y la
// velocidad se aprovisiona en la OLT, no en el Mikrotik (ver
// utils/mikrotik.ts) — un panel de "Cuentas PPPoE" o "Queues" no reflejaría
// cómo opera el negocio. Lo que sí hay es un visor genérico de
// address-lists, para diagnóstico manual más allá de lo que ya administra
// el vínculo con Cliente (ver routes/clientes.ts).
import { Router, Request, Response } from "express";
import {
  probarConexion,
  listarIpsSuspendidas,
  suspenderClientePorIp,
  reactivarClientePorIp,
  listarTodasLasEntradasAddressList,
  eliminarEntradaAddressList,
  listarVecinos,
} from "../utils/mikrotik";
import { registrarAuditoria } from "../utils/auditoria";
import { prisma } from "../db";

export const mikrotikRouter = Router({ mergeParams: true });

// Envuelve cada ruta para no repetir el try/catch de error de conexión en
// cada handler, y para sacar/validar el nodoId de la URL una sola vez.
function manejar(fn: (req: Request, res: Response, nodoId: number) => Promise<any>) {
  return async (req: Request, res: Response) => {
    const nodoId = Number(req.params.nodoId);
    if (!Number.isInteger(nodoId)) {
      return res.status(400).json({ error: "nodoId inválido" });
    }
    try {
      await fn(req, res, nodoId);
    } catch (error: any) {
      console.error("Error de Mikrotik:", error);
      res.status(502).json({ error: error?.message || "No se pudo completar la operación en el Mikrotik" });
    }
  };
}

// GET /mikrotik/:nodoId/estado — para la pantalla de Nodos: confirma que el
// servidor efectivamente llega al router de ESE nodo (identidad + versión
// + uptime), y registra el momento como "última conexión exitosa" — así
// "sin conexión desde hace X" (ver GET /nodos-red) queda guardado en la
// base, no depende de que alguien tenga la pantalla abierta.
mikrotikRouter.get("/estado", manejar(async (_req, res, nodoId) => {
  const estado = await probarConexion(nodoId);
  await prisma.nodoRed.update({ where: { id: nodoId }, data: { ultimaConexionExitosa: new Date() } });
  res.json(estado);
}));

// GET /mikrotik/:nodoId/vecinos — equipos que el router de este nodo
// descubrió por MNDP en su propio segmento de red (identidad, IP, MAC,
// versión, placa) — el equivalente a la ventana "Neighbors" de WinBox, pero
// de solo lectura: no permite entrar a configurar nada de esos equipos.
mikrotikRouter.get("/vecinos", manejar(async (_req, res, nodoId) => {
  res.json(await listarVecinos(nodoId));
}));

// --- Clientes por IP fija (address-list) — mecanismo real de la red, ver
// utils/mikrotik.ts. Suspender/reactivar acá es de uso general (ej. desde
// el visor genérico); el flujo normal para un Cliente del sistema pasa por
// estas mismas rutas desde ClientesPage.tsx, que además sabe el nombre del
// cliente para la auditoría.

// GET /mikrotik/:nodoId/ips-suspendidas — para cruzar contra
// Cliente.direccionIp en el frontend y saber quién está suspendido ahora
// mismo (solo entre los clientes de ESTE nodo).
mikrotikRouter.get("/ips-suspendidas", manejar(async (_req, res, nodoId) => {
  res.json(await listarIpsSuspendidas(nodoId));
}));

mikrotikRouter.patch("/direcciones/:ip/suspender", manejar(async (req, res, nodoId) => {
  const ip = String(req.params.ip);
  const comentario = req.body?.comentario;
  await suspenderClientePorIp(nodoId, ip, comentario);
  await registrarAuditoria(prisma, {
    usuarioId: req.usuario!.usuarioId,
    accion: "SUSPENDER_CLIENTE_ISP",
    entidad: "MikrotikAddressList",
    detalle: ip,
  });
  res.json({ mensaje: "Cliente suspendido" });
}));

mikrotikRouter.patch("/direcciones/:ip/reactivar", manejar(async (req, res, nodoId) => {
  const ip = String(req.params.ip);
  await reactivarClientePorIp(nodoId, ip);
  await registrarAuditoria(prisma, {
    usuarioId: req.usuario!.usuarioId,
    accion: "REACTIVAR_CLIENTE_ISP",
    entidad: "MikrotikAddressList",
    detalle: ip,
  });
  res.json({ mensaje: "Cliente reactivado" });
}));

// --- Visor genérico de address-lists (pantalla Control Mikrotik) ---

// GET /mikrotik/:nodoId/address-lists — TODAS las entradas del router de
// este nodo (no solo las de "Suspendido"), para poder ver de un vistazo qué
// hay cargado y detectar entradas huérfanas.
mikrotikRouter.get("/address-lists", manejar(async (_req, res, nodoId) => {
  res.json(await listarTodasLasEntradasAddressList(nodoId));
}));

// DELETE /mikrotik/:nodoId/address-lists/:id — borra UNA entrada suelta por
// su ".id" de RouterOS (ej. limpieza de un cliente que ya no existe en el
// sistema). No pasa por routes/clientes.ts porque es intencionalmente una
// acción de mantenimiento manual del router, no del ciclo de vida normal
// de un Cliente.
mikrotikRouter.delete("/address-lists/:id", manejar(async (req, res, nodoId) => {
  const id = String(req.params.id);
  await eliminarEntradaAddressList(nodoId, id);
  await registrarAuditoria(prisma, {
    usuarioId: req.usuario!.usuarioId,
    accion: "ELIMINAR_ENTRADA_ADDRESS_LIST",
    entidad: "MikrotikAddressList",
    detalle: id,
  });
  res.json({ mensaje: "Entrada eliminada" });
}));
