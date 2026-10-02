// Rutas de visita técnica — un despachador arma la ruta diaria de un
// técnico con las ubicaciones que el cliente ya mandó por WhatsApp
// (ingresadas a mano en un mapa, ver plan de "Visitas Técnicas": sin
// integración automática con WhatsApp esta ronda), el sistema las ordena
// por cercanía (ver utils/rutaVisitas.ts), y el técnico ve SOLO su propia
// ruta del día (vía Usuario.empleadoId) y confirma cada parada con su
// ubicación real al llegar.
import { Router, Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { leerBusqueda, contiene } from "../utils/busquedaListado";
import * as fs from "fs";
import * as path from "path";
import multer from "multer";
import { prisma, empresaActiva, empresaActivaId, ejecutarConEmpresa } from "../db";
import { ordenarPorCercania, type Punto } from "../utils/rutaVisitas";
import { calcularDistanciaMetros } from "../utils/geocercas";
import { fechaLocalDeString, leerRangoFechas, aClaveDia } from "../utils/rangoFechas";
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
  visitas: { orderBy: { orden: "asc" as const }, include: { cliente: true, equiposDejados: true, materialesUtilizados: true } },
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

// Ver PATCH /:id/llegada.
const DISTANCIA_MAXIMA_ACTUALIZAR_UBICACION_METROS = 1000;
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
  motivoVisita?: string;
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
              motivoVisita: p.motivoVisita?.trim() || null,
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
    const { clienteId, nombreContacto, direccion, motivoVisita, latitud, longitud } = req.body as ParadaBody;

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
        motivoVisita: motivoVisita?.trim() || null,
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

// POST /visitas/urgente
// Body: { empleadoId, clienteId?, nombreContacto?, direccion?, motivoVisita?, latitud, longitud }
// Punto de entrada para agendar una visita prioritaria desde FUERA del
// módulo de Visitas (ver Mapa de Red: un técnico/despachador nota un cliente
// caído y lo agenda ahí mismo, sin tener que ir primero a armar una ruta).
// A diferencia de POST /rutas/:id/paradas (que asume que la ruta de HOY del
// empleado ya existe), este resuelve esa ruta él mismo: si no existe, la
// crea de una con esta única parada; si ya existe, le agrega la parada al
// final — en ambos casos marcada esUrgente, igual criterio que la "visita
// flash" de arriba.
visitasRouter.post("/urgente", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { empleadoId, clienteId, nombreContacto, direccion, motivoVisita, latitud, longitud } = req.body as {
      empleadoId: number;
      clienteId?: number;
      nombreContacto?: string;
      direccion?: string;
      motivoVisita?: string;
      latitud: number;
      longitud: number;
    };

    if (!empleadoId) return res.status(400).json({ error: "empleadoId es obligatorio" });
    if (latitud == null || longitud == null) return res.status(400).json({ error: "latitud y longitud son obligatorias" });
    if (!clienteId && !nombreContacto?.trim()) {
      return res.status(400).json({ error: "Se necesita un cliente existente o un nombre de contacto" });
    }

    const empleado = await prisma.empleado.findUnique({ where: { id: empleadoId } });
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });

    let nombreFinal = nombreContacto?.trim();
    if (clienteId) {
      const cliente = await prisma.cliente.findUnique({ where: { id: clienteId } });
      if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });
      nombreFinal = cliente.razonSocial;
    }

    const hoy = fechaLocalDeString(aClaveDia(new Date()), false);
    let ruta = await prisma.rutaVisita.findUnique({ where: { empleadoId_fecha: { empleadoId, fecha: hoy } } });
    const rutaCreada = !ruta;
    if (!ruta) {
      ruta = await prisma.rutaVisita.create({ data: { empleadoId, fecha: hoy } });
    }

    const { _max } = await prisma.visitaTecnica.aggregate({ where: { rutaVisitaId: ruta.id }, _max: { orden: true } });

    const visita = await prisma.visitaTecnica.create({
      data: {
        rutaVisitaId: ruta.id,
        clienteId: clienteId ?? null,
        nombreContacto: nombreFinal!,
        direccion: direccion?.trim() || null,
        motivoVisita: motivoVisita?.trim() || null,
        latitud: new Prisma.Decimal(latitud),
        longitud: new Prisma.Decimal(longitud),
        orden: (_max.orden ?? 0) + 1,
        esUrgente: true,
      },
      include: { cliente: true },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "AGREGAR_VISITA_URGENTE",
      entidad: "VisitaTecnica",
      entidadId: visita.id,
      detalle: `Visita urgente para ${nombreFinal} ${rutaCreada ? "— se creó una ruta nueva de hoy para" : "agregada a la ruta de"} ${empleado.nombres} ${empleado.apellidos}`,
    });

    res.status(201).json({ visita, rutaId: ruta.id, rutaCreada });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear la visita urgente" });
  }
});

