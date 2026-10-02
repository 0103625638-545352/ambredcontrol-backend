// Egresos de bodega: el documento que arma bodega a primera hora del día
// para despachar equipos serializados puntuales (por número de serie) a un
// técnico — ver el comentario largo del modelo EgresoBodega en
// schema.prisma sobre por qué esto NO mueve stock ni genera
// MovimientoInventario, y por qué "clienteDestinoId" es solo informativo.
// Gateado por el mismo permiso "productos" que ya gatea el resto del
// control de números de serie (routes/productos.ts), salvo GET
// /mis-pendientes, que es self-service para cualquier técnico logueado
// viendo lo que él mismo tiene en mano — mismo criterio que GET
// /metraje/mis-rollos.
import { Router, Request, Response } from "express";
import { leerBusqueda, contiene } from "../utils/busquedaListado";
import { leerRangoFechas } from "../utils/rangoFechas";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requirePermiso } from "../middleware/auth";
import { registrarAuditoria } from "../utils/auditoria";

export const egresosBodegaRouter = Router();

const puedeAdministrar = requirePermiso("productos");

const INCLUDE_EGRESO = {
  empleado: { select: { id: true, nombres: true, apellidos: true } },
  clienteDestino: { select: { id: true, razonSocial: true, identificacion: true } },
  usuario: { select: { id: true, nombre: true } },
  detalles: {
    select: {
      id: true,
      estado: true,
      createdAt: true,
      numeroSerieProducto: {
        select: {
          id: true,
          numeroSerie: true,
          estado: true,
          clienteId: true,
          cliente: { select: { id: true, razonSocial: true } },
          producto: { select: { id: true, nombre: true, marca: true, modelo: true } },
        },
      },
    },
  },
} as const;

