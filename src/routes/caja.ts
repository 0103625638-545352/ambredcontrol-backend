// Módulo de Caja: apertura/cierre de turno con arqueo. Todo el router
// (incluidos los GET) queda detrás de requirePermiso("caja") al montarlo en
// index.ts — a diferencia de traslados.ts, acá es información financiera
// sensible, no solo una acción mutante.
//
// Alcance: abrir/registrar movimiento/cerrar SIEMPRE usan la sucursal fija
// de quien hace la petición (sucursalDelUsuarioActual, nunca del body) — ni
// siquiera un ADMIN puede abrir la caja física de un local donde no está
// parado. Desde que existen puntos de venta (ver PuntoDeVenta en el
// schema), puede haber MÁS de una CajaSesion ABIERTA a la vez en la misma
// sucursal (una por punto de venta) — por eso "mi caja" ya no se resuelve
// por sucursal sino por quién la abrió (ver utils/cajaSesionActual.ts). La
// supervisión de TODAS las cajas abiertas a la vez (antes innecesaria,
// porque como mucho había una por sucursal) vive en GET /caja/abiertas.
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requirePermiso, requireAdmin } from "../middleware/auth";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerRangoFechas } from "../utils/rangoFechas";
import { registrarAuditoria } from "../utils/auditoria";
import { sucursalDelUsuarioActual } from "../utils/sucursales";
import { calcularEfectivoEsperado, calcularDiferenciaCierre, obtenerComponentesEfectivoCaja } from "../utils/caja";
import { cajaAbiertaDelUsuarioActual } from "../utils/cajaSesionActual";
import { puntoVentaValidoEnSucursal } from "../utils/puntosVenta";
import { lineasPorMovimientoCaja } from "../utils/contabilidad";
import { crearAsiento } from "../utils/asientos";

export const cajaRouter = Router();

const INCLUDE_SESION = {
  sucursal: true,
  puntoVenta: true,
  abiertaPor: { select: { id: true, nombre: true } },
  cerradaPor: { select: { id: true, nombre: true } },
} as const;

function esAdmin(req: Request): boolean {
  return req.usuario!.rol === "ADMIN";
}

// GET /caja/actual
// La sesión ABIERTA que YO abrí (o { sesion: null } si no tengo ninguna —
// es un estado válido, no un error) + los totales en vivo. Ya no depende de
// sucursal: puede haber otras cajas abiertas en mi mismo local a la vez, en
// otros puntos de venta — para verlas todas, ver GET /caja/abiertas (admin).
cajaRouter.get("/actual", async (req: Request, res: Response) => {
  try {
    const sesionAbierta = await cajaAbiertaDelUsuarioActual(req.usuario!.usuarioId);
    if (!sesionAbierta) return res.json({ sesion: null });

    const sesion = await prisma.cajaSesion.findUnique({
      where: { id: sesionAbierta.id },
      include: { ...INCLUDE_SESION, movimientos: { include: { usuario: { select: { id: true, nombre: true } } }, orderBy: { fecha: "desc" } } },
    });

    const componentes = await obtenerComponentesEfectivoCaja(sesion!, new Date());
    const efectivoEsperado = calcularEfectivoEsperado(componentes);

    res.json({
      sesion,
      componentes: {
        ventasEfectivo: componentes.ventasEfectivo.toFixed(2),
        comprasEfectivo: componentes.comprasEfectivo.toFixed(2),
        ingresosManuales: componentes.ingresosManuales.toFixed(2),
        egresosManuales: componentes.egresosManuales.toFixed(2),
      },
      efectivoEsperado: efectivoEsperado.toFixed(2),
    });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al consultar la caja actual" });
  }
});

// GET /caja/abiertas — vista de "control general": TODAS las cajas
// ABIERTAS ahora mismo, sin importar quién las abrió (antes innecesaria,
// porque como mucho había una por sucursal). Filtro opcional ?sucursalId=.
cajaRouter.get("/abiertas", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { sucursalId } = req.query;
    const sesiones = await prisma.cajaSesion.findMany({
      where: {
        estado: "ABIERTA",
        ...(sucursalId ? { sucursalId: Number(sucursalId) } : {}),
      },
      include: INCLUDE_SESION,
      orderBy: { abiertaEn: "asc" },
    });

    const conEfectivo = await Promise.all(
      sesiones.map(async (sesion) => {
        const componentes = await obtenerComponentesEfectivoCaja(sesion, new Date());
        return { ...sesion, efectivoEsperado: calcularEfectivoEsperado(componentes).toFixed(2) };
      })
    );

    res.json(conEfectivo);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las cajas abiertas" });
  }
});