// GET /visitas/rutas (historial, opcional ?empleadoId=&fecha=)
visitasRouter.get("/rutas", puedeVer, async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const { empleadoId, fecha } = req.query;
    const rango = leerRangoFechas(req);
    const where: Prisma.RutaVisitaWhereInput = {
      ...(empleadoId && { empleadoId: Number(empleadoId) }),
      ...(fecha && { fecha: fechaLocalDeString(String(fecha), false) }),
      ...(rango && { fecha: rango }),
    };

    // Buscador de "Rutas planificadas": técnico, o cualquier parada de la
    // ruta (cliente, contacto, dirección o motivo de la visita).
    const q = leerBusqueda(req);
    if (q) {
      where.OR = [
        { empleado: { nombres: contiene(q) } },
        { empleado: { apellidos: contiene(q) } },
        { visitas: { some: { cliente: { razonSocial: contiene(q) } } } },
        { visitas: { some: { nombreContacto: contiene(q) } } },
        { visitas: { some: { direccion: contiene(q) } } },
        { visitas: { some: { motivoVisita: contiene(q) } } },
      ];
    }
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
// visitas (de cualquier cliente) por tipo, modelo, serial/MAC, o por el
// cliente al que se le dejaron (nombre/razón social, cédula/RUC, o el
// nombre de contacto si es un prospecto sin registrar) — responde tanto
// "¿dónde está instalado este equipo?" como "¿qué equipos tiene este
// cliente y quién se los entregó?" con la misma búsqueda. Devuelve, por
// cada coincidencia, la visita/cliente/técnico/fecha en la que se dejó.
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
          { visita: { nombreContacto: { contains: q, mode: "insensitive" } } },
          { visita: { cliente: { razonSocial: { contains: q, mode: "insensitive" } } } },
          { visita: { cliente: { identificacion: { contains: q, mode: "insensitive" } } } },
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

// GET /visitas/catalogo-equipos — catálogo de productos físicos (no
// servicios) para que el técnico llene el acta de instalación eligiendo
// datos reales del inventario en vez de tipearlos a mano (ver
// DetalleTrabajoVisita.tsx). A propósito NO gatea por el permiso
// "productos" ni por puedeVer/puedeEditar: cualquier técnico autenticado
// necesita poder leer esto para su propia acta, aunque no tenga acceso al
// módulo de Productos — mismo criterio que /:id/detalle-trabajo. Solo
// expone lo mínimo (nombre/marca/modelo/si controla serie), nunca costo ni
// stock.
visitasRouter.get("/catalogo-equipos", async (_req: Request, res: Response) => {
  try {
    const productos = await prisma.producto.findMany({
      where: { activo: true, esServicio: false },
      select: { id: true, nombre: true, marca: true, modelo: true, controlaNumeroSerie: true },
      orderBy: { nombre: "asc" },
    });
    res.json(productos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener el catálogo de equipos" });
  }
});

// GET /visitas/catalogo-equipos/:productoId/series — números de serie de un
// producto puntual que el técnico logueado tiene EN_TRANSITO (le fueron
// despachados a ÉL en un EgresoBodega, ver schema.prisma) — para el select
// de "Serial / MAC" del acta. Antes de que existiera EgresoBodega esto
// mostraba TODO lo que estuviera EN_BODEGA sin importar quién lo tuviera en
// mano; ahora un técnico solo puede elegir equipos que bodega realmente le
// despachó a él, para que el acta refleje la custodia física real. Mismo
// criterio de acceso que la ruta de arriba, sin gatear por "productos".
visitasRouter.get("/catalogo-equipos/:productoId/series", async (req: Request, res: Response) => {
  try {
    const productoId = Number(req.params.productoId);
    const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario!.usuarioId }, select: { empleadoId: true } });
    if (!usuario?.empleadoId) return res.json([]); // sin empleado vinculado, no puede tener nada despachado

    const series = await prisma.numeroSerieProducto.findMany({
      where: {
        productoId,
        estado: "EN_TRANSITO",
        egresosDetalle: { some: { estado: "EN_TRANSITO", egreso: { empleadoId: usuario.empleadoId } } },
      },
      select: { id: true, numeroSerie: true },
      orderBy: { numeroSerie: "asc" },
    });
    res.json(series);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener los números de serie disponibles" });
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
        materialesUtilizados: true,
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

    const hoy = fechaLocalDeString(aClaveDia(new Date()), false);
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

// Señal interna para PATCH /:id/detalle-trabajo: un serial elegido del
// catálogo ya no está EN_BODEGA (otro técnico lo tomó primero) — se
// distingue del resto de errores para responder 409 en vez de 500.
class SerialNoDisponibleError extends Error {}

// Mismo criterio: no quedan suficientes metros en el rollo elegido para
// cubrir lo que esta acta está pidiendo descontar (ver reconciliación de
// metraje en PATCH /:id/detalle-trabajo).
class MetrosInsuficientesError extends Error {}

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
    // Pasado este punto ya no es "la ubicación planeada estaba corrida unos
    // metros": el técnico marcó desde otro lado (o desde su casa). En ese
    // caso NO se pisa la ubicación guardada del cliente — si no, una sola
    // marcación hecha de lejos dejaría mal la casa del cliente para todas
    // las visitas siguientes. La visita igual se registra (y aparece como
    // sospechosa en el Centro de Control).
    const actualizaUbicacionCliente = !!visita.clienteId && distanciaAlPunto <= DISTANCIA_MAXIMA_ACTUALIZAR_UBICACION_METROS;

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
      ...(actualizaUbicacionCliente
        ? [
            prisma.cliente.update({
              where: { id: visita.clienteId },
              data: { latitud: new Prisma.Decimal(latitud), longitud: new Prisma.Decimal(longitud) },
            }),
          ]
        : []),
    ]);

    // Si la visita salió de un ticket de soporte, el técnico en la puerta del
    // cliente cuenta como "en atención".
    await prisma.ticketSoporte.updateMany({
      where: { visitaTecnicaId: id, estado: "ABIERTO" },
      data: { estado: "EN_PROCESO", fechaPrimeraAtencion: new Date() },
    });

    res.json({ ...actualizada, ubicacionClienteActualizada: actualizaUbicacionCliente });
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

        let equipos: {
          tipo: string;
          modelo?: string;
          serial?: string;
          numeroSerieProductoId?: number;
          asignacionMetrajeId?: number;
          metrosUsados?: number;
        }[] = [];
        if (req.body.equipos) {
          try {
            const parseado = JSON.parse(req.body.equipos);
            if (!Array.isArray(parseado)) throw new Error();
            equipos = parseado
              .filter((e: any) => typeof e?.tipo === "string" && e.tipo.trim())
              .map((e: any) => ({
                tipo: e.tipo.trim(),
                modelo: e.modelo?.trim() || undefined,
                serial: e.serial?.trim() || undefined,
                numeroSerieProductoId: Number.isInteger(e.numeroSerieProductoId) ? e.numeroSerieProductoId : undefined,
                asignacionMetrajeId: Number.isInteger(e.asignacionMetrajeId) ? e.asignacionMetrajeId : undefined,
                metrosUsados: Number.isInteger(e.metrosUsados) && e.metrosUsados > 0 ? e.metrosUsados : undefined,
              }));
          } catch {
            limpiarArchivosSubidos();
            return res.status(400).json({ error: '"equipos" debe ser un JSON válido con una lista de {tipo, modelo?, serial?}' });
          }
        }
        // asignacionMetrajeId y metrosUsados van juntos siempre: elegir un
        // rollo sin decir cuántos metros (o viceversa) no tiene sentido.
        const filaMetrajeIncompleta = equipos.some((e) => (e.asignacionMetrajeId != null) !== (e.metrosUsados != null));
        if (filaMetrajeIncompleta) {
          limpiarArchivosSubidos();
          return res.status(400).json({ error: "Si elegís un rollo de metraje, también tenés que indicar cuántos metros usaste (y viceversa)" });
        }

        // Insumos consumidos (cinta, canaleta, conectores, etc.) — ver
        // comentario de VisitaTecnica.materialesUtilizados en schema.prisma.
        // Reemplaza la lista completa cada vez, igual que "equipos".
        let materiales: { descripcion: string; cantidad: number; unidad?: string }[] = [];
        if (req.body.materiales) {
          try {
            const parseado = JSON.parse(req.body.materiales);
            if (!Array.isArray(parseado)) throw new Error();
            materiales = parseado
              .filter((m: any) => typeof m?.descripcion === "string" && m.descripcion.trim() && Number.isInteger(m.cantidad) && m.cantidad > 0)
              .map((m: any) => ({
                descripcion: m.descripcion.trim(),
                cantidad: m.cantidad,
                unidad: m.unidad?.trim() || undefined,
              }));
          } catch {
            limpiarArchivosSubidos();
            return res.status(400).json({ error: '"materiales" debe ser un JSON válido con una lista de {descripcion, cantidad, unidad?}' });
          }
        }

        const TIPOS_TRABAJO_VALIDOS = ["INSTALACION_NUEVA", "MEJORA_EXISTENTE"];
        const tipoTrabajoBody = typeof req.body.tipoTrabajo === "string" ? req.body.tipoTrabajo : undefined;
        if (tipoTrabajoBody && !TIPOS_TRABAJO_VALIDOS.includes(tipoTrabajoBody)) {
          limpiarArchivosSubidos();
          return res.status(400).json({ error: "tipoTrabajo inválido" });
        }

        const fotoTrabajoUrl = archivos?.fotoTrabajo?.[0] ? `/uploads/${empresaId}/visitas/${archivos.fotoTrabajo[0].filename}` : undefined;
        const fotoViviendaUrl = archivos?.fotoVivienda?.[0] ? `/uploads/${empresaId}/visitas/${archivos.fotoVivienda[0].filename}` : undefined;

        // Marca en NumeroSerieProducto.referenciaDocumento cuando ESTA acta
        // es quien entregó un serial — para poder devolverlo a EN_BODEGA más
        // adelante sin arriesgarse a pisar una entrega hecha a mano en otro
        // lado con el mismo serial (ver más abajo).
        const referenciaActa = `Visita técnica #${id}`;

        let actualizada;
        try {
          actualizada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            const anteriores = await tx.equipoDejadoVisita.findMany({
              where: { visitaId: id },
              select: { numeroSerieProductoId: true },
            });
            const idsAntes = new Set(anteriores.map((e) => e.numeroSerieProductoId).filter((v): v is number => v != null));
            const idsAhora = new Set(equipos.map((e) => e.numeroSerieProductoId).filter((v): v is number => v != null));

            // Serial que esta misma acta había entregado y ya no está en la
            // lista nueva (se quitó o se cambió por otro) — vuelve a
            // EN_TRANSITO (el técnico lo sigue teniendo físicamente en
            // mano, ver EgresoBodega — NO vuelve a EN_BODEGA, eso solo pasa
            // si bodega lo recibe de vuelta de verdad, ver PATCH
            // /egresos-bodega/detalles/:id/devolver).
            const idsALiberar = [...idsAntes].filter((sid) => !idsAhora.has(sid));
            if (idsALiberar.length > 0) {
              await tx.numeroSerieProducto.updateMany({
                where: { id: { in: idsALiberar }, estado: "ENTREGADO", referenciaDocumento: referenciaActa },
                data: { estado: "EN_TRANSITO", clienteId: null, referenciaDocumento: null, fechaEntrega: null },
              });
              await tx.egresoBodegaDetalle.updateMany({
                where: { numeroSerieProductoId: { in: idsALiberar }, estado: "ENTREGADO" },
                data: { estado: "EN_TRANSITO" },
              });
            }

            // Serial nuevo elegido del catálogo — se marca ENTREGADO para
            // que no vuelva a ofrecerse en la próxima visita, y se cierra su
            // línea de egreso (ver EgresoBodegaDetalle). Si alguien más ya
            // lo tomó mientras tanto (ya no está EN_TRANSITO con ESTE
            // técnico — se entregó, se devolvió, o directamente nunca se le
            // despachó), se rechaza toda la operación para que el técnico
            // elija otro en vez de quedar con un acta a medio guardar.
            const idsANuevos = [...idsAhora].filter((sid) => !idsAntes.has(sid));
            for (const sid of idsANuevos) {
              const resultado = await tx.numeroSerieProducto.updateMany({
                where: { id: sid, estado: "EN_TRANSITO" },
                data: { estado: "ENTREGADO", clienteId: visita.clienteId, referenciaDocumento: referenciaActa, fechaEntrega: new Date() },
              });
              if (resultado.count === 0) throw new SerialNoDisponibleError();
              await tx.egresoBodegaDetalle.updateMany({
                where: { numeroSerieProductoId: sid, estado: "EN_TRANSITO" },
                data: { estado: "ENTREGADO" },
              });
            }

            // Metraje: como el acta se REEMPLAZA completa cada vez, se
            // calcula el delta neto por rollo entre lo que esta MISMA acta
            // tenía antes y lo que tiene ahora — revierte lo viejo y aplica
            // lo nuevo en un solo paso, así corregir el acta varias veces
            // nunca duplica ni pierde metros (mismo espíritu que los
            // seriales arriba, pero con una resta neta en vez de dos listas).
            const anterioresMetraje = await tx.equipoDejadoVisita.findMany({
              where: { visitaId: id, asignacionMetrajeId: { not: null } },
              select: { asignacionMetrajeId: true, metrosUsados: true },
            });
            const deltaPorAsignacion = new Map<number, number>(); // positivo = descontar, negativo = devolver
            for (const e of anterioresMetraje) {
              if (e.asignacionMetrajeId == null) continue;
              deltaPorAsignacion.set(e.asignacionMetrajeId, (deltaPorAsignacion.get(e.asignacionMetrajeId) ?? 0) - (e.metrosUsados ?? 0));
            }
            for (const e of equipos) {
              if (e.asignacionMetrajeId == null) continue;
              deltaPorAsignacion.set(e.asignacionMetrajeId, (deltaPorAsignacion.get(e.asignacionMetrajeId) ?? 0) + (e.metrosUsados ?? 0));
            }
            for (const [asignacionId, delta] of deltaPorAsignacion) {
              if (delta === 0) continue;
              const asignacion = await tx.asignacionMetraje.findUnique({ where: { id: asignacionId } });
              if (!asignacion) throw new MetrosInsuficientesError();
              const nuevoRestante = asignacion.metrosRestantes - delta;
              if (nuevoRestante < 0 || nuevoRestante > asignacion.metrosIniciales) throw new MetrosInsuficientesError();
              await tx.asignacionMetraje.update({ where: { id: asignacionId }, data: { metrosRestantes: nuevoRestante } });
            }

            await tx.equipoDejadoVisita.deleteMany({ where: { visitaId: id } });
            await tx.materialUtilizadoVisita.deleteMany({ where: { visitaId: id } });
            return tx.visitaTecnica.update({
              where: { id },
              data: {
                descripcionTrabajo: req.body.descripcionTrabajo?.trim() || undefined,
                ...(tipoTrabajoBody && { tipoTrabajo: tipoTrabajoBody as "INSTALACION_NUEVA" | "MEJORA_EXISTENTE" }),
                ...(fotoTrabajoUrl && { fotoTrabajoUrl }),
                ...(fotoViviendaUrl && { fotoViviendaUrl }),
                equiposDejados: { create: equipos },
                materialesUtilizados: { create: materiales },
              },
              include: { equiposDejados: true, materialesUtilizados: true },
            });
          });
        } catch (error) {
          if (error instanceof SerialNoDisponibleError) {
            limpiarArchivosSubidos();
            return res
              .status(409)
              .json({ error: "Uno de los números de serie elegidos ya no está disponible en bodega (probablemente otro técnico lo usó). Vuelve a elegirlo y guarda de nuevo." });
          }
          if (error instanceof MetrosInsuficientesError) {
            limpiarArchivosSubidos();
            return res.status(409).json({ error: "No quedan suficientes metros en uno de los rollos elegidos — revisá cuánto te queda y ajustá la cantidad." });
          }
          throw error;
        }

        await registrarAuditoria(prisma, {
          usuarioId: req.usuario!.usuarioId,
          accion: "REGISTRAR_DETALLE_TRABAJO_VISITA",
          entidad: "VisitaTecnica",
          entidadId: id,
          detalle: `${visita.nombreContacto}: ${equipos.length} equipo(s) dejado(s), ${materiales.length} material(es)`,
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

// --- Reasignar visitas a otro técnico (solo despachador/admin) ---
// Caso de uso: el técnico dueño de la ruta no puede cumplirla (se dañó el
// vehículo, se enfermó) y el despachador tiene que pasar sus visitas
// PENDIENTES a otro técnico, el mismo día. Nunca cambia la fecha ni toca las
// visitas ya COMPLETADAS/OMITIDAS (esas las hizo el técnico original).

// Valida el Empleado destino de una reasignación. Devuelve un mensaje de
// error, o null si está todo bien.
async function validarEmpleadoDestino(empleadoDestinoId: number, empleadoActualId: number): Promise<string | null> {
  if (!empleadoDestinoId) return "empleadoId (técnico destino) es obligatorio";
  if (empleadoDestinoId === empleadoActualId) return "El técnico destino debe ser distinto al que tiene la visita ahora";
  const empleado = await prisma.empleado.findUnique({ where: { id: empleadoDestinoId } });
  if (!empleado || !empleado.activo) return "El técnico destino no existe o está inactivo";
  return null;
}

// Mueve UNA visita a la ruta del técnico destino en la MISMA fecha, creando
// esa ruta si aún no existe (mismo unique empleadoId_fecha que usa
// mi-ruta-hoy). La visita se agrega al final y se marca esUrgente para que
// el técnico que la recibe la note — igual criterio que una "visita flash"
// (ver POST /rutas/:id/paradas). Si la ruta de origen queda sin visitas, se
// borra. Devuelve el id de la ruta destino. Debe correr dentro de una
// transacción.
async function moverVisitaARuta(
  tx: Prisma.TransactionClient,
  visita: { id: number; rutaVisitaId: number; rutaVisita: { fecha: Date } },
  empleadoDestinoId: number
): Promise<number> {
  const rutaDestino = await tx.rutaVisita.upsert({
    where: { empleadoId_fecha: { empleadoId: empleadoDestinoId, fecha: visita.rutaVisita.fecha } },
    create: { empleadoId: empleadoDestinoId, fecha: visita.rutaVisita.fecha },
    update: {},
  });

  const { _max } = await tx.visitaTecnica.aggregate({ where: { rutaVisitaId: rutaDestino.id }, _max: { orden: true } });
  await tx.visitaTecnica.update({
    where: { id: visita.id },
    data: { rutaVisitaId: rutaDestino.id, orden: (_max.orden ?? 0) + 1, esUrgente: true },
  });

  const quedan = await tx.visitaTecnica.count({ where: { rutaVisitaId: visita.rutaVisitaId } });
  if (quedan === 0) {
    // deleteMany (no delete) para no lanzar si en un lote esta misma ruta ya
    // se borró en una iteración anterior.
    await tx.rutaVisita.deleteMany({ where: { id: visita.rutaVisitaId } });
  }

  return rutaDestino.id;
}

// PATCH /visitas/:id/reasignar  { empleadoId }
visitasRouter.patch("/:id/reasignar", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const empleadoDestinoId = Number((req.body as { empleadoId?: number }).empleadoId);

    const visita = await prisma.visitaTecnica.findUnique({
      where: { id },
      include: { rutaVisita: { include: { empleado: true } } },
    });
    if (!visita) return res.status(404).json({ error: "Visita no encontrada" });
    if (visita.estado !== "PENDIENTE") {
      return res.status(400).json({ error: "Solo se puede reasignar una visita que sigue pendiente" });
    }

    const errorValidacion = await validarEmpleadoDestino(empleadoDestinoId, visita.rutaVisita.empleadoId);
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });

    const destino = await prisma.empleado.findUnique({ where: { id: empleadoDestinoId } });
    const origen = visita.rutaVisita.empleado;
    const fecha = visita.rutaVisita.fecha.toISOString().slice(0, 10);

    const rutaDestinoId = await prisma.$transaction((tx) => moverVisitaARuta(tx, visita, empleadoDestinoId));

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "REASIGNAR_VISITA",
      entidad: "VisitaTecnica",
      entidadId: id,
      detalle: `${visita.nombreContacto}: de ${origen.nombres} ${origen.apellidos} a ${destino!.nombres} ${destino!.apellidos} (${fecha})`,
    });

    const rutaDestino = await prisma.rutaVisita.findUnique({ where: { id: rutaDestinoId }, include: INCLUDE_RUTA });
    res.json(rutaDestino);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al reasignar la visita" });
  }
});

