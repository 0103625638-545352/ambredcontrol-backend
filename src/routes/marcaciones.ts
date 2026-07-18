// Marcaciones de asistencia (entrada/salida) de empleados. Un solo archivo
// con DOS mundos muy distintos adentro (mismo criterio que routes/auth.ts):
//
//   - POST /marcaciones/marcar es PÚBLICO — un empleado no necesariamente
//     tiene cuenta de Usuario/JWT, así que resuelve la empresa a mano con
//     obtenerPrismaDeEmpresa (igual que POST /auth/login), en vez de pasar
//     por requireAuth/ejecutarConEmpresa.
//   - GET / y POST / son de administración: SÍ llevan requireAuth (que ya
//     entra al contexto de la empresa activa) y usan el "prisma" ambiente
//     de siempre.
//
// Montado en index.ts SIN requireAuth a nivel de router, igual que "/auth".
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma, obtenerPrismaDeEmpresa } from "../db";
import { obtenerEmpresa } from "../utils/empresas";
import { compararPassword } from "../utils/auth";
import { evaluarGeocerca } from "../utils/geocercas";
import { esTardanza } from "../utils/marcaciones";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerRangoFechas, rangoDelMes, aClaveDia } from "../utils/rangoFechas";
import { requireAuth, requirePermiso } from "../middleware/auth";
import { SELECT_EMPLEADO_SEGURO } from "../utils/empleados";
import { emparejarMarcaciones, calcularHorasTrabajadas } from "../utils/horasTrabajadas";

export const marcacionesRouter = Router();

const puedeVer = requirePermiso("nomina");
const puedeEditar = requirePermiso("nomina_editar");

// Mismo candado de fuerza bruta que ya usa el login (routes/auth.ts:16-17),
// pero sobre Empleado.intentosFallidosPin/bloqueadoHastaPin — un PIN de 4-6
// dígitos es mucho más corto que una contraseña, así que este candado
// importa más acá, no menos.
const MAX_INTENTOS_FALLIDOS_PIN = 5;
const MINUTOS_BLOQUEO_PIN = 15;

interface MarcarBody {
  empresaId: string;
  cedula: string;
  pin: string;
  tipo: "ENTRADA" | "SALIDA";
  latitud?: number;
  longitud?: number;
}

