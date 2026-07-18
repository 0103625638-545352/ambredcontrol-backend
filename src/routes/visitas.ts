// Rutas de visita técnica — un despachador arma la ruta diaria de un
// técnico con las ubicaciones que el cliente ya mandó por WhatsApp
// (ingresadas a mano en un mapa, ver plan de "Visitas Técnicas": sin
// integración automática con WhatsApp esta ronda), el sistema las ordena
// por cercanía (ver utils/rutaVisitas.ts), y el técnico ve SOLO su propia
// ruta del día (vía Usuario.empleadoId) y confirma cada parada con su
// ubicación real al llegar.
import { Router, Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";
import multer from "multer";
import { prisma, empresaActiva, empresaActivaId, ejecutarConEmpresa } from "../db";
import { ordenarPorCercania, type Punto } from "../utils/rutaVisitas";
import { calcularDistanciaMetros } from "../utils/geocercas";
import { fechaLocalDeString, leerRangoFechas } from "../utils/rangoFechas";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { SELECT_EMPLEADO_SEGURO } from "../utils/empleados";
import { registrarAuditoria } from "../utils/auditoria";
import { requirePermiso } from "../middleware/auth";
import { rutaAbsoluta } from "../utils/empresas";

export const visitasRouter = Router();

const puedeVer = requirePermiso("visitas");
const puedeEditar = requirePermiso("visitas_editar");

const INCLUDE_RUTA = {
  empleado: { select: SELECT_EMPLEADO_SEGURO },
  visitas: { orderBy: { orden: "asc" as const }, include: { cliente: true, equiposDejados: true } },
} as const;

// --- Fotos del acta de instalación (PATCH /:id/detalle-trabajo) ---
// Mismo motivo que en routes/facturasInternet.ts: multer procesa el archivo
// con busboy, en callbacks que corren mientras el body todavía se está
// leyendo del socket — bajo carga real (subida desde el celular del
// técnico, con señal irregular en terreno) ese procesamiento puede terminar
// corriendo FUERA del AsyncLocalStorage de la empresa activa. Por eso el
// empresaId se captura ANTES de que multer entre en juego, y el handler
// vuelve a entrar al contexto él mismo con ese valor.
function capturarEmpresaAntesDeMulter(req: Request, _res: Response, next: NextFunction) {
  (req as any).empresaIdParaUpload = empresaActivaId();
  (req as any).carpetaUploadsParaUpload = empresaActiva().carpetaUploads;
  next();
}

function carpetaFotosVisitaActiva(req: Request): string {
  const carpeta = path.join(rutaAbsoluta((req as any).carpetaUploadsParaUpload), "visitas");
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
  }
  return carpeta;
}

const TIPOS_IMAGEN_PERMITIDOS = ["image/jpeg", "image/png", "image/webp"];
const TAMANO_MAXIMO_IMAGEN = 5 * 1024 * 1024; // 5MB

const almacenamientoFotosVisita = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, carpetaFotosVisitaActiva(req)),
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `visita-${req.params.id}-${file.fieldname}-${Date.now()}${extension}`);
  },
});

const subirFotosVisita = multer({
  storage: almacenamientoFotosVisita,
  limits: { fileSize: TAMANO_MAXIMO_IMAGEN },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_IMAGEN_PERMITIDOS.includes(file.mimetype)) {
      return cb(new Error("Solo se permiten imágenes JPG, PNG o WEBP"));
    }
    cb(null, true);
  },
});

function subirFotosVisitaMiddleware(req: Request, res: Response, next: NextFunction) {
  subirFotosVisita.fields([
    { name: "fotoTrabajo", maxCount: 1 },
    { name: "fotoVivienda", maxCount: 1 },
  ])(req, res, (error: any) => {
    if (error?.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Cada foto puede pesar como máximo 5MB" });
    }
    if (error) {
      return res.status(400).json({ error: error.message || "Error al subir las fotos" });
    }
    next();
  });
}

interface ParadaBody {
  clienteId?: number;
  nombreContacto?: string;
  direccion?: string;
  latitud: number;
  longitud: number;
}

interface CrearRutaBody {
  empleadoId: number;
  fecha: string; // "YYYY-MM-DD"
  paradas: ParadaBody[];
}