// PATCH /visitas/rutas/:id/reasignar  { empleadoId }
// Pasa TODAS las visitas pendientes de una ruta a otro técnico de una sola
// vez. Las COMPLETADAS/OMITIDAS se quedan con el técnico original.
visitasRouter.patch("/rutas/:id/reasignar", puedeEditar, async (req: Request, res: Response) => {
  try {
    const rutaId = Number(req.params.id);
    const empleadoDestinoId = Number((req.body as { empleadoId?: number }).empleadoId);

    const ruta = await prisma.rutaVisita.findUnique({
      where: { id: rutaId },
      include: { empleado: true, visitas: true },
    });
    if (!ruta) return res.status(404).json({ error: "Ruta no encontrada" });

    const pendientes = ruta.visitas.filter((v) => v.estado === "PENDIENTE");
    if (pendientes.length === 0) {
      return res.status(400).json({ error: "Esta ruta no tiene visitas pendientes por reasignar" });
    }

    const errorValidacion = await validarEmpleadoDestino(empleadoDestinoId, ruta.empleadoId);
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });

    const destino = await prisma.empleado.findUnique({ where: { id: empleadoDestinoId } });
    const fecha = ruta.fecha.toISOString().slice(0, 10);

    let rutaDestinoId = 0;
    await prisma.$transaction(async (tx) => {
      for (const v of pendientes) {
        rutaDestinoId = await moverVisitaARuta(
          tx,
          { id: v.id, rutaVisitaId: v.rutaVisitaId, rutaVisita: { fecha: ruta.fecha } },
          empleadoDestinoId
        );
      }
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "REASIGNAR_RUTA",
      entidad: "RutaVisita",
      entidadId: rutaId,
      detalle: `${pendientes.length} visita(s) de ${ruta.empleado.nombres} ${ruta.empleado.apellidos} a ${destino!.nombres} ${destino!.apellidos} (${fecha})`,
    });

    const rutaDestino = await prisma.rutaVisita.findUnique({ where: { id: rutaDestinoId }, include: INCLUDE_RUTA });
    res.json(rutaDestino);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al reasignar las visitas de la ruta" });
  }
});