// POST /marcaciones/marcar (público)
// IMPORTANTE: esta ruta responde 400 (nunca 401) para "cédula o PIN
// incorrectos" — el interceptor de Axios del frontend (api/client.ts) hace
// window.location.reload() ante CUALQUIER 401, lo que recargaría la página
// de marcación a medio llenar en cada intento fallido. 401 queda reservado
// para sesiones de Usuario reales, que esta pantalla nunca tiene. 429 sigue
// siendo el código correcto para el bloqueo por intentos.
marcacionesRouter.post("/marcar", async (req: Request, res: Response) => {
  try {
    const { empresaId, cedula, pin, tipo, latitud, longitud } = req.body as MarcarBody;

    if (!empresaId || !cedula || !pin || !tipo) {
      return res.status(400).json({ error: "empresaId, cedula, pin y tipo son obligatorios" });
    }
    if (tipo !== "ENTRADA" && tipo !== "SALIDA") {
      return res.status(400).json({ error: "tipo debe ser ENTRADA o SALIDA" });
    }

    const empresa = obtenerEmpresa(empresaId);
    if (!empresa) {
      return res.status(400).json({ error: "La empresa seleccionada no existe" });
    }

    const prismaEmpresa = obtenerPrismaDeEmpresa(empresaId);
    const empleado = await prismaEmpresa.empleado.findUnique({ where: { cedula }, include: { sucursal: true } });

    // Mismo mensaje genérico sin importar cuál dato falló, por la misma
    // razón que el login: no confirmarle a quien intenta si la cédula
    // existe o no.
    if (!empleado || !empleado.activo) {
      return res.status(400).json({ error: "Cédula o PIN incorrectos" });
    }

    if (empleado.bloqueadoHastaPin && empleado.bloqueadoHastaPin > new Date()) {
      const minutosRestantes = Math.ceil((empleado.bloqueadoHastaPin.getTime() - Date.now()) / 60_000);
      return res.status(429).json({ error: `Demasiados intentos fallidos. Intenta de nuevo en ${minutosRestantes} minuto(s).` });
    }

    if (!empleado.pinHash) {
      return res.status(400).json({ error: "Este empleado no tiene un PIN configurado. Pide a un administrador que te asigne uno." });
    }

    const pinValido = await compararPassword(pin, empleado.pinHash);
    if (!pinValido) {
      const nuevosIntentos = empleado.intentosFallidosPin + 1;
      const seBloqueaAhora = nuevosIntentos >= MAX_INTENTOS_FALLIDOS_PIN;
      await prismaEmpresa.empleado.update({
        where: { id: empleado.id },
        data: seBloqueaAhora
          ? { intentosFallidosPin: 0, bloqueadoHastaPin: new Date(Date.now() + MINUTOS_BLOQUEO_PIN * 60_000) }
          : { intentosFallidosPin: nuevosIntentos },
      });
      if (seBloqueaAhora) {
        return res.status(429).json({ error: `Demasiados intentos fallidos. Intenta de nuevo en ${MINUTOS_BLOQUEO_PIN} minutos.` });
      }
      return res.status(400).json({ error: "Cédula o PIN incorrectos" });
    }

    if (empleado.intentosFallidosPin > 0) {
      await prismaEmpresa.empleado.update({ where: { id: empleado.id }, data: { intentosFallidosPin: 0 } });
    }

    const fecha = new Date();
    const { distanciaMetros, dentroDeGeocerca } = evaluarGeocerca(empleado.sucursal, latitud ?? null, longitud ?? null);
    const tardanza = tipo === "ENTRADA" && empleado.horaEntradaEsperada ? esTardanza(fecha, empleado.horaEntradaEsperada) : null;

    const marcacion = await prismaEmpresa.marcacion.create({
      data: {
        empleadoId: empleado.id,
        tipo,
        fecha,
        latitud: latitud != null ? new Prisma.Decimal(latitud) : null,
        longitud: longitud != null ? new Prisma.Decimal(longitud) : null,
        distanciaMetros: distanciaMetros !== null ? new Prisma.Decimal(distanciaMetros.toFixed(2)) : null,
        dentroDeGeocerca,
        tardanza,
      },
    });

    // A propósito NO se le informa al empleado si quedó fuera de la
    // geocerca — eso es una señal para que un admin la revise en el
    // reporte (ver GET /marcaciones), no algo que el empleado deba conocer
    // en el momento (ver "Alcance de esta ronda" del plan).
    res.status(201).json({ ok: true, tipo: marcacion.tipo, hora: marcacion.fecha });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar la marcación" });
  }
});

const INCLUDE_MARCACION = { empleado: { select: SELECT_EMPLEADO_SEGURO } } as const;

// GET /marcaciones (autenticado, admin)
marcacionesRouter.get("/", requireAuth, puedeVer, async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const { empleadoId } = req.query;
    const fecha = leerRangoFechas(req);
    const where: Prisma.MarcacionWhereInput = {
      ...(empleadoId && { empleadoId: Number(empleadoId) }),
      ...(fecha && { fecha }),
    };
    const opciones = { where, include: INCLUDE_MARCACION, orderBy: { fecha: "desc" as const } };

    if (!paginacion.aplica) {
      const marcaciones = await prisma.marcacion.findMany(opciones);
      return res.json(marcaciones);
    }

    const [marcaciones, total] = await Promise.all([
      prisma.marcacion.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.marcacion.count({ where }),
    ]);
    res.json(respuestaPaginada(marcaciones, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar marcaciones" });
  }
});