// POST /caja/abrir
// Body: { montoInicial: number, puntoVentaId?: number }
// puntoVentaId es opcional: solo tiene sentido si la sucursal usa puntos de
// venta (ver PuntoDeVenta) — si no viene, se abre una caja "de sucursal
// completa", igual que siempre se hizo antes de que este módulo existiera.
cajaRouter.post("/abrir", requirePermiso("caja"), async (req: Request, res: Response) => {
  const { montoInicial, puntoVentaId } = req.body;

  if (typeof montoInicial !== "number" || montoInicial < 0) {
    return res.status(400).json({ error: "montoInicial debe ser un número mayor o igual a 0" });
  }

  try {
    const sucursal = await sucursalDelUsuarioActual(req.usuario!.usuarioId);
    const puntoVenta = await puntoVentaValidoEnSucursal(puntoVentaId, sucursal.id);

    const sesion = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const abierta = await tx.cajaSesion.findFirst({
        where: { sucursalId: sucursal.id, puntoVentaId: puntoVenta?.id ?? null, estado: "ABIERTA" },
        include: { abiertaPor: { select: { nombre: true } } },
      });
      if (abierta) {
        throw new Error(`CAJA_YA_ABIERTA:${abierta.abiertaPor.nombre}`);
      }

      const creada = await tx.cajaSesion.create({
        data: {
          sucursalId: sucursal.id,
          puntoVentaId: puntoVenta?.id,
          montoInicial: new Prisma.Decimal(montoInicial),
          abiertaPorId: req.usuario!.usuarioId,
        },
        include: INCLUDE_SESION,
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "ABRIR_CAJA",
        entidad: "CajaSesion",
        entidadId: creada.id,
        detalle: `${sucursal.nombre}${puntoVenta ? ` - ${puntoVenta.nombre}` : ""}: monto inicial $${creada.montoInicial.toFixed(2)}`,
      });

      return creada;
    });

    res.status(201).json(sesion);
  } catch (error: any) {
    if (error.message === "SIN_SUCURSAL_ASIGNADA") {
      return res.status(400).json({ error: "Tu usuario no tiene una sucursal asignada — pídele a un administrador que te asigne una" });
    }
    if (error.message === "PUNTO_VENTA_NO_ENCONTRADO") {
      return res.status(400).json({ error: "El punto de venta indicado no existe o está inactivo" });
    }
    if (error.message === "PUNTO_VENTA_NO_PERTENECE_A_SUCURSAL") {
      return res.status(400).json({ error: "Ese punto de venta no pertenece a tu sucursal" });
    }
    if (typeof error.message === "string" && error.message.startsWith("CAJA_YA_ABIERTA")) {
      return res.status(409).json({
        error: puntoVentaId
          ? `Ya hay una caja abierta en ese punto de venta (la abrió ${error.message.split(":")[1]}). Ciérrala antes de abrir una nueva.`
          : `Ya hay una caja abierta en tu sucursal (la abrió ${error.message.split(":")[1]}). Ciérrala antes de abrir una nueva.`,
      });
    }
    // Colisión de la capa 2 (índice único parcial) si dos aperturas llegaron
    // casi simultáneas y ambas pasaron el chequeo de arriba antes del commit.
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya hay una caja abierta en tu sucursal. Ciérrala antes de abrir una nueva." });
    }
    console.error(error);
    res.status(500).json({ error: "Error al abrir la caja" });
  }
});

// POST /caja/movimientos
// Body: { tipo: "INGRESO"|"EGRESO", monto: number, motivo: string }
cajaRouter.post("/movimientos", requirePermiso("caja"), async (req: Request, res: Response) => {
  const { tipo, monto, motivo } = req.body;

  if (tipo !== "INGRESO" && tipo !== "EGRESO") {
    return res.status(400).json({ error: 'tipo debe ser "INGRESO" o "EGRESO"' });
  }
  if (typeof monto !== "number" || monto <= 0) {
    return res.status(400).json({ error: "monto debe ser un número mayor a 0" });
  }
  if (!motivo || typeof motivo !== "string" || !motivo.trim()) {
    return res.status(400).json({ error: "motivo es obligatorio" });
  }

  try {
    const sesion = await cajaAbiertaDelUsuarioActual(req.usuario!.usuarioId);
    if (!sesion) {
      return res.status(409).json({ error: "No tienes una caja abierta. Ábrela primero." });
    }

    const movimiento = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const creado = await tx.movimientoCaja.create({
        data: { cajaSesionId: sesion.id, tipo, monto: new Prisma.Decimal(monto), motivo: motivo.trim(), usuarioId: req.usuario!.usuarioId },
        include: { usuario: { select: { id: true, nombre: true } } },
      });

      await crearAsiento(tx, {
        origen: "MOVIMIENTO_CAJA",
        origenId: creado.id,
        descripcion: `${tipo} de caja: ${creado.motivo}`,
        lineas: lineasPorMovimientoCaja({ tipo, monto: creado.monto }),
        usuarioId: req.usuario!.usuarioId,
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "REGISTRAR_MOVIMIENTO_CAJA",
        entidad: "MovimientoCaja",
        entidadId: creado.id,
        detalle: `${tipo} $${creado.monto.toFixed(2)}: ${creado.motivo}`,
      });

      return creado;
    });

    res.status(201).json(movimiento);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar el movimiento de caja" });
  }
});

