// Mapa de Red: un solo endpoint de solo lectura que combina lo que ya
// recolectan otros módulos (ping ICMP, estado/señal de la ONU en la OLT,
// pulso de vida del Mikrotik del nodo) en un estado único por cliente, listo
// para pintar en el mapa (ver utils/estadoRedCliente.ts para la lógica de
// prioridad entre señales, y frontend/src/pages/MapaRedPage.tsx). Gateado
// por el permiso "mapa_red" (ver utils/permisos.ts), montado en index.ts.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { calcularEstadoCliente, type EntradaEstadoCliente } from "../utils/estadoRedCliente";

export const mapaRedRouter = Router();

// Ventana para contar "transiciones recientes" de una ONU (ver INESTABLE en
// estadoRedCliente.ts) — más allá de esto ya es historial viejo, no algo
// urgente para un técnico mirando el mapa ahora mismo.
const VENTANA_INESTABILIDAD_HORAS = 3;

function minutosDesde(fecha: Date | null): number | null {
  if (!fecha) return null;
  return Math.floor((Date.now() - fecha.getTime()) / 60000);
}

// GET /mapa-red/clientes
mapaRedRouter.get("/clientes", async (_req: Request, res: Response) => {
  try {
    const clientes = await prisma.cliente.findMany({
      where: { activo: true, latitud: { not: null }, longitud: { not: null } },
      select: {
        id: true,
        razonSocial: true,
        identificacion: true,
        direccionIp: true,
        latitud: true,
        longitud: true,
        pingUltimoMs: true,
        pingUltimoEstado: true,
        pingUltimaMedicion: true,
        nodo: { select: { id: true, nombre: true, ultimaConexionExitosa: true } },
      },
    });

    const clienteIds = clientes.map((c) => c.id);
    const onus = clienteIds.length
      ? await prisma.oltOnu.findMany({
          where: { clienteId: { in: clienteIds }, activo: true },
          select: { id: true, clienteId: true, serial: true, estado: true, rxPowerDbm: true, ultimaLectura: true },
        })
      : [];

    // Si un cliente llegara a tener más de una ONU activa vinculada (no
    // debería ser lo normal), se usa la de lectura más reciente.
    const onuPorCliente = new Map<number, (typeof onus)[number]>();
    for (const onu of onus) {
      if (!onu.clienteId) continue;
      const actual = onuPorCliente.get(onu.clienteId);
      if (!actual || (onu.ultimaLectura && (!actual.ultimaLectura || onu.ultimaLectura > actual.ultimaLectura))) {
        onuPorCliente.set(onu.clienteId, onu);
      }
    }

    const onuIds = onus.map((o) => o.id);
    const desde = new Date(Date.now() - VENTANA_INESTABILIDAD_HORAS * 60 * 60 * 1000);
    const transiciones = onuIds.length
      ? await prisma.oltEvento.groupBy({
          by: ["oltOnuId"],
          where: { oltOnuId: { in: onuIds }, tipo: { in: ["ONU_ONLINE", "ONU_OFFLINE"] }, fecha: { gte: desde } },
          _count: { _all: true },
        })
      : [];
    const transicionesPorOnu = new Map(transiciones.map((t) => [t.oltOnuId as number, t._count._all]));

    const resultado = clientes.map((c) => {
      const onu = onuPorCliente.get(c.id) ?? null;

      // "nunca se ha conectado" (nodo asignado pero ultimaConexionExitosa
      // null) se trata como caído desde siempre — Infinity siempre supera el
      // umbral de estadoRedCliente.ts, sin necesitar un caso especial ahí.
      const nodoMinutosSinConexion = c.nodo ? (c.nodo.ultimaConexionExitosa ? minutosDesde(c.nodo.ultimaConexionExitosa) ?? Infinity : Infinity) : null;

      const entrada: EntradaEstadoCliente = {
        pingEstado: (c.pingUltimoEstado as "OK" | "SIN_RESPUESTA" | null) ?? null,
        pingMs: c.pingUltimoMs,
        onuEstado: (onu?.estado as "ONLINE" | "OFFLINE" | null) ?? null,
        onuRxPowerDbm: onu?.rxPowerDbm ? onu.rxPowerDbm.toNumber() : null,
        onuSerial: onu?.serial ?? null,
        transicionesRecientes: onu ? transicionesPorOnu.get(onu.id) ?? 0 : 0,
        nodoNombre: c.nodo?.nombre ?? null,
        nodoMinutosSinConexion,
      };
      const { estado, detalle } = calcularEstadoCliente(entrada);

      return {
        id: c.id,
        razonSocial: c.razonSocial,
        identificacion: c.identificacion,
        direccionIp: c.direccionIp,
        latitud: c.latitud,
        longitud: c.longitud,
        estado,
        detalle,
        pingMs: c.pingUltimoMs,
        pingUltimaMedicion: c.pingUltimaMedicion,
        onu: onu ? { serial: onu.serial, estado: onu.estado, rxPowerDbm: onu.rxPowerDbm } : null,
        nodo: c.nodo ? { id: c.nodo.id, nombre: c.nodo.nombre } : null,
      };
    });

    res.json(resultado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al calcular el mapa de red" });
  }
});