// POST /marcaciones (autenticado, admin) — corrección manual: el empleado
// olvidó marcar y un admin la registra a mano. Sin PIN (quien la crea ya
// pasó por requireAuth), exige "observacion" para dejar rastro de por qué
// se creó así.
marcacionesRouter.post("/", requireAuth, puedeEditar, async (req: Request, res: Response) => {
  try {
    const { empleadoId, tipo, fecha, observacion } = req.body as {
      empleadoId: number;
      tipo: "ENTRADA" | "SALIDA";
      fecha?: string;
      observacion: string;
    };

    if (!empleadoId || !tipo || !observacion) {
      return res.status(400).json({ error: "empleadoId, tipo y observacion son obligatorios" });
    }
    if (tipo !== "ENTRADA" && tipo !== "SALIDA") {
      return res.status(400).json({ error: "tipo debe ser ENTRADA o SALIDA" });
    }

    const empleado = await prisma.empleado.findUnique({ where: { id: empleadoId } });
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });

    const fechaMarcacion = fecha ? new Date(fecha) : new Date();
    const tardanza = tipo === "ENTRADA" && empleado.horaEntradaEsperada ? esTardanza(fechaMarcacion, empleado.horaEntradaEsperada) : null;

    const marcacion = await prisma.marcacion.create({
      data: {
        empleadoId,
        tipo,
        fecha: fechaMarcacion,
        tardanza,
        creadaManualmente: true,
        observacion,
      },
      include: INCLUDE_MARCACION,
    });

    res.status(201).json(marcacion);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar la marcación manual" });
  }
});

// Horas entre dos "HH:MM" — si horaFin es menor que horaInicio, asume que
// el turno cruza medianoche (ej. 22:00 a 06:00 = 8 horas).
function horasEntreHorarios(horaInicio: string, horaFin: string): number {
  const [hIni, mIni] = horaInicio.split(":").map(Number);
  const [hFin, mFin] = horaFin.split(":").map(Number);
  const minutosIni = hIni * 60 + mIni;
  let minutosFin = hFin * 60 + mFin;
  if (minutosFin < minutosIni) minutosFin += 24 * 60;
  return (minutosFin - minutosIni) / 60;
}

// GET /marcaciones/horas-trabajadas?empleadoId=&anio=&mes=
// Suma las horas trabajadas del mes emparejando entrada/salida — alimenta
// el botón "Sugerir desde marcaciones" del formulario de Rol de Pagos.
// A propósito NO clasifica en suplementarias/extraordinarias (ver
// utils/horasTrabajadas.ts) — solo entrega el total y las anomalías
// encontradas, para que el admin decida.
marcacionesRouter.get("/horas-trabajadas", requireAuth, puedeVer, async (req: Request, res: Response) => {
  try {
    const { empleadoId, anio, mes } = req.query;
    if (!empleadoId || !anio || !mes) {
      return res.status(400).json({ error: "empleadoId, anio y mes son obligatorios" });
    }

    const empleado = await prisma.empleado.findUnique({ where: { id: Number(empleadoId) } });
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });

    const { desde, hasta } = rangoDelMes(Number(anio), Number(mes));
    const marcaciones = await prisma.marcacion.findMany({
      where: { empleadoId: Number(empleadoId), fecha: { gte: desde, lte: hasta } },
      select: { tipo: true, fecha: true },
    });

    const { sesiones, anomalias } = emparejarMarcaciones(marcaciones);
    const horasTrabajadas = calcularHorasTrabajadas(sesiones);

    // Aproximación simple: horas de jornada diaria esperada × días
    // REALMENTE trabajados (con al menos una sesión emparejada) — a
    // propósito NO × días calendario del mes completo: si el empleado
    // recién empezó a marcar a mitad de mes (o el admin sigue usando
    // entrada manual para otros días), comparar contra el mes entero
    // haría ver "horas de más" en 0 casi siempre, aunque sí haya
    // trabajado horas extra en los días que sí marcó. No descuenta fines
    // de semana/feriados (no hay calendario laboral en este sistema), así
    // que sigue siendo una referencia, no un número exacto. Solo se
    // calcula si el empleado tiene ambos horarios configurados.
    let horasEsperadasDelMes: number | null = null;
    if (empleado.horaEntradaEsperada && empleado.horaSalidaEsperada) {
      const diasTrabajados = new Set(sesiones.map((s) => aClaveDia(s.entrada))).size;
      const horasJornadaDiaria = horasEntreHorarios(empleado.horaEntradaEsperada, empleado.horaSalidaEsperada);
      horasEsperadasDelMes = horasJornadaDiaria * diasTrabajados;
    }

    res.json({ horasTrabajadas, horasEsperadasDelMes, sesiones, anomalias });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al calcular las horas trabajadas" });
  }
});