// POST /visitas/rutas
visitasRouter.post("/rutas", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { empleadoId, fecha, paradas } = req.body as CrearRutaBody;

    if (!empleadoId || !fecha || !Array.isArray(paradas) || paradas.length === 0) {
      return res.status(400).json({ error: "empleadoId, fecha y al menos una parada son obligatorios" });
    }
    for (const p of paradas) {
      if (p.latitud == null || p.longitud == null) {
        return res.status(400).json({ error: "Cada parada necesita latitud y longitud (ubícala en el mapa)" });
      }
      if (!p.clienteId && !p.nombreContacto?.trim()) {
        return res.status(400).json({ error: "Cada parada necesita un cliente existente o un nombre de contacto" });
      }
    }

    const empleado = await prisma.empleado.findUnique({ where: { id: empleadoId }, include: { sucursal: true } });
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });

    const fechaRuta = fechaLocalDeString(fecha, false);
    const yaExiste = await prisma.rutaVisita.findUnique({ where: { empleadoId_fecha: { empleadoId, fecha: fechaRuta } } });
    if (yaExiste) return res.status(409).json({ error: `Ya existe una ruta para ${empleado.nombres} ${empleado.apellidos} en esa fecha` });

    // Trae el nombre de cada Cliente vinculado, para no confiar en lo que
    // mande el frontend como nombreContacto si ya hay un clienteId.
    const clienteIds = [...new Set(paradas.map((p) => p.clienteId).filter((id): id is number => !!id))];
    const clientes = clienteIds.length > 0 ? await prisma.cliente.findMany({ where: { id: { in: clienteIds } } }) : [];
    const clientePorId = new Map(clientes.map((c) => [c.id, c]));
    for (const id of clienteIds) {
      if (!clientePorId.has(id)) return res.status(404).json({ error: `Cliente ${id} no encontrado` });
    }

    // Origen para el ordenamiento: la geocerca de la sucursal del empleado
    // si está configurada (ver módulo de Marcaciones); si no, la primera
    // parada de la lista tal como la mandó el despachador.
    const origen =
      empleado.sucursal?.latitud != null && empleado.sucursal?.longitud != null
        ? { lat: empleado.sucursal.latitud.toNumber(), lng: empleado.sucursal.longitud.toNumber() }
        : { lat: paradas[0].latitud, lng: paradas[0].longitud };

    const puntos: Punto[] = paradas.map((p, i) => ({ id: i, lat: p.latitud, lng: p.longitud }));
    const ordenIndices = ordenarPorCercania(origen, puntos);

    const ruta = await prisma.rutaVisita.create({
      data: {
        empleadoId,
        fecha: fechaRuta,
        visitas: {
          create: ordenIndices.map((indiceOriginal, posicion) => {
            const p = paradas[indiceOriginal];
            const cliente = p.clienteId ? clientePorId.get(p.clienteId) : undefined;
            return {
              clienteId: p.clienteId ?? null,
              nombreContacto: cliente ? cliente.razonSocial : p.nombreContacto!.trim(),
              direccion: p.direccion?.trim() || null,
              latitud: new Prisma.Decimal(p.latitud),
              longitud: new Prisma.Decimal(p.longitud),
              orden: posicion + 1,
            };
          }),
        },
      },
      include: INCLUDE_RUTA,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_RUTA_VISITA",
      entidad: "RutaVisita",
      entidadId: ruta.id,
      detalle: `Ruta de ${empleado.nombres} ${empleado.apellidos} para ${fecha}: ${paradas.length} parada(s)`,
    });

    res.status(201).json(ruta);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear la ruta de visita" });
  }
});