// GET /egresos-bodega?empleadoId=&abiertos=true
// "abiertos=true" trae solo los egresos con al menos una línea todavía
// EN_TRANSITO (ni entregada ni devuelta) — la vista normal de "qué anda
// pendiente ahora mismo".
egresosBodegaRouter.get("/", puedeAdministrar, async (req: Request, res: Response) => {
  try {
    const { empleadoId, abiertos, estado } = req.query;
    const rango = leerRangoFechas(req);
    const where: Prisma.EgresoBodegaWhereInput = {
      ...(empleadoId ? { empleadoId: Number(empleadoId) } : {}),
      ...(abiertos === "true" || estado === "PENDIENTE" ? { detalles: { some: { estado: "EN_TRANSITO" } } } : {}),
      ...(estado === "CERRADO" ? { detalles: { none: { estado: "EN_TRANSITO" } } } : {}),
      ...(rango ? { createdAt: rango } : {}),
    };

    // Buscador: técnico (nombres, apellidos o cédula), cliente destino,
    // observaciones, o un equipo del egreso (n° de serie o producto).
    const q = leerBusqueda(req);
    if (q) {
      where.OR = [
        { empleado: { nombres: contiene(q) } },
        { empleado: { apellidos: contiene(q) } },
        { empleado: { cedula: { contains: q } } },
        { clienteDestino: { razonSocial: contiene(q) } },
        { observaciones: contiene(q) },
        { detalles: { some: { numeroSerieProducto: { numeroSerie: contiene(q) } } } },
        { detalles: { some: { numeroSerieProducto: { producto: { nombre: contiene(q) } } } } },
      ];
    }

    const egresos = await prisma.egresoBodega.findMany({
      where,
      include: INCLUDE_EGRESO,
      orderBy: { createdAt: "desc" },
    });
    res.json(egresos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los egresos de bodega" });
  }
});

// GET /egresos-bodega/mis-pendientes — para el técnico logueado: todas SUS
// líneas todavía EN_TRANSITO, de cualquier egreso — lo que tiene en mano
// ahora mismo, listo para elegir en el acta de una visita (ver también GET
// /visitas/catalogo-equipos/:productoId/series, que filtra por esto mismo).
egresosBodegaRouter.get("/mis-pendientes", async (req: Request, res: Response) => {
  try {
    const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario!.usuarioId }, select: { empleadoId: true } });
    if (!usuario?.empleadoId) return res.json([]);

    const detalles = await prisma.egresoBodegaDetalle.findMany({
      where: { estado: "EN_TRANSITO", egreso: { empleadoId: usuario.empleadoId } },
      select: {
        id: true,
        createdAt: true,
        egreso: { select: { id: true, clienteDestino: { select: { id: true, razonSocial: true } } } },
        numeroSerieProducto: {
          select: { id: true, numeroSerie: true, producto: { select: { id: true, nombre: true, marca: true, modelo: true } } },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json(detalles);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar tus equipos pendientes" });
  }
});

interface CrearEgresoBody {
  empleadoId: number;
  clienteDestinoId?: number;
  observaciones?: string;
  numerosSerieProductoIds: number[];
}

// POST /egresos-bodega
// Body: { empleadoId, clienteDestinoId?, observaciones?, numerosSerieProductoIds }
// Todo o nada: si algún serial ya no está EN_BODEGA (otra bodeguera lo
// despachó primero, o ya se entregó), se rechaza el documento completo en
// vez de despachar una parte — mismo criterio que el acta de una visita con
// seriales (ver routes/visitas.ts).
egresosBodegaRouter.post("/", puedeAdministrar, async (req: Request, res: Response) => {
  try {
    const { empleadoId, clienteDestinoId, observaciones, numerosSerieProductoIds } = req.body as CrearEgresoBody;

    if (!empleadoId) return res.status(400).json({ error: "empleadoId es obligatorio" });
    if (!Array.isArray(numerosSerieProductoIds) || numerosSerieProductoIds.length === 0) {
      return res.status(400).json({ error: "Elegí al menos un número de serie para despachar" });
    }

    const empleado = await prisma.empleado.findUnique({ where: { id: Number(empleadoId) } });
    if (!empleado || !empleado.activo) return res.status(404).json({ error: "El técnico no existe o está inactivo" });

    const egreso = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const creado = await tx.egresoBodega.create({
        data: {
          empleadoId: empleado.id,
          clienteDestinoId: clienteDestinoId ?? null,
          observaciones: observaciones?.trim() || null,
          usuarioId: req.usuario!.usuarioId,
        },
      });

      for (const serieId of numerosSerieProductoIds) {
        const resultado = await tx.numeroSerieProducto.updateMany({
          where: { id: serieId, estado: "EN_BODEGA" },
          data: { estado: "EN_TRANSITO" },
        });
        if (resultado.count === 0) throw new Error(`SERIE_NO_DISPONIBLE:${serieId}`);
        await tx.egresoBodegaDetalle.create({ data: { egresoId: creado.id, numeroSerieProductoId: serieId } });
      }

      return tx.egresoBodega.findUniqueOrThrow({ where: { id: creado.id }, include: INCLUDE_EGRESO });
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_EGRESO_BODEGA",
      entidad: "EgresoBodega",
      entidadId: egreso.id,
      detalle: `${numerosSerieProductoIds.length} equipo(s) a ${empleado.nombres} ${empleado.apellidos}`,
    });

    res.status(201).json(egreso);
  } catch (error: any) {
    if (typeof error.message === "string" && error.message.startsWith("SERIE_NO_DISPONIBLE")) {
      const serieId = error.message.split(":")[1];
      const serie = await prisma.numeroSerieProducto.findUnique({ where: { id: Number(serieId) }, select: { numeroSerie: true } });
      return res.status(409).json({
        error: `El número de serie ${serie?.numeroSerie ?? serieId} ya no está en bodega (alguien más lo despachó o entregó primero)`,
      });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear el egreso de bodega" });
  }
});

// PATCH /egresos-bodega/detalles/:detalleId/devolver
// El técnico no usó el equipo y lo devolvió físicamente a bodega — cierra
// esta línea puntual y libera el serial para el próximo egreso.
egresosBodegaRouter.patch("/detalles/:detalleId/devolver", puedeAdministrar, async (req: Request, res: Response) => {
  try {
    const detalleId = Number(req.params.detalleId);

    const detalle = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existente = await tx.egresoBodegaDetalle.findUnique({ where: { id: detalleId } });
      if (!existente) throw new Error("DETALLE_NO_ENCONTRADO");

      // Chequeo-y-escritura atómico: un updateMany con el estado en el WHERE
      // evita que dos "devolver" concurrentes del mismo detalle piensen
      // ambos que fueron los primeros en resolverlo (mismo criterio que
      // POST /productos/series/:id/entregar y .../regresar-a-bodega).
      const resultado = await tx.egresoBodegaDetalle.updateMany({
        where: { id: detalleId, estado: "EN_TRANSITO" },
        data: { estado: "DEVUELTO" },
      });
      if (resultado.count === 0) throw new Error("YA_RESUELTO");

      await tx.numeroSerieProducto.update({
        where: { id: existente.numeroSerieProductoId },
        data: { estado: "EN_BODEGA" },
      });

      return tx.egresoBodegaDetalle.findUniqueOrThrow({
        where: { id: detalleId },
        include: { numeroSerieProducto: { select: { numeroSerie: true } } },
      });
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DEVOLVER_EGRESO_BODEGA",
      entidad: "EgresoBodegaDetalle",
      entidadId: detalle.id,
      detalle: `Serie ${detalle.numeroSerieProducto.numeroSerie} de vuelta a bodega`,
    });

    res.json(detalle);
  } catch (error: any) {
    if (error.message === "DETALLE_NO_ENCONTRADO") return res.status(404).json({ error: "Línea de egreso no encontrada" });
    if (error.message === "YA_RESUELTO") return res.status(409).json({ error: "Esta línea ya se resolvió (entregada o devuelta)" });
    console.error(error);
    res.status(500).json({ error: "Error al devolver el equipo a bodega" });
  }
});