// POST /caja/cerrar
// Body: { montoContado: number, observaciones?: string }
cajaRouter.post("/cerrar", requirePermiso("caja"), async (req: Request, res: Response) => {
  const { montoContado, observaciones } = req.body;

  if (typeof montoContado !== "number" || montoContado < 0) {
    return res.status(400).json({ error: "montoContado debe ser un número mayor o igual a 0" });
  }

  try {
    const sesion = await cajaAbiertaDelUsuarioActual(req.usuario!.usuarioId);
    if (!sesion) {
      return res.status(409).json({ error: "No tienes una caja abierta." });
    }

    const cerrada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const ahora = new Date();
      const componentes = await obtenerComponentesEfectivoCaja(sesion, ahora);
      const montoEsperado = calcularEfectivoEsperado(componentes);
      const montoContadoDecimal = new Prisma.Decimal(montoContado);
      const diferencia = calcularDiferenciaCierre(montoContadoDecimal, montoEsperado);

      const actualizada = await tx.cajaSesion.update({
        where: { id: sesion.id },
        data: {
          estado: "CERRADA",
          cerradaPorId: req.usuario!.usuarioId,
          cerradaEn: ahora,
          montoContado: montoContadoDecimal,
          montoEsperado,
          diferencia,
          observacionesCierre: observaciones || undefined,
        },
        include: INCLUDE_SESION,
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "CERRAR_CAJA",
        entidad: "CajaSesion",
        entidadId: actualizada.id,
        detalle: `${actualizada.sucursal.nombre}${actualizada.puntoVenta ? ` - ${actualizada.puntoVenta.nombre}` : ""}: diferencia $${diferencia.toFixed(2)} (${diferencia.isNeg() ? "faltante" : diferencia.isZero() ? "cuadró" : "sobrante"})`,
      });

      return actualizada;
    });

    res.json(cerrada);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al cerrar la caja" });
  }
});

// GET /caja/historial
cajaRouter.get("/historial", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const rango = leerRangoFechas(req);

    // ADMIN sin "?sucursalId=" ve todas las sucursales; con el query, se acota.
    // Cualquier otro usuario queda siempre forzado a la suya, sin excepción.
    const sucursalId = esAdmin(req)
      ? (req.query.sucursalId ? Number(req.query.sucursalId) : undefined)
      : (await sucursalDelUsuarioActual(req.usuario!.usuarioId)).id;

    const where: Prisma.CajaSesionWhereInput = {
      ...(rango ? { abiertaEn: rango } : {}),
      ...(sucursalId ? { sucursalId } : {}),
    };

    const opciones = { where, include: INCLUDE_SESION, orderBy: { abiertaEn: "desc" as const } };

    if (!paginacion.aplica) {
      const sesiones = await prisma.cajaSesion.findMany(opciones);
      return res.json(sesiones);
    }

    const [sesiones, total] = await Promise.all([
      prisma.cajaSesion.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.cajaSesion.count({ where }),
    ]);
    res.json(respuestaPaginada(sesiones, total, paginacion));
  } catch (error: any) {
    if (error.message === "SIN_SUCURSAL_ASIGNADA") {
      return res.status(400).json({ error: "Tu usuario no tiene una sucursal asignada — pídele a un administrador que te asigne una" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al listar el historial de caja" });
  }
});

// GET /caja/:id
cajaRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const sesion = await prisma.cajaSesion.findUnique({
      where: { id },
      include: { ...INCLUDE_SESION, movimientos: { include: { usuario: { select: { id: true, nombre: true } } }, orderBy: { fecha: "desc" } } },
    });
    if (!sesion) return res.status(404).json({ error: "Sesión de caja no encontrada" });

    if (!esAdmin(req)) {
      const sucursal = await sucursalDelUsuarioActual(req.usuario!.usuarioId);
      if (sesion.sucursalId !== sucursal.id) {
        return res.status(403).json({ error: "Esa sesión de caja no es de tu sucursal" });
      }
    }

    res.json(sesion);
  } catch (error: any) {
    if (error.message === "SIN_SUCURSAL_ASIGNADA") {
      return res.status(400).json({ error: "Tu usuario no tiene una sucursal asignada — pídele a un administrador que te asigne una" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al buscar la sesión de caja" });
  }
});