// POST /visitas/rutas/:id/paradas
// "Visita flash": agrega UNA parada urgente a una ruta que ya fue creada —
// ej. un cliente llama pidiendo una visita el mismo día y el técnico ya
// tiene su ruta armada. A propósito no recalcula el orden de cercanía de
// toda la ruta (ordenarPorCercania es solo para el armado inicial): esta
// parada se agrega al final, marcada esUrgente, para que el técnico la note
// y decida cómo acomodarla en lo que le queda del día.
visitasRouter.post("/rutas/:id/paradas", puedeEditar, async (req: Request, res: Response) => {
  try {
    const rutaId = Number(req.params.id);
    const { clienteId, nombreContacto, direccion, latitud, longitud } = req.body as ParadaBody;

    if (latitud == null || longitud == null) {
      return res.status(400).json({ error: "latitud y longitud son obligatorias (ubícala en el mapa)" });
    }
    if (!clienteId && !nombreContacto?.trim()) {
      return res.status(400).json({ error: "Se necesita un cliente existente o un nombre de contacto" });
    }

    const ruta = await prisma.rutaVisita.findUnique({ where: { id: rutaId }, include: { empleado: true } });
    if (!ruta) return res.status(404).json({ error: "Ruta no encontrada" });

    let nombreFinal = nombreContacto?.trim();
    if (clienteId) {
      const cliente = await prisma.cliente.findUnique({ where: { id: clienteId } });
      if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });
      nombreFinal = cliente.razonSocial;
    }

    const { _max } = await prisma.visitaTecnica.aggregate({ where: { rutaVisitaId: rutaId }, _max: { orden: true } });

    const visita = await prisma.visitaTecnica.create({
      data: {
        rutaVisitaId: rutaId,
        clienteId: clienteId ?? null,
        nombreContacto: nombreFinal!,
        direccion: direccion?.trim() || null,
        latitud: new Prisma.Decimal(latitud),
        longitud: new Prisma.Decimal(longitud),
        orden: (_max.orden ?? 0) + 1,
        esUrgente: true,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "AGREGAR_VISITA_URGENTE",
      entidad: "VisitaTecnica",
      entidadId: visita.id,
      detalle: `Visita urgente para ${nombreFinal} agregada a la ruta de ${ruta.empleado.nombres} ${ruta.empleado.apellidos} (${ruta.fecha.toISOString().slice(0, 10)})`,
    });

    res.status(201).json(visita);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al agregar la visita urgente" });
  }
});

// GET /visitas/rutas (historial, opcional ?empleadoId=&fecha=)
visitasRouter.get("/rutas", puedeVer, async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const { empleadoId, fecha } = req.query;
    const where: Prisma.RutaVisitaWhereInput = {
      ...(empleadoId && { empleadoId: Number(empleadoId) }),
      ...(fecha && { fecha: fechaLocalDeString(String(fecha), false) }),
    };
    const opciones = { where, include: INCLUDE_RUTA, orderBy: { fecha: "desc" as const } };

    if (!paginacion.aplica) {
      const rutas = await prisma.rutaVisita.findMany(opciones);
      return res.json(rutas);
    }

    const [rutas, total] = await Promise.all([
      prisma.rutaVisita.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.rutaVisita.count({ where }),
    ]);
    res.json(respuestaPaginada(rutas, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar rutas de visita" });
  }
});

// GET /visitas/rutas/:id
visitasRouter.get("/rutas/:id", puedeVer, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const ruta = await prisma.rutaVisita.findUnique({ where: { id }, include: INCLUDE_RUTA });
    if (!ruta) return res.status(404).json({ error: "Ruta no encontrada" });
    res.json(ruta);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar la ruta" });
  }
});

