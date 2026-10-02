// Localización de técnicos: la app móvil manda periódicamente la posición
// GPS del celular del técnico (ver hooks/useUbicacionTecnico.ts en el
// frontend), y acá se guarda como un historial append-only (nunca se
// sobreescribe una lectura anterior, ver comentario del modelo
// UbicacionTecnico en schema.prisma). POST es self-service — cualquier
// Usuario con Empleado vinculado manda SU PROPIA posición, sin exigir el
// permiso "ubicacion_tecnicos" (ese permiso es para VER el mapa de todos,
// no para reportar la propia) — mismo criterio que "Mi ruta de hoy" en
// routes/visitas.ts. Las rutas de consulta (para el mapa admin) sí lo
// exigen.
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requirePermiso } from "../middleware/auth";
import { fechaLocalDeString, aClaveDia } from "../utils/rangoFechas";
import { calcularEstadoUbicacion } from "../utils/ubicacionTecnicos";

export const ubicacionesTecnicosRouter = Router();

const puedeVer = requirePermiso("ubicacion_tecnicos");

// Tope duro por lote — un técnico que estuvo offline un día entero, mandando
// una lectura cada 2 min, acumula como mucho ~360-500 puntos; esto solo
// evita que un body manipulado a mano mande un lote absurdo.
const MAXIMO_PUNTOS_POR_LOTE = 1000;

async function empleadoDelUsuarioActual(usuarioId: number): Promise<number | null> {
  const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { empleadoId: true } });
  return usuario?.empleadoId ?? null;
}

interface PuntoUbicacionBody {
  latitud: number;
  longitud: number;
  precisionMetros?: number;
  fecha: string;
}

function validarPunto(p: PuntoUbicacionBody): string | null {
  if (typeof p.latitud !== "number" || p.latitud < -90 || p.latitud > 90) return "latitud inválida";
  if (typeof p.longitud !== "number" || p.longitud < -180 || p.longitud > 180) return "longitud inválida";
  if (!p.fecha || Number.isNaN(new Date(p.fecha).getTime())) return "fecha inválida";
  return null;
}

// POST /ubicaciones-tecnicos
// Body: { ubicaciones: [{ latitud, longitud, precisionMetros?, fecha }, ...] }
// Siempre un ARREGLO, incluso para una sola lectura en vivo — así el mismo
// endpoint sirve tanto para el ping normal como para subir de una vez el
// backlog acumulado sin señal (ver utils/colaUbicaciones.ts).
ubicacionesTecnicosRouter.post("/", async (req: Request, res: Response) => {
  try {
    const empleadoId = await empleadoDelUsuarioActual(req.usuario!.usuarioId);
    if (!empleadoId) {
      return res.status(400).json({ error: "Tu usuario no tiene un empleado vinculado. Pide a un administrador que te vincule en Usuarios." });
    }

    const puntos = (req.body?.ubicaciones ?? []) as PuntoUbicacionBody[];
    if (!Array.isArray(puntos) || puntos.length === 0) {
      return res.status(400).json({ error: "ubicaciones debe ser un arreglo con al menos un punto" });
    }
    if (puntos.length > MAXIMO_PUNTOS_POR_LOTE) {
      return res.status(400).json({ error: `No se puede mandar más de ${MAXIMO_PUNTOS_POR_LOTE} puntos de una vez` });
    }
    for (const p of puntos) {
      const error = validarPunto(p);
      if (error) return res.status(400).json({ error });
    }

    await prisma.ubicacionTecnico.createMany({
      data: puntos.map((p) => ({
        empleadoId,
        latitud: new Prisma.Decimal(p.latitud),
        longitud: new Prisma.Decimal(p.longitud),
        precisionMetros: p.precisionMetros !== undefined ? new Prisma.Decimal(p.precisionMetros) : null,
        fecha: new Date(p.fecha),
      })),
    });

    res.status(201).json({ guardadas: puntos.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al guardar la ubicación" });
  }
});

// GET /ubicaciones-tecnicos/actual
// La última posición conocida de cada técnico que alguna vez reportó una,
// con el estado (EN_LINEA/RECIENTE/DESCONECTADO) según hace cuánto fue esa
// lectura, y el vehículo que tiene EN_USO ahora mismo si tiene uno (ver
// UsoVehiculo) — así el mapa responde de una "dónde está el vehículo X"
// además de "dónde está el técnico X".
ubicacionesTecnicosRouter.get("/actual", puedeVer, async (_req: Request, res: Response) => {
  try {
    const ultimas = await prisma.ubicacionTecnico.findMany({
      orderBy: { fecha: "desc" },
      distinct: ["empleadoId"],
      include: {
        empleado: {
          select: {
            id: true,
            nombres: true,
            apellidos: true,
            usosVehiculo: {
              where: { estado: "EN_USO" },
              take: 1,
              select: { vehiculo: { select: { id: true, placa: true, marca: { select: { nombre: true } }, modelo: { select: { nombre: true } } } } },
            },
          },
        },
      },
    });

    const resultado = ultimas.map((u) => {
      const minutos = Math.floor((Date.now() - u.fecha.getTime()) / 60000);
      return {
        empleadoId: u.empleadoId,
        nombre: `${u.empleado.nombres} ${u.empleado.apellidos}`,
        latitud: u.latitud,
        longitud: u.longitud,
        precisionMetros: u.precisionMetros,
        fecha: u.fecha,
        minutos,
        estado: calcularEstadoUbicacion(minutos),
        vehiculo: u.empleado.usosVehiculo[0]?.vehiculo ?? null,
      };
    });

    res.json(resultado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar la última ubicación de los técnicos" });
  }
});

// GET /ubicaciones-tecnicos/:empleadoId/recorrido?fecha=YYYY-MM-DD
// Todos los puntos de UN técnico en UN día calendario (por defecto, hoy),
// en orden cronológico — para dibujar la línea de su recorrido cuando el
// admin hace clic en su marcador en el mapa.
ubicacionesTecnicosRouter.get("/:empleadoId/recorrido", puedeVer, async (req: Request, res: Response) => {
  try {
    const empleadoId = Number(req.params.empleadoId);
    // OJO: "hoy" tiene que calcularse en hora LOCAL, nunca con
    // new Date().toISOString().slice(0,10) (esa es la fecha en UTC — con el
    // servidor en UTC-5, de 7pm a medianoche hora local eso ya "es mañana"
    // en UTC, y el filtro de abajo quedaría mirando el día calendario
    // equivocado). Ver el comentario largo sobre este mismo bug en
    // fechaLocalDeString(), utils/rangoFechas.ts.
    const fechaStr = (req.query.fecha as string) || aClaveDia(new Date());

    const puntos = await prisma.ubicacionTecnico.findMany({
      where: {
        empleadoId,
        fecha: { gte: fechaLocalDeString(fechaStr, false), lte: fechaLocalDeString(fechaStr, true) },
      },
      orderBy: { fecha: "asc" },
      select: { latitud: true, longitud: true, precisionMetros: true, fecha: true },
    });

    res.json(puntos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar el recorrido del técnico" });
  }
});
