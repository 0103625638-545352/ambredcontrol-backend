// Bitácora de acciones sensibles (anular, editar, desactivar, eliminar pago,
// crear usuario/nota de crédito) — responde "¿quién hizo qué y cuándo?" para
// cualquier acción administrativa. Solo ADMIN puede consultarla (ver index.ts).
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerRangoFechas } from "../utils/rangoFechas";

export const auditoriaRouter = Router();

// GET /auditoria?page=&pageSize=&usuarioId=&accion=&entidad=&desde=&hasta=
auditoriaRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const { usuarioId, accion, entidad } = req.query;
    const rango = leerRangoFechas(req);

    const where: Prisma.RegistroAuditoriaWhereInput = {
      ...(usuarioId && { usuarioId: Number(usuarioId) }),
      ...(accion && { accion: accion as string }),
      ...(entidad && { entidad: entidad as string }),
      ...(rango && { fecha: rango }),
    };

    const opciones = {
      where,
      include: { usuario: { select: { nombre: true, usuario: true } } },
      orderBy: { fecha: "desc" as const },
    };

    if (!paginacion.aplica) {
      const registros = await prisma.registroAuditoria.findMany(opciones);
      return res.json(registros);
    }

    const [registros, total] = await Promise.all([
      prisma.registroAuditoria.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.registroAuditoria.count({ where }),
    ]);
    res.json(respuestaPaginada(registros, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar el registro de auditoría" });
  }
});

// GET /auditoria/acciones
// Lista de valores distintos de "accion" ya registrados, para poblar el
// filtro del frontend sin tener que mantener la lista a mano en dos lugares.
auditoriaRouter.get("/acciones", async (_req: Request, res: Response) => {
  try {
    const filas = await prisma.registroAuditoria.findMany({
      select: { accion: true },
      distinct: ["accion"],
      orderBy: { accion: "asc" },
    });
    res.json(filas.map((f: { accion: string }) => f.accion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las acciones registradas" });
  }
});