// GET /visitas/equipos?q=texto — busca en TODOS los equipos dejados en
// visitas (de cualquier cliente) por tipo, modelo o serial/MAC, para
// responder "¿dónde está instalado este equipo?" sin recorrer cliente por
// cliente. Devuelve, por cada coincidencia, la visita/cliente/técnico/fecha
// en la que se dejó.
visitasRouter.get("/equipos", puedeVer, async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json([]);

    const equipos = await prisma.equipoDejadoVisita.findMany({
      where: {
        OR: [
          { tipo: { contains: q, mode: "insensitive" } },
          { modelo: { contains: q, mode: "insensitive" } },
          { serial: { contains: q, mode: "insensitive" } },
        ],
      },
      include: {
        visita: {
          include: {
            cliente: true,
            rutaVisita: { include: { empleado: { select: SELECT_EMPLEADO_SEGURO } } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(equipos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar equipos" });
  }
});

// GET /visitas/historial?empleadoId=&desde=&hasta=
// Todas las visitas de UN técnico en un rango de fechas, sin importar a cuál
// ruta/día pertenezca cada una — para responder "¿qué hizo este técnico
// entre el 1 y el 15?" sin tener que abrir ruta por ruta en la tabla de
// "Rutas planificadas" (esa solo filtra por un día exacto, no un rango).
visitasRouter.get("/historial", puedeVer, async (req: Request, res: Response) => {
  try {
    const empleadoId = Number(req.query.empleadoId);
    if (!empleadoId) return res.status(400).json({ error: "empleadoId es obligatorio" });

    const rango = leerRangoFechas(req);

    const visitas = await prisma.visitaTecnica.findMany({
      where: { rutaVisita: { empleadoId, ...(rango && { fecha: rango }) } },
      include: {
        cliente: true,
        equiposDejados: true,
        rutaVisita: { include: { empleado: { select: SELECT_EMPLEADO_SEGURO } } },
      },
      orderBy: [{ rutaVisita: { fecha: "desc" } }, { orden: "asc" }],
    });
    res.json(visitas);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener el historial del técnico" });
  }
});

// GET /visitas/mi-ruta-hoy — cualquier Usuario con empleadoId vinculado ve
// SOLO la suya, sin necesitar el permiso "visitas" (ese permiso es para ver
// las rutas de TODOS, no la propia).
visitasRouter.get("/mi-ruta-hoy", async (req: Request, res: Response) => {
  try {
    const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario!.usuarioId } });
    if (!usuario?.empleadoId) {
      return res.status(400).json({ error: "Tu usuario no tiene un empleado vinculado. Pide a un administrador que te vincule en Usuarios." });
    }

    const hoy = fechaLocalDeString(new Date().toISOString().slice(0, 10), false);
    const ruta = await prisma.rutaVisita.findUnique({
      where: { empleadoId_fecha: { empleadoId: usuario.empleadoId, fecha: hoy } },
      include: INCLUDE_RUTA,
    });
    res.json(ruta);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar tu ruta de hoy" });
  }
});

// Confirma que quien llama puede tocar esta visita: o es ADMIN/tiene
// visitas_editar (corrección administrativa), o es el técnico dueño de la
// ruta (vía Usuario.empleadoId) — nunca un tercero cualquiera.
async function puedeTocarVisita(req: Request, visitaId: number): Promise<{ ok: boolean; visita?: any }> {
  const visita = await prisma.visitaTecnica.findUnique({ where: { id: visitaId }, include: { rutaVisita: true } });
  if (!visita) return { ok: false };
  if (req.usuario!.rol === "ADMIN") return { ok: true, visita };
  const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario!.usuarioId } });
  return { ok: usuario?.empleadoId === visita.rutaVisita.empleadoId, visita };
}

// PATCH /visitas/:id/llegada
visitasRouter.patch("/:id/llegada", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { latitud, longitud } = req.body as { latitud?: number; longitud?: number };
    if (latitud == null || longitud == null) {
      return res.status(400).json({ error: "latitud y longitud son obligatorias" });
    }

    const { ok, visita } = await puedeTocarVisita(req, id);
    if (!visita) return res.status(404).json({ error: "Visita no encontrada" });
    if (!ok) return res.status(403).json({ error: "Esta visita no pertenece a tu ruta" });

    const distanciaAlPunto = calcularDistanciaMetros(visita.latitud.toNumber(), visita.longitud.toNumber(), latitud, longitud);

    // El GPS del técnico parado en la puerta del cliente es, por definición,
    // más confiable que la ubicación PLANEADA (copiada a mano de un mensaje
    // de WhatsApp — con los problemas de precisión que ya vimos: viewport
    // vs. pin exacto, redondeo de decimales). Por eso, si esta visita está
    // vinculada a un Cliente real (no un prospecto suelto), la llegada
    // también actualiza su ubicación guardada — así el próximo técnico que
    // lo visite ya arranca con el punto correcto, sin depender de que
    // alguien vuelva a pedirle la ubicación por WhatsApp. Ambas escrituras
    // van en la misma transacción: o se registran las dos, o ninguna.
    const [actualizada] = await prisma.$transaction([
      prisma.visitaTecnica.update({
        where: { id },
        data: {
          estado: "COMPLETADA",
          fechaLlegadaReal: new Date(),
          latitudLlegada: new Prisma.Decimal(latitud),
          longitudLlegada: new Prisma.Decimal(longitud),
          distanciaAlPunto: new Prisma.Decimal(distanciaAlPunto.toFixed(2)),
        },
      }),
      ...(visita.clienteId
        ? [
            prisma.cliente.update({
              where: { id: visita.clienteId },
              data: { latitud: new Prisma.Decimal(latitud), longitud: new Prisma.Decimal(longitud) },
            }),
          ]
        : []),
    ]);

    res.json({ ...actualizada, ubicacionClienteActualizada: !!visita.clienteId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar la llegada" });
  }
});

// PATCH /visitas/:id/detalle-trabajo
// Acta de instalación — se llena después de "Llegué", nunca antes (aunque
// no se valida el estado acá: un admin corrigiendo un registro viejo
// también pasa por esta misma ruta). multipart/form-data:
//   descripcionTrabajo?: string
//   equipos?: string           — JSON.stringify de [{tipo, modelo?, serial?}, ...]
//   fotoTrabajo?: archivo
//   fotoVivienda?: archivo
// "equipos" REEMPLAZA la lista anterior en vez de sumarse — si el técnico
// se equivocó y vuelve a enviar el formulario, no queda un MikroTik
// duplicado por cada intento.
visitasRouter.patch(
  "/:id/detalle-trabajo",
  capturarEmpresaAntesDeMulter,
  subirFotosVisitaMiddleware,
  async (req: Request, res: Response) => {
    const empresaId = (req as any).empresaIdParaUpload as string;
    const archivos = req.files as { fotoTrabajo?: Express.Multer.File[]; fotoVivienda?: Express.Multer.File[] } | undefined;

    // Cualquier salida que no termine guardando el registro (404, 403, JSON
    // de "equipos" inválido, o una excepción) no debe dejar las fotos ya
    // subidas huérfanas en disco — se llama antes de cada return temprano y
    // también en el catch de abajo.
    function limpiarArchivosSubidos() {
      if (archivos?.fotoTrabajo?.[0]) fs.unlinkSync(archivos.fotoTrabajo[0].path);
      if (archivos?.fotoVivienda?.[0]) fs.unlinkSync(archivos.fotoVivienda[0].path);
    }

    try {
      await ejecutarConEmpresa(empresaId, async () => {
        const id = Number(req.params.id);

        const { ok, visita } = await puedeTocarVisita(req, id);
        if (!visita) {
          limpiarArchivosSubidos();
          return res.status(404).json({ error: "Visita no encontrada" });
        }
        if (!ok) {
          limpiarArchivosSubidos();
          return res.status(403).json({ error: "Esta visita no pertenece a tu ruta" });
        }

        let equipos: { tipo: string; modelo?: string; serial?: string }[] = [];
        if (req.body.equipos) {
          try {
            const parseado = JSON.parse(req.body.equipos);
            if (!Array.isArray(parseado)) throw new Error();
            equipos = parseado
              .filter((e: any) => typeof e?.tipo === "string" && e.tipo.trim())
              .map((e: any) => ({ tipo: e.tipo.trim(), modelo: e.modelo?.trim() || undefined, serial: e.serial?.trim() || undefined }));
          } catch {
            limpiarArchivosSubidos();
            return res.status(400).json({ error: '"equipos" debe ser un JSON válido con una lista de {tipo, modelo?, serial?}' });
          }
        }

        const fotoTrabajoUrl = archivos?.fotoTrabajo?.[0] ? `/uploads/${empresaId}/visitas/${archivos.fotoTrabajo[0].filename}` : undefined;
        const fotoViviendaUrl = archivos?.fotoVivienda?.[0] ? `/uploads/${empresaId}/visitas/${archivos.fotoVivienda[0].filename}` : undefined;

        const actualizada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.equipoDejadoVisita.deleteMany({ where: { visitaId: id } });
          return tx.visitaTecnica.update({
            where: { id },
            data: {
              descripcionTrabajo: req.body.descripcionTrabajo?.trim() || undefined,
              ...(fotoTrabajoUrl && { fotoTrabajoUrl }),
              ...(fotoViviendaUrl && { fotoViviendaUrl }),
              equiposDejados: { create: equipos },
            },
            include: { equiposDejados: true },
          });
        });

        await registrarAuditoria(prisma, {
          usuarioId: req.usuario!.usuarioId,
          accion: "REGISTRAR_DETALLE_TRABAJO_VISITA",
          entidad: "VisitaTecnica",
          entidadId: id,
          detalle: `${visita.nombreContacto}: ${equipos.length} equipo(s) dejado(s)`,
        });

        res.json(actualizada);
      });
    } catch (error) {
      limpiarArchivosSubidos();
      console.error(error);
      res.status(500).json({ error: "Error al guardar el detalle del trabajo" });
    }
  }
);

// PATCH /visitas/:id/omitir
visitasRouter.patch("/:id/omitir", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { observaciones } = req.body as { observaciones?: string };

    const { ok, visita } = await puedeTocarVisita(req, id);
    if (!visita) return res.status(404).json({ error: "Visita no encontrada" });
    if (!ok) return res.status(403).json({ error: "Esta visita no pertenece a tu ruta" });

    const actualizada = await prisma.visitaTecnica.update({
      where: { id },
      data: { estado: "OMITIDA", observaciones: observaciones?.trim() || null },
    });

    res.json(actualizada);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al omitir la visita" });
  }
});
