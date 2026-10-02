// Flota de vehículos de trabajo de la empresa — catálogo de vehículos
// (marca/modelo desde catálogo propio, nunca texto libre), uso diario
// (cualquier técnico puede tomar cualquier vehículo libre, ver UsoVehiculo)
// y el historial de cargas de combustible y mantenimientos de cada uno.
// "Ver"/"editar" del catálogo de vehículos van separados igual que Nómina
// (ver utils/permisos.ts); el uso diario (abrir/cerrar) NO exige ninguno de
// esos dos permisos — cualquier Usuario con un Empleado vinculado puede
// abrir/cerrar SU PROPIO uso, mismo criterio que "Mi ruta de hoy" en
// routes/visitas.ts (ver puedeVer/puedeEditar solo en las rutas de catálogo
// y en el historial administrativo).
import { Router, Request, Response, NextFunction } from "express";
import * as fs from "fs";
import * as path from "path";
import multer from "multer";
import { Prisma } from "@prisma/client";
import { prisma, empresaActiva, empresaActivaId, ejecutarConEmpresa } from "../db";
import { rutaAbsoluta } from "../utils/empresas";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerTextoBusqueda } from "../utils/busqueda";
import { leerRangoFechas } from "../utils/rangoFechas";
import { registrarAuditoria } from "../utils/auditoria";
import { recalcularKilometrajeVehiculo, calcularAlertasMantenimiento } from "../utils/vehiculos";
import { requirePermiso } from "../middleware/auth";

export const vehiculosRouter = Router();

const puedeVer = requirePermiso("vehiculos");
const puedeEditar = requirePermiso("vehiculos_editar");

const SELECT_VEHICULO = {
  id: true,
  placa: true,
  marcaId: true,
  marca: { select: { id: true, nombre: true } },
  modeloId: true,
  modelo: { select: { id: true, nombre: true } },
  anio: true,
  color: true,
  sucursalId: true,
  sucursal: { select: { id: true, nombre: true } },
  kilometrajeActual: true,
  activo: true,
  createdAt: true,
  // Quién lo tiene EN_USO ahora mismo (si alguien) — para que el panel de
  // administración tenga visibilidad sin depender de un "responsable fijo"
  // (ese concepto ya no existe, ver UsoVehiculo). take:1 alcanza porque el
  // índice único parcial garantiza como mucho un EN_USO por vehículo.
  usos: {
    where: { estado: "EN_USO" as const },
    take: 1,
    select: { id: true, empleado: { select: { id: true, nombres: true, apellidos: true } }, kilometrajeInicial: true, fechaInicio: true },
  },
} as const;

const INCLUDE_USO = {
  vehiculo: { select: { id: true, placa: true, marca: { select: { nombre: true } }, modelo: { select: { nombre: true } } } },
  empleado: { select: { id: true, nombres: true, apellidos: true } },
} as const;

// ============================================================
// Catálogo de marcas y modelos — se administra desde el formulario de
// Vehículos (crear una marca/modelo nuevo si no está en la lista), para que
// nadie tenga que escribir "Chevrolet" a mano cada vez (y arriesgarse a
// escribirlo distinto la próxima). Gateado igual que el resto del catálogo
// de vehículos.
// ============================================================

// GET /vehiculos/marcas
vehiculosRouter.get("/marcas", puedeVer, async (req: Request, res: Response) => {
  try {
    const marcas = await prisma.marcaVehiculo.findMany({ where: { activo: true }, orderBy: { nombre: "asc" } });
    res.json(marcas);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las marcas" });
  }
});

// POST /vehiculos/marcas
vehiculosRouter.post("/marcas", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { nombre } = req.body as { nombre?: string };
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: "nombre es obligatorio" });

    const marca = await prisma.marcaVehiculo.create({ data: { nombre: nombre.trim().toUpperCase() } });
    res.status(201).json(marca);
  } catch (error: any) {
    if (error.code === "P2002") return res.status(409).json({ error: "Ya existe esa marca" });
    console.error(error);
    res.status(500).json({ error: "Error al crear la marca" });
  }
});

// GET /vehiculos/modelos?marcaId=
vehiculosRouter.get("/modelos", puedeVer, async (req: Request, res: Response) => {
  try {
    const { marcaId } = req.query;
    const modelos = await prisma.modeloVehiculo.findMany({
      where: { activo: true, ...(marcaId ? { marcaId: Number(marcaId) } : {}) },
      orderBy: { nombre: "asc" },
    });
    res.json(modelos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los modelos" });
  }
});

// POST /vehiculos/modelos
// Body: { marcaId, nombre }
vehiculosRouter.post("/modelos", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { marcaId, nombre } = req.body as { marcaId?: number; nombre?: string };
    if (!marcaId) return res.status(400).json({ error: "marcaId es obligatorio" });
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: "nombre es obligatorio" });

    const marca = await prisma.marcaVehiculo.findUnique({ where: { id: Number(marcaId) } });
    if (!marca) return res.status(404).json({ error: "Marca no encontrada" });

    const modelo = await prisma.modeloVehiculo.create({ data: { marcaId: Number(marcaId), nombre: nombre.trim().toUpperCase() } });
    res.status(201).json(modelo);
  } catch (error: any) {
    if (error.code === "P2002") return res.status(409).json({ error: "Ya existe ese modelo para esa marca" });
    console.error(error);
    res.status(500).json({ error: "Error al crear el modelo" });
  }
});

// ============================================================
// Uso diario (abrir/cerrar) — el corazón del módulo. Mismo patrón que
// CajaSesion (ver routes/caja.ts): como mucho un uso EN_USO por vehículo y
// como mucho uno EN_USO por técnico a la vez (reforzado con sendos índices
// únicos parciales, ver la migración). Ninguna de estas rutas exige
// "vehiculos"/"vehiculos_editar" — cualquier Usuario con Empleado vinculado
// puede abrir/cerrar SU PROPIO uso, igual que "Mi ruta de hoy" en visitas.ts.
// ============================================================

async function empleadoDelUsuarioActual(usuarioId: number): Promise<number | null> {
  const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } });
  return usuario?.empleadoId ?? null;
}

// GET /vehiculos/uso/mi-actual — el uso EN_USO del técnico logueado, o
// { uso: null } si no tiene ninguno abierto ahora mismo (estado válido, no
// un error). Si tiene uno, además trae los planes de mantenimiento y los
// avisos (vencido/próximo) de ESE vehículo puntual — así la app móvil
// (VehiculoMovil.tsx) puede mostrar los recordatorios y el "próximo
// calculado" al registrar un mantenimiento sin necesitar el permiso
// "vehiculos" (un técnico de campo normalmente no lo tiene).
vehiculosRouter.get("/uso/mi-actual", async (req: Request, res: Response) => {
  try {
    const empleadoId = await empleadoDelUsuarioActual(req.usuario!.usuarioId);
    if (!empleadoId) {
      return res.status(400).json({ error: "Tu usuario no tiene un empleado vinculado. Pide a un administrador que te vincule en Usuarios." });
    }

    const uso = await prisma.usoVehiculo.findFirst({
      where: { empleadoId, estado: "EN_USO" },
      include: INCLUDE_USO,
    });

    if (!uso) return res.json({ uso: null, planesMantenimiento: [], alertasMantenimiento: [] });

    const [planesMantenimiento, alertasMantenimiento] = await Promise.all([
      prisma.planMantenimientoVehiculo.findMany({ where: { vehiculoId: uso.vehiculoId, activo: true } }),
      calcularAlertasMantenimiento(prisma, { id: uso.vehiculoId }),
    ]);

    res.json({ uso, planesMantenimiento, alertasMantenimiento });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al consultar tu uso actual" });
  }
});

// GET /vehiculos/uso/disponibles — vehículos activos que NADIE tiene en uso
// ahora mismo, para el selector de "elegir vehículo del día".
vehiculosRouter.get("/uso/disponibles", async (req: Request, res: Response) => {
  try {
    const empleadoId = await empleadoDelUsuarioActual(req.usuario!.usuarioId);
    if (!empleadoId) {
      return res.status(400).json({ error: "Tu usuario no tiene un empleado vinculado. Pide a un administrador que te vincule en Usuarios." });
    }

    const disponibles = await prisma.vehiculo.findMany({
      where: { activo: true, usos: { none: { estado: "EN_USO" } } },
      select: SELECT_VEHICULO,
      orderBy: { placa: "asc" },
    });
    res.json(disponibles);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los vehículos disponibles" });
  }
});

// POST /vehiculos/uso/abrir
// Body: { vehiculoId, kilometrajeInicial, golpesCarroceria?, vidrios?, llantas?,
//         lucesVisibles?, accesorios?, llaves?, documentacion?, equiposHerramientas? }
// El checklist de entrega (todo lo que no sea kilometraje) es texto libre y
// TOTALMENTE opcional a nivel de validación — no se bloquea a un técnico de
// empezar su día por no describir el estado de las llantas, aunque en la
// práctica la pantalla móvil sí los pida todos (ver VehiculoMovil.tsx).
vehiculosRouter.post("/uso/abrir", async (req: Request, res: Response) => {
  try {
    const {
      vehiculoId,
      kilometrajeInicial,
      golpesCarroceria,
      vidrios,
      llantas,
      lucesVisibles,
      accesorios,
      llaves,
      documentacion,
      equiposHerramientas,
    } = req.body as {
      vehiculoId?: number;
      kilometrajeInicial?: number;
      golpesCarroceria?: string;
      vidrios?: string;
      llantas?: string;
      lucesVisibles?: string;
      accesorios?: string;
      llaves?: string;
      documentacion?: string;
      equiposHerramientas?: string;
    };
    if (!vehiculoId) return res.status(400).json({ error: "vehiculoId es obligatorio" });
    if (kilometrajeInicial === undefined || Number(kilometrajeInicial) < 0) {
      return res.status(400).json({ error: "kilometrajeInicial es obligatorio y debe ser mayor o igual a 0" });
    }

    const empleadoId = await empleadoDelUsuarioActual(req.usuario!.usuarioId);
    if (!empleadoId) {
      return res.status(400).json({ error: "Tu usuario no tiene un empleado vinculado. Pide a un administrador que te vincule en Usuarios." });
    }

    const vehiculo = await prisma.vehiculo.findUnique({ where: { id: Number(vehiculoId) } });
    if (!vehiculo || !vehiculo.activo) return res.status(404).json({ error: "Vehículo no encontrado o dado de baja" });

    const uso = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const yaTengoUno = await tx.usoVehiculo.findFirst({ where: { empleadoId, estado: "EN_USO" } });
      if (yaTengoUno) throw new Error("YA_TIENES_UN_USO_ABIERTO");

      const vehiculoEnUso = await tx.usoVehiculo.findFirst({
        where: { vehiculoId: Number(vehiculoId), estado: "EN_USO" },
        include: { empleado: { select: { nombres: true, apellidos: true } } },
      });
      if (vehiculoEnUso) throw new Error(`VEHICULO_YA_EN_USO:${vehiculoEnUso.empleado.nombres} ${vehiculoEnUso.empleado.apellidos}`);

      const creado = await tx.usoVehiculo.create({
        data: {
          vehiculoId: Number(vehiculoId),
          empleadoId,
          kilometrajeInicial: Number(kilometrajeInicial),
          golpesCarroceria: golpesCarroceria || undefined,
          vidrios: vidrios || undefined,
          llantas: llantas || undefined,
          lucesVisibles: lucesVisibles || undefined,
          accesorios: accesorios || undefined,
          llaves: llaves || undefined,
          documentacion: documentacion || undefined,
          equiposHerramientas: equiposHerramientas || undefined,
        },
        include: INCLUDE_USO,
      });
      await recalcularKilometrajeVehiculo(tx, Number(vehiculoId));

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "ABRIR_USO_VEHICULO",
        entidad: "UsoVehiculo",
        entidadId: creado.id,
        detalle: `${creado.vehiculo.placa} — km inicial ${creado.kilometrajeInicial}`,
      });

      return creado;
    });

    res.status(201).json(uso);
  } catch (error: any) {
    if (error.message === "YA_TIENES_UN_USO_ABIERTO") {
      return res.status(409).json({ error: "Ya tenés un vehículo en uso — cerralo antes de tomar otro." });
    }
    if (typeof error.message === "string" && error.message.startsWith("VEHICULO_YA_EN_USO")) {
      return res.status(409).json({ error: `Ese vehículo ya está en uso (lo tiene ${error.message.split(":")[1]}).` });
    }
    // Colisión de la capa 2 (índices únicos parciales) si dos aperturas
    // llegaron casi simultáneas y ambas pasaron el chequeo de arriba antes
    // del commit — mismo criterio que POST /caja/abrir.
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ese vehículo o tu usuario ya tienen un uso abierto — actualizá la pantalla e intentá de nuevo." });
    }
    console.error(error);
    res.status(500).json({ error: "Error al abrir el uso del vehículo" });
  }
});

// PATCH /vehiculos/uso/:id/cerrar
// Body: { kilometrajeFinal, observaciones? }
// Lo puede cerrar el técnico dueño del uso, o un administrador/
// "vehiculos_editar" (por si el técnico se olvidó).
vehiculosRouter.patch("/uso/:id/cerrar", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { kilometrajeFinal, observaciones } = req.body as { kilometrajeFinal?: number; observaciones?: string };

    const uso = await prisma.usoVehiculo.findUnique({ where: { id } });
    if (!uso) return res.status(404).json({ error: "Uso de vehículo no encontrado" });
    if (uso.estado !== "EN_USO") return res.status(409).json({ error: "Ese uso ya está cerrado" });

    if (req.usuario!.rol !== "ADMIN") {
      const usuarioActual = await prisma.usuario.findUnique({
        where: { id: req.usuario!.usuarioId },
        select: { empleadoId: true, permisos: true },
      });
      const tienePermisoEditar = usuarioActual?.permisos.includes("vehiculos_editar") ?? false;
      if (!tienePermisoEditar && usuarioActual?.empleadoId !== uso.empleadoId) {
        return res.status(403).json({ error: "No podés cerrar el uso de otro técnico" });
      }
    }

    if (kilometrajeFinal === undefined || Number(kilometrajeFinal) < uso.kilometrajeInicial) {
      return res.status(400).json({ error: `kilometrajeFinal debe ser mayor o igual al inicial (${uso.kilometrajeInicial})` });
    }

    const cerrado = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const actualizado = await tx.usoVehiculo.update({
        where: { id },
        data: {
          estado: "FINALIZADO",
          kilometrajeFinal: Number(kilometrajeFinal),
          fechaFin: new Date(),
          observaciones: observaciones || undefined,
        },
        include: INCLUDE_USO,
      });
      await recalcularKilometrajeVehiculo(tx, uso.vehiculoId);

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "CERRAR_USO_VEHICULO",
        entidad: "UsoVehiculo",
        entidadId: actualizado.id,
        detalle: `${actualizado.vehiculo.placa} — km final ${actualizado.kilometrajeFinal} (${Number(kilometrajeFinal) - uso.kilometrajeInicial} km recorridos)`,
      });

      return actualizado;
    });

    res.json(cerrado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al cerrar el uso del vehículo" });
  }
});

// GET /vehiculos/uso/historial — vista administrativa, paginada, filtrable.
vehiculosRouter.get("/uso/historial", puedeVer, async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const { vehiculoId, empleadoId } = req.query;
    const where: Prisma.UsoVehiculoWhereInput = {
      ...(vehiculoId ? { vehiculoId: Number(vehiculoId) } : {}),
      ...(empleadoId ? { empleadoId: Number(empleadoId) } : {}),
    };
    const opciones = { where, include: INCLUDE_USO, orderBy: { fechaInicio: "desc" as const } };

    if (!paginacion.aplica) {
      const usos = await prisma.usoVehiculo.findMany(opciones);
      return res.json(usos);
    }

    const [usos, total] = await Promise.all([
      prisma.usoVehiculo.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.usoVehiculo.count({ where }),
    ]);
    res.json(respuestaPaginada(usos, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar el historial de uso" });
  }
});

// ============================================================
// Catálogo de vehículos
// ============================================================

// GET /vehiculos
// Sin "?page=" trae TODOS (selector de vehículo en otras pantallas). Con
// "?page=" pagina (la tabla de esta página). "?q=" busca por placa, marca o
// modelo.
vehiculosRouter.get("/", puedeVer, async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const busqueda = leerTextoBusqueda(req);
    const where: Prisma.VehiculoWhereInput = {
      ...(busqueda && {
        OR: [
          { placa: { contains: busqueda, mode: "insensitive" } },
          { marca: { nombre: { contains: busqueda, mode: "insensitive" } } },
          { modelo: { nombre: { contains: busqueda, mode: "insensitive" } } },
        ],
      }),
      // Filtros opcionales de la pantalla Vehículos (sin ellos, igual que antes).
      ...(req.query.estado === "ACTIVO" && { activo: true }),
      ...(req.query.estado === "BAJA" && { activo: false }),
      ...(req.query.sucursalId === "sin" && { sucursalId: null }),
      ...(typeof req.query.sucursalId === "string" && /^[0-9]+$/.test(req.query.sucursalId) && { sucursalId: Number(req.query.sucursalId) }),
    };
    const opciones = { where, select: SELECT_VEHICULO, orderBy: { placa: "asc" as const } };

    if (!paginacion.aplica) {
      const vehiculos = await prisma.vehiculo.findMany(opciones);
      return res.json(vehiculos);
    }

    const [vehiculos, total] = await Promise.all([
      prisma.vehiculo.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.vehiculo.count({ where }),
    ]);
    res.json(respuestaPaginada(vehiculos, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar vehículos" });
  }
});

// GET /vehiculos/alertas-mantenimiento — todos los vehículos activos, vista
// admin. Pensado para el banner de avisos en VehiculosPage.tsx. Ver
// calcularAlertasMantenimiento en utils/vehiculos.ts (reusada también por
// GET /vehiculos/uso/mi-actual, acotada a un solo vehículo, sin exigir el
// permiso "vehiculos").
// OJO de ubicación: tiene que ir ANTES de "GET /:id" (más abajo) — Express
// matchea rutas en el orden en que se registran, y "/:id" (un solo
// segmento, cualquier valor) capturaría "/alertas-mantenimiento" primero
// si quedara declarada después.
vehiculosRouter.get("/alertas-mantenimiento", puedeVer, async (_req: Request, res: Response) => {
  try {
    res.json(await calcularAlertasMantenimiento(prisma));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al calcular las alertas de mantenimiento" });
  }
});

// Acepta "?sucursalId=1,2,3" (un solo valor con comas, lo que manda el
// frontend) o "?sucursalId=1&sucursalId=2" (repetido, por si alguien arma
// la URL a mano) — Express ya entrega un array cuando la misma clave
// aparece más de una vez, así que solo hace falta partir por coma encima
// de eso. Sin ningún sucursalId, no se filtra por agencia (todas).
function leerIdsSucursal(req: Request): number[] {
  const crudo = req.query.sucursalId;
  if (crudo == null) return [];
  const valores = Array.isArray(crudo) ? crudo : [crudo];
  return valores
    .flatMap((v) => String(v).split(","))
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
}

// GET /vehiculos/reporte-combustible?desde=&hasta=&sucursalId=
// Panorama de gasto de combustible de TODA la flota en un rango de fechas
// (a diferencia de "/:id/reporte", que es por un solo vehículo) — pensado
// para la pantalla de resumen de Vehículos: cuánto se gastó, agrupado por
// agencia (sucursal del vehículo) y por técnico. El técnico de cada carga
// puntual se determina igual que en "/:id/reporte": el UsoVehiculo de ese
// mismo vehículo cuyo rango [fechaInicio, fechaFin ?? ahora] cubre la
// fecha de la carga — una carga que no cae dentro de ningún uso registrado
// (ej. flota que todavía no usa "Uso de vehículo" a diario) cae en "Sin
// técnico asignado", nunca se descarta ni rompe el reporte.
// OJO de ubicación: igual que "/alertas-mantenimiento" arriba, tiene que
// ir ANTES de "GET /:id" para que Express no la confunda con un id.
vehiculosRouter.get("/reporte-combustible", puedeVer, async (req: Request, res: Response) => {
  try {
    const rango = leerRangoFechas(req);
    const filtroFecha = rango ?? {};
    const sucursalIds = leerIdsSucursal(req);
    const filtroSucursal: Prisma.VehiculoWhereInput = sucursalIds.length > 0 ? { sucursalId: { in: sucursalIds } } : {};

    const [cargas, cantidadVehiculos] = await Promise.all([
      prisma.cargaCombustible.findMany({
        where: { fecha: filtroFecha, vehiculo: filtroSucursal },
        include: {
          vehiculo: { select: { id: true, placa: true, sucursalId: true, sucursal: { select: { id: true, nombre: true } } } },
        },
        orderBy: { fecha: "desc" },
      }),
      prisma.vehiculo.count({ where: { activo: true, ...filtroSucursal } }),
    ]);

    // Uso diario e historial de cargas: solo de los vehículos que de verdad
    // tuvieron cargas en el período — nunca de la flota completa.
    const vehiculoIds = Array.from(new Set(cargas.map((c) => c.vehiculoId)));
    const [usos, historialCompleto] = await Promise.all([
      vehiculoIds.length > 0
        ? prisma.usoVehiculo.findMany({
            where: { vehiculoId: { in: vehiculoIds } },
            include: { empleado: { select: { id: true, nombres: true, apellidos: true } } },
          })
        : Promise.resolve([]),
      // El historial TIENE que ser el completo del vehículo (sin filtrar por
      // "desde"), no solo el del período elegido: si no, la primera carga
      // que cae dentro del período se vería sin "carga anterior" con qué
      // comparar aunque el vehículo sí tenga cargas más viejas, y el
      // consumo real de esa recarga se perdería por un simple corte de
      // fechas. Mismo criterio que el comentario de CargaCombustible en
      // schema.prisma ("el rendimiento se calcula al vuelo... contra la
      // anterior del mismo vehículo").
      vehiculoIds.length > 0
        ? prisma.cargaCombustible.findMany({
            where: { vehiculoId: { in: vehiculoIds } },
            select: { id: true, vehiculoId: true, fecha: true, kilometraje: true },
            orderBy: { fecha: "asc" },
          })
        : Promise.resolve([]),
    ]);

    // Kilometraje que marcaba la carga INMEDIATAMENTE ANTERIOR de cada
    // carga (mismo vehículo) — la base para calcular cuánto se recorrió con
    // el tanque de esa recarga puntual.
    const kmAnteriorPorCarga = new Map<number, number>();
    const ultimoKmPorVehiculo = new Map<number, number>();
    for (const h of historialCompleto) {
      const anterior = ultimoKmPorVehiculo.get(h.vehiculoId);
      if (anterior != null) kmAnteriorPorCarga.set(h.id, anterior);
      ultimoKmPorVehiculo.set(h.vehiculoId, h.kilometraje);
    }

    // Km recorridos con el tanque de ESTA carga y su rendimiento (km por
    // galón) — null cuando no hay una carga anterior con qué comparar (la
    // primera vez que se carga ese vehículo en todo su historial) o cuando
    // el odómetro no avanzó respecto a la carga anterior (dato mal
    // digitado a mano: nunca se muestra un consumo negativo o infinito).
    function calcularConsumo(c: { id: number; kilometraje: number; galones: Prisma.Decimal }): { kmRecorridos: number | null; rendimiento: string | null } {
      const anterior = kmAnteriorPorCarga.get(c.id);
      if (anterior == null) return { kmRecorridos: null, rendimiento: null };
      const km = c.kilometraje - anterior;
      if (km <= 0) return { kmRecorridos: null, rendimiento: null };
      const galonesNum = Number(c.galones);
      return { kmRecorridos: km, rendimiento: galonesNum > 0 ? (km / galonesNum).toFixed(2) : null };
    }

    let totalGalones = new Prisma.Decimal(0);
    let totalCombustible = new Prisma.Decimal(0);

    type FilaAgencia = { sucursalId: number | null; nombre: string; cantidadCargas: number; totalGalones: Prisma.Decimal; totalCombustible: Prisma.Decimal };
    const porAgencia = new Map<number | "sin-agencia", FilaAgencia>();

    // "kmRecorridos" acá es la suma de los mismos deltas de calcularConsumo
    // (nunca UsoVehiculo.kilometrajeFinal-Inicial, ese es un cálculo
    // distinto que ya cubre "/:id/reporte") — el km real que salió de cada
    // tanque que este técnico cargó, atribuido igual que totalCombustible:
    // según quién tenía el vehículo asignado el día de ESA carga puntual.
    type FilaTecnico = { empleadoId: number | null; nombre: string; cantidadCargas: number; totalGalones: Prisma.Decimal; totalCombustible: Prisma.Decimal; kmRecorridos: number };
    const porTecnico = new Map<number | "sin-tecnico", FilaTecnico>();

    // Mismo agrupado que porTecnico pero por vehículo — pensado para
    // detectar de un vistazo cuál unidad rinde menos (posible falla
    // mecánica, manejo agresivo o hasta robo de combustible), algo que
    // porTecnico no puede mostrar porque mezcla vehículos distintos bajo un
    // mismo técnico.
    type FilaVehiculo = { vehiculoId: number; placa: string; cantidadCargas: number; totalGalones: Prisma.Decimal; totalCombustible: Prisma.Decimal; kmRecorridos: number };
    const porVehiculo = new Map<number, FilaVehiculo>();

    const cargasConConsumo = cargas.map((c) => ({ ...c, consumo: calcularConsumo(c) }));

    for (const c of cargasConConsumo) {
      totalGalones = totalGalones.add(c.galones);
      totalCombustible = totalCombustible.add(c.costoTotal);

      const claveAgencia = c.vehiculo.sucursalId ?? ("sin-agencia" as const);
      const filaAgencia = porAgencia.get(claveAgencia) ?? {
        sucursalId: c.vehiculo.sucursalId,
        nombre: c.vehiculo.sucursal?.nombre ?? "Sin agencia",
        cantidadCargas: 0,
        totalGalones: new Prisma.Decimal(0),
        totalCombustible: new Prisma.Decimal(0),
      };
      filaAgencia.cantidadCargas += 1;
      filaAgencia.totalGalones = filaAgencia.totalGalones.add(c.galones);
      filaAgencia.totalCombustible = filaAgencia.totalCombustible.add(c.costoTotal);
      porAgencia.set(claveAgencia, filaAgencia);

      const uso = usos.find(
        (u) => u.vehiculoId === c.vehiculoId && u.fechaInicio <= c.fecha && (u.fechaFin == null || c.fecha <= u.fechaFin)
      );
      const claveTecnico = uso ? uso.empleadoId : ("sin-tecnico" as const);
      const filaTecnico = porTecnico.get(claveTecnico) ?? {
        empleadoId: uso ? uso.empleadoId : null,
        nombre: uso ? `${uso.empleado.nombres} ${uso.empleado.apellidos}` : "Sin técnico asignado",
        cantidadCargas: 0,
        totalGalones: new Prisma.Decimal(0),
        totalCombustible: new Prisma.Decimal(0),
        kmRecorridos: 0,
      };
      filaTecnico.cantidadCargas += 1;
      filaTecnico.totalGalones = filaTecnico.totalGalones.add(c.galones);
      filaTecnico.totalCombustible = filaTecnico.totalCombustible.add(c.costoTotal);
      if (c.consumo.kmRecorridos != null) filaTecnico.kmRecorridos += c.consumo.kmRecorridos;
      porTecnico.set(claveTecnico, filaTecnico);

      const filaVehiculo = porVehiculo.get(c.vehiculoId) ?? {
        vehiculoId: c.vehiculoId,
        placa: c.vehiculo.placa,
        cantidadCargas: 0,
        totalGalones: new Prisma.Decimal(0),
        totalCombustible: new Prisma.Decimal(0),
        kmRecorridos: 0,
      };
      filaVehiculo.cantidadCargas += 1;
      filaVehiculo.totalGalones = filaVehiculo.totalGalones.add(c.galones);
      filaVehiculo.totalCombustible = filaVehiculo.totalCombustible.add(c.costoTotal);
      if (c.consumo.kmRecorridos != null) filaVehiculo.kmRecorridos += c.consumo.kmRecorridos;
      porVehiculo.set(c.vehiculoId, filaVehiculo);
    }

    res.json({
      rango: { desde: rango?.gte ?? null, hasta: rango?.lte ?? null },
      resumen: {
        cantidadCargas: cargas.length,
        totalGalones: totalGalones.toFixed(2),
        totalCombustible: totalCombustible.toFixed(2),
        cantidadVehiculos,
      },
      porAgencia: Array.from(porAgencia.values())
        .map((a) => ({
          sucursalId: a.sucursalId,
          nombre: a.nombre,
          cantidadCargas: a.cantidadCargas,
          totalGalones: a.totalGalones.toFixed(2),
          totalCombustible: a.totalCombustible.toFixed(2),
        }))
        .sort((a, b) => Number(b.totalCombustible) - Number(a.totalCombustible)),
      porTecnico: Array.from(porTecnico.values())
        .map((t) => ({
          empleadoId: t.empleadoId,
          nombre: t.nombre,
          cantidadCargas: t.cantidadCargas,
          totalGalones: t.totalGalones.toFixed(2),
          totalCombustible: t.totalCombustible.toFixed(2),
          kmRecorridos: t.kmRecorridos,
        }))
        .sort((a, b) => Number(b.totalCombustible) - Number(a.totalCombustible)),
      // Ordenado por rendimiento ASCENDENTE (el que menos km por galón dio
      // primero) — a diferencia de porAgencia/porTecnico, acá lo que
      // interesa de un vistazo es cuál unidad rinde peor, no cuál gastó
      // más (una camioneta rinde menos que un auto por diseño, eso no es
      // una anomalía). Un vehículo sin ningún delta calculable (una sola
      // carga en el período, sin carga anterior en su historial) no tiene
      // rendimiento con qué comparar y se manda al final, nunca se
      // descarta de la lista.
      porVehiculo: Array.from(porVehiculo.values())
        .map((v) => ({
          vehiculoId: v.vehiculoId,
          placa: v.placa,
          cantidadCargas: v.cantidadCargas,
          totalGalones: v.totalGalones.toFixed(2),
          totalCombustible: v.totalCombustible.toFixed(2),
          kmRecorridos: v.kmRecorridos,
          rendimiento: v.kmRecorridos > 0 && Number(v.totalGalones) > 0 ? (v.kmRecorridos / Number(v.totalGalones)).toFixed(2) : null,
        }))
        .sort((a, b) => {
          if (a.rendimiento == null) return 1;
          if (b.rendimiento == null) return -1;
          return Number(a.rendimiento) - Number(b.rendimiento);
        }),
      // Acotado a las últimas 100 para no mandar todo el período de una
      // sola vez — alcanza para la tabla de detalle de la pantalla; el
      // resumen y los agrupados de arriba ya cubren el período completo.
      cargas: cargasConConsumo.slice(0, 100).map((c) => ({
        id: c.id,
        fecha: c.fecha,
        galones: c.galones.toFixed(2),
        costoTotal: c.costoTotal.toFixed(2),
        gasolinera: c.gasolinera,
        vehiculo: { id: c.vehiculo.id, placa: c.vehiculo.placa, sucursal: c.vehiculo.sucursal },
        kmRecorridos: c.consumo.kmRecorridos,
        rendimiento: c.consumo.rendimiento,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el reporte de combustible de la flota" });
  }
});

// GET /vehiculos/:id
vehiculosRouter.get("/:id", puedeVer, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const vehiculo = await prisma.vehiculo.findUnique({ where: { id }, select: SELECT_VEHICULO });
    if (!vehiculo) return res.status(404).json({ error: "Vehículo no encontrado" });
    res.json(vehiculo);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar el vehículo" });
  }
});

// GET /vehiculos/:id/reporte?desde=&hasta=
// Resumen de todo lo que pasó con ESTE vehículo en el rango de fechas dado:
// cargas de combustible, mantenimientos, y los usos diarios (con qué
// técnico tuvo el vehículo cada día y cuántos km recorrió) — pensado para
// que un admin pueda responder "¿qué se hizo con esta camioneta este mes y
// quién la usó?" de un vistazo. Sin desde/hasta, trae TODO el historial
// (ver leerRangoFechas). "tecnicos" agrupa por empleado los usos diarios
// del período — es la lista de "técnicos encargados" que pidió el negocio.
vehiculosRouter.get("/:id/reporte", puedeVer, async (req: Request, res: Response) => {
  try {
    const vehiculoId = Number(req.params.id);
    const vehiculo = await prisma.vehiculo.findUnique({ where: { id: vehiculoId }, select: SELECT_VEHICULO });
    if (!vehiculo) return res.status(404).json({ error: "Vehículo no encontrado" });

    const rango = leerRangoFechas(req);
    const filtroFecha = rango ?? {};

    const [cargas, mantenimientos, usos] = await Promise.all([
      prisma.cargaCombustible.findMany({
        where: { vehiculoId, fecha: filtroFecha },
        include: { usuario: { select: { id: true, nombre: true } } },
        orderBy: { fecha: "asc" },
      }),
      prisma.mantenimientoVehiculo.findMany({
        where: { vehiculoId, fecha: filtroFecha },
        include: { usuario: { select: { id: true, nombre: true } } },
        orderBy: { fecha: "asc" },
      }),
      prisma.usoVehiculo.findMany({
        where: { vehiculoId, fechaInicio: filtroFecha },
        include: { empleado: { select: { id: true, nombres: true, apellidos: true } } },
        orderBy: { fechaInicio: "asc" },
      }),
    ]);

    let totalGalones = new Prisma.Decimal(0);
    let totalCombustible = new Prisma.Decimal(0);
    for (const c of cargas) {
      totalGalones = totalGalones.add(c.galones);
      totalCombustible = totalCombustible.add(c.costoTotal);
    }

    let totalMantenimiento = new Prisma.Decimal(0);
    for (const m of mantenimientos) {
      if (m.costo) totalMantenimiento = totalMantenimiento.add(m.costo);
    }

    // Solo los usos ya CERRADOS aportan km recorridos reales al período —
    // uno todavía EN_USO no tiene kilometrajeFinal con qué calcular la
    // distancia de ESE día.
    let kmRecorridos = 0;
    const porTecnico = new Map<number, { empleadoId: number; nombre: string; diasUso: number; kmRecorridos: number }>();
    for (const u of usos) {
      const distanciaDia = u.kilometrajeFinal != null ? u.kilometrajeFinal - u.kilometrajeInicial : 0;
      kmRecorridos += distanciaDia;

      const nombre = `${u.empleado.nombres} ${u.empleado.apellidos}`;
      const entrada = porTecnico.get(u.empleadoId) ?? { empleadoId: u.empleadoId, nombre, diasUso: 0, kmRecorridos: 0 };
      entrada.diasUso += 1;
      entrada.kmRecorridos += distanciaDia;
      porTecnico.set(u.empleadoId, entrada);
    }
    const tecnicos = Array.from(porTecnico.values()).sort((a, b) => b.diasUso - a.diasUso);

    res.json({
      vehiculo,
      rango: { desde: rango?.gte ?? null, hasta: rango?.lte ?? null },
      resumen: {
        kmRecorridos,
        cantidadCargas: cargas.length,
        totalGalones: totalGalones.toFixed(2),
        totalCombustible: totalCombustible.toFixed(2),
        cantidadMantenimientos: mantenimientos.length,
        totalMantenimiento: totalMantenimiento.toFixed(2),
        diasUso: usos.length,
        cantidadTecnicos: tecnicos.length,
      },
      tecnicos,
      cargasCombustible: cargas,
      mantenimientos,
      usos,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el reporte del vehículo" });
  }
});

interface CrearVehiculoBody {
  placa: string;
  marcaId: number;
  modeloId: number;
  anio?: number;
  color?: string;
  sucursalId?: number;
}

async function validarMarcaModelo(marcaId: number, modeloId: number): Promise<string | null> {
  const modelo = await prisma.modeloVehiculo.findUnique({ where: { id: modeloId } });
  if (!modelo) return "El modelo indicado no existe";
  if (modelo.marcaId !== marcaId) return "Ese modelo no pertenece a la marca elegida";
  return null;
}

// POST /vehiculos
vehiculosRouter.post("/", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { placa, marcaId, modeloId, anio, color, sucursalId } = req.body as CrearVehiculoBody;

    if (!placa || !marcaId || !modeloId) {
      return res.status(400).json({ error: "placa, marcaId y modeloId son obligatorios" });
    }
    const errorValidacion = await validarMarcaModelo(Number(marcaId), Number(modeloId));
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });

    const vehiculo = await prisma.vehiculo.create({
      data: {
        placa: placa.trim().toUpperCase(),
        marcaId: Number(marcaId),
        modeloId: Number(modeloId),
        anio: anio ?? null,
        color: color || null,
        sucursalId: sucursalId ?? null,
      },
      select: SELECT_VEHICULO,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_VEHICULO",
      entidad: "Vehiculo",
      entidadId: vehiculo.id,
      detalle: `${vehiculo.placa} (${vehiculo.marca.nombre} ${vehiculo.modelo.nombre})`,
    });

    res.status(201).json(vehiculo);
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe un vehículo con esa placa" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear el vehículo" });
  }
});

// PUT /vehiculos/:id
// No permite cambiar "placa" — es la clave de negocio del vehículo, igual
// criterio que "cedula" en Empleado.
vehiculosRouter.put("/:id", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { marcaId, modeloId, anio, color, sucursalId } = req.body as Omit<CrearVehiculoBody, "placa">;

    if (!marcaId || !modeloId) {
      return res.status(400).json({ error: "marcaId y modeloId son obligatorios" });
    }
    const errorValidacion = await validarMarcaModelo(Number(marcaId), Number(modeloId));
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });

    const vehiculo = await prisma.vehiculo.update({
      where: { id },
      data: { marcaId: Number(marcaId), modeloId: Number(modeloId), anio: anio ?? null, color: color || null, sucursalId: sucursalId ?? null },
      select: SELECT_VEHICULO,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_VEHICULO",
      entidad: "Vehiculo",
      entidadId: vehiculo.id,
      detalle: `${vehiculo.placa} (${vehiculo.marca.nombre} ${vehiculo.modelo.nombre})`,
    });

    res.json(vehiculo);
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Vehículo no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar el vehículo" });
  }
});

// PATCH /vehiculos/:id/desactivar
// Borrado suave — no elimina el registro (hace falta para el historial de
// usos/cargas/mantenimientos ya registrados), igual criterio que "activo"
// en Producto/Cliente/Empleado. No se puede dar de baja un vehículo con un
// uso EN_USO — hay que cerrarlo primero.
vehiculosRouter.patch("/:id/desactivar", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const enUso = await prisma.usoVehiculo.findFirst({ where: { vehiculoId: id, estado: "EN_USO" } });
    if (enUso) return res.status(409).json({ error: "Este vehículo está en uso ahora mismo — no se puede dar de baja hasta que se cierre" });

    const vehiculo = await prisma.vehiculo.update({ where: { id }, data: { activo: false }, select: SELECT_VEHICULO });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_VEHICULO",
      entidad: "Vehiculo",
      entidadId: vehiculo.id,
      detalle: vehiculo.placa,
    });

    res.json(vehiculo);
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Vehículo no encontrado" });
    console.error(error);
    res.status(500).json({ error: "Error al desactivar el vehículo" });
  }
});

// PATCH /vehiculos/:id/reactivar
vehiculosRouter.patch("/:id/reactivar", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const vehiculo = await prisma.vehiculo.update({ where: { id }, data: { activo: true }, select: SELECT_VEHICULO });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "REACTIVAR_VEHICULO",
      entidad: "Vehiculo",
      entidadId: vehiculo.id,
      detalle: vehiculo.placa,
    });

    res.json(vehiculo);
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Vehículo no encontrado" });
    console.error(error);
    res.status(500).json({ error: "Error al reactivar el vehículo" });
  }
});

// --- Cargas de combustible ---

// multer procesa el archivo con busboy, en callbacks que corren mientras el
// body todavía se está leyendo del socket — bajo carga real ese
// procesamiento puede terminar corriendo FUERA del AsyncLocalStorage de la
// empresa activa (ver ejecutarConEmpresa en db.ts), y empresaActiva()/
// prisma explotarían con "No hay una empresa activa en este contexto" justo
// ahí. Por eso el empresaId se lee ACÁ (un middleware común y corriente,
// sincrónico, todavía dentro del contexto de requireAuth) y el handler
// final vuelve a entrar al contexto él mismo con este valor — mismo
// criterio que capturarEmpresaAntesDeMulter en routes/facturasInternet.ts.
function capturarEmpresaAntesDeMulterVehiculos(req: Request, _res: Response, next: NextFunction) {
  (req as any).empresaIdParaUpload = empresaActivaId();
  (req as any).carpetaUploadsParaUpload = empresaActiva().carpetaUploads;
  next();
}

// --- Subida de la foto del comprobante de pago de una carga de combustible
// (factura/ticket de la gasolinera) — mismo criterio que la captura del
// comprobante de pago de internet (ver routes/facturasInternet.ts): se
// guarda en disco, la base solo guarda la ruta relativa
// (CargaCombustible.comprobanteUrl).
function carpetaComprobantesCombustibleActiva(req: Request): string {
  const carpeta = path.join(rutaAbsoluta((req as any).carpetaUploadsParaUpload), "comprobantes-combustible");
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
  }
  return carpeta;
}

const TIPOS_IMAGEN_PERMITIDOS = ["image/jpeg", "image/png", "image/webp"];
const TAMANO_MAXIMO_IMAGEN = 5 * 1024 * 1024; // 5MB

const almacenamientoComprobanteCombustible = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, carpetaComprobantesCombustibleActiva(req)),
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `carga-combustible-${req.params.id}-${Date.now()}${extension}`);
  },
});

const subirComprobanteCombustible = multer({
  storage: almacenamientoComprobanteCombustible,
  limits: { fileSize: TAMANO_MAXIMO_IMAGEN },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_IMAGEN_PERMITIDOS.includes(file.mimetype)) {
      return cb(new Error("Solo se permiten imágenes JPG, PNG o WEBP"));
    }
    cb(null, true);
  },
});

// multer reporta sus propios errores (tipo/tamaño inválido) llamando a
// next(error) — sin este wrapper, Express los mostraría como una página de
// error genérica en vez de un JSON consistente con el resto de la API. El
// comprobante es OPCIONAL, así que .single() nunca rechaza por "no vino
// archivo" — eso lo valida el handler solo si hace falta (acá nunca hace
// falta: la foto del comprobante siempre es opcional).
function subirComprobanteCombustibleMiddleware(req: Request, res: Response, next: NextFunction) {
  subirComprobanteCombustible.single("comprobante")(req, res, (error: any) => {
    if (error?.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "La imagen no puede pesar más de 5MB" });
    }
    if (error) {
      return res.status(400).json({ error: error.message || "Error al subir el comprobante" });
    }
    next();
  });
}

interface CargaCombustibleBody {
  fecha?: string;
  kilometraje: number;
  tipoCombustible?: string;
  galones: number;
  costoTotal: number;
  gasolinera?: string;
  observaciones?: string;
}

function validarCargaCombustible(body: CargaCombustibleBody): string | null {
  if (body.kilometraje === undefined || Number(body.kilometraje) < 0) return "kilometraje es obligatorio y debe ser mayor o igual a 0";
  if (body.galones === undefined || Number(body.galones) <= 0) return "galones debe ser mayor a 0";
  if (body.costoTotal === undefined || Number(body.costoTotal) <= 0) return "costoTotal debe ser mayor a 0";
  return null;
}

// GET /vehiculos/:id/cargas-combustible
vehiculosRouter.get("/:id/cargas-combustible", puedeVer, async (req: Request, res: Response) => {
  try {
    const vehiculoId = Number(req.params.id);
    const paginacion = leerPaginacion(req);
    const where: Prisma.CargaCombustibleWhereInput = { vehiculoId };
    const opciones = {
      where,
      include: { usuario: { select: { id: true, nombre: true } } },
      orderBy: { fecha: "desc" as const },
    };

    if (!paginacion.aplica) {
      const cargas = await prisma.cargaCombustible.findMany(opciones);
      return res.json(cargas);
    }

    const [cargas, total] = await Promise.all([
      prisma.cargaCombustible.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.cargaCombustible.count({ where }),
    ]);
    res.json(respuestaPaginada(cargas, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las cargas de combustible" });
  }
});

// POST /vehiculos/:id/cargas-combustible — cualquier autenticado (un
// técnico registra su propia carga desde el móvil, mismo criterio que el
// uso diario); no exige "vehiculos"/"vehiculos_editar".
// Body multipart/form-data: kilometraje, galones, costoTotal, fecha?,
// tipoCombustible?, gasolinera?, observaciones?, comprobante? (foto del
// ticket/factura de la gasolinera — el técnico la toma con la cámara del
// celular, ver el <input capture="environment"> en VehiculoMovil.tsx).
vehiculosRouter.post(
  "/:id/cargas-combustible",
  capturarEmpresaAntesDeMulterVehiculos,
  subirComprobanteCombustibleMiddleware,
  async (req: Request, res: Response) => {
    // Vuelve a entrar al contexto de la empresa explícitamente (ver
    // capturarEmpresaAntesDeMulterVehiculos arriba) — no asume que
    // sobrevivió intacto a través del procesamiento del archivo por multer.
    const empresaId = (req as any).empresaIdParaUpload as string;
    try {
      await ejecutarConEmpresa(empresaId, async () => {
        const vehiculoId = Number(req.params.id);
        // multipart/form-data manda todo como texto — a diferencia del resto
        // de rutas JSON de este router, acá hay que convertir a mano.
        const body: CargaCombustibleBody = {
          fecha: req.body.fecha || undefined,
          kilometraje: Number(req.body.kilometraje),
          tipoCombustible: req.body.tipoCombustible || undefined,
          galones: Number(req.body.galones),
          costoTotal: Number(req.body.costoTotal),
          gasolinera: req.body.gasolinera || undefined,
          observaciones: req.body.observaciones || undefined,
        };

        const errorValidacion = validarCargaCombustible(body);
        if (errorValidacion) {
          if (req.file) fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: errorValidacion });
        }

        const vehiculoExiste = await prisma.vehiculo.findUnique({ where: { id: vehiculoId }, select: { id: true, placa: true } });
        if (!vehiculoExiste) {
          if (req.file) fs.unlinkSync(req.file.path);
          return res.status(404).json({ error: "Vehículo no encontrado" });
        }

        const comprobanteUrl = req.file ? `/uploads/${empresaId}/comprobantes-combustible/${req.file.filename}` : null;

        const carga = await prisma.$transaction(async (tx) => {
          const creada = await tx.cargaCombustible.create({
            data: {
              vehiculoId,
              fecha: body.fecha ? new Date(body.fecha) : new Date(),
              kilometraje: Number(body.kilometraje),
              tipoCombustible: body.tipoCombustible || "EXTRA",
              galones: new Prisma.Decimal(body.galones),
              costoTotal: new Prisma.Decimal(body.costoTotal),
              gasolinera: body.gasolinera || null,
              observaciones: body.observaciones || null,
              comprobanteUrl,
              usuarioId: req.usuario!.usuarioId,
            },
            include: { usuario: { select: { id: true, nombre: true } } },
          });
          await recalcularKilometrajeVehiculo(tx, vehiculoId);
          return creada;
        });

        await registrarAuditoria(prisma, {
          usuarioId: req.usuario!.usuarioId,
          accion: "CREAR_CARGA_COMBUSTIBLE",
          entidad: "CargaCombustible",
          entidadId: carga.id,
          detalle: `${vehiculoExiste.placa} — ${carga.galones} gal, $${carga.costoTotal}, km ${carga.kilometraje}`,
        });

        res.status(201).json(carga);
      });
    } catch (error) {
      if (req.file) fs.unlinkSync(req.file.path); // no dejamos el archivo huérfano en disco si la carga no se pudo registrar
      console.error(error);
      res.status(500).json({ error: "Error al registrar la carga de combustible" });
    }
  }
);

// PUT /vehiculos/cargas-combustible/:cargaId
// Corrige una carga ya registrada (ej. error de tipeo en el kilometraje) —
// no cambia el vehículo al que pertenece.
vehiculosRouter.put("/cargas-combustible/:cargaId", puedeEditar, async (req: Request, res: Response) => {
  try {
    const cargaId = Number(req.params.cargaId);
    const body = req.body as CargaCombustibleBody;

    const errorValidacion = validarCargaCombustible(body);
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });

    const existente = await prisma.cargaCombustible.findUnique({ where: { id: cargaId } });
    if (!existente) return res.status(404).json({ error: "Carga de combustible no encontrada" });

    const carga = await prisma.$transaction(async (tx) => {
      const actualizada = await tx.cargaCombustible.update({
        where: { id: cargaId },
        data: {
          fecha: body.fecha ? new Date(body.fecha) : existente.fecha,
          kilometraje: Number(body.kilometraje),
          tipoCombustible: body.tipoCombustible || "EXTRA",
          galones: new Prisma.Decimal(body.galones),
          costoTotal: new Prisma.Decimal(body.costoTotal),
          gasolinera: body.gasolinera || null,
          observaciones: body.observaciones || null,
        },
        include: { usuario: { select: { id: true, nombre: true } } },
      });
      await recalcularKilometrajeVehiculo(tx, existente.vehiculoId);
      return actualizada;
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_CARGA_COMBUSTIBLE",
      entidad: "CargaCombustible",
      entidadId: carga.id,
      detalle: `km ${carga.kilometraje}`,
    });

    res.json(carga);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al editar la carga de combustible" });
  }
});

// DELETE /vehiculos/cargas-combustible/:cargaId
vehiculosRouter.delete("/cargas-combustible/:cargaId", puedeEditar, async (req: Request, res: Response) => {
  try {
    const cargaId = Number(req.params.cargaId);
    const existente = await prisma.cargaCombustible.findUnique({ where: { id: cargaId } });
    if (!existente) return res.status(404).json({ error: "Carga de combustible no encontrada" });

    await prisma.$transaction(async (tx) => {
      await tx.cargaCombustible.delete({ where: { id: cargaId } });
      await recalcularKilometrajeVehiculo(tx, existente.vehiculoId);
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "ELIMINAR_CARGA_COMBUSTIBLE",
      entidad: "CargaCombustible",
      entidadId: cargaId,
      detalle: `km ${existente.kilometraje}`,
    });

    res.status(204).end();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al eliminar la carga de combustible" });
  }
});

// --- Mantenimientos ---

const TIPOS_MANTENIMIENTO = [
  "CAMBIO_ACEITE",
  "CAMBIO_FILTRO_ACEITE",
  "CAMBIO_FILTRO_AIRE",
  "CAMBIO_PASTILLAS_FRENO",
  "CAMBIO_LLANTAS",
  "ALINEACION_BALANCEO",
  "REVISION_GENERAL",
  "OTRO",
] as const;

// --- Subida de la foto del comprobante de un mantenimiento (factura del
// repuesto/taller) — mismo criterio que el comprobante de una carga de
// combustible más arriba, en su propia carpeta. Reusa
// capturarEmpresaAntesDeMulterVehiculos (ya definido arriba para
// combustible, es genérico).
function carpetaComprobantesMantenimientoActiva(req: Request): string {
  const carpeta = path.join(rutaAbsoluta((req as any).carpetaUploadsParaUpload), "comprobantes-mantenimiento");
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
  }
  return carpeta;
}

const almacenamientoComprobanteMantenimiento = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, carpetaComprobantesMantenimientoActiva(req)),
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `mantenimiento-${req.params.id}-${Date.now()}${extension}`);
  },
});

const subirComprobanteMantenimiento = multer({
  storage: almacenamientoComprobanteMantenimiento,
  limits: { fileSize: TAMANO_MAXIMO_IMAGEN },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_IMAGEN_PERMITIDOS.includes(file.mimetype)) {
      return cb(new Error("Solo se permiten imágenes JPG, PNG o WEBP"));
    }
    cb(null, true);
  },
});

function subirComprobanteMantenimientoMiddleware(req: Request, res: Response, next: NextFunction) {
  subirComprobanteMantenimiento.single("comprobante")(req, res, (error: any) => {
    if (error?.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "La imagen no puede pesar más de 5MB" });
    }
    if (error) {
      return res.status(400).json({ error: error.message || "Error al subir el comprobante" });
    }
    next();
  });
}

interface MantenimientoBody {
  tipo: string;
  fecha?: string;
  kilometraje: number;
  costo?: number;
  taller?: string;
  descripcion?: string;
  proximoKilometraje?: number;
  numeroFactura?: string;
}

function validarMantenimiento(body: MantenimientoBody): string | null {
  if (!body.tipo || !TIPOS_MANTENIMIENTO.includes(body.tipo as any)) return "tipo inválido";
  if (body.kilometraje === undefined || Number(body.kilometraje) < 0) return "kilometraje es obligatorio y debe ser mayor o igual a 0";
  if (body.tipo === "OTRO" && !body.descripcion) return "descripcion es obligatoria cuando el tipo es OTRO";
  return null;
}

// ============================================================
// Planes de mantenimiento preventivo — "cada X km toca este tipo, avisar
// cuando falten Y". Ver el comentario del modelo en schema.prisma.
// ============================================================

// GET /vehiculos/:id/planes-mantenimiento
vehiculosRouter.get("/:id/planes-mantenimiento", puedeVer, async (req: Request, res: Response) => {
  try {
    const vehiculoId = Number(req.params.id);
    const planes = await prisma.planMantenimientoVehiculo.findMany({ where: { vehiculoId, activo: true } });
    res.json(planes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los planes de mantenimiento" });
  }
});

interface PlanMantenimientoBody {
  tipo: string;
  intervaloKm: number;
  kmAvisoPrevio?: number;
}

// POST /vehiculos/:id/planes-mantenimiento
// Crea o reemplaza (upsert) la regla vigente para (vehículo, tipo) — no se
// acumulan planes duplicados para el mismo tipo, configurar de nuevo
// simplemente actualiza el intervalo.
vehiculosRouter.post("/:id/planes-mantenimiento", puedeEditar, async (req: Request, res: Response) => {
  try {
    const vehiculoId = Number(req.params.id);
    const { tipo, intervaloKm, kmAvisoPrevio } = req.body as PlanMantenimientoBody;

    if (!tipo || !TIPOS_MANTENIMIENTO.includes(tipo as any)) return res.status(400).json({ error: "tipo inválido" });
    if (!intervaloKm || Number(intervaloKm) <= 0) return res.status(400).json({ error: "intervaloKm debe ser mayor a 0" });
    if (kmAvisoPrevio !== undefined && Number(kmAvisoPrevio) < 0) return res.status(400).json({ error: "kmAvisoPrevio debe ser mayor o igual a 0" });

    const vehiculoExiste = await prisma.vehiculo.findUnique({ where: { id: vehiculoId }, select: { id: true, placa: true } });
    if (!vehiculoExiste) return res.status(404).json({ error: "Vehículo no encontrado" });

    const plan = await prisma.planMantenimientoVehiculo.upsert({
      where: { vehiculoId_tipo: { vehiculoId, tipo: tipo as any } },
      update: { intervaloKm: Number(intervaloKm), kmAvisoPrevio: kmAvisoPrevio !== undefined ? Number(kmAvisoPrevio) : undefined, activo: true },
      create: { vehiculoId, tipo: tipo as any, intervaloKm: Number(intervaloKm), kmAvisoPrevio: kmAvisoPrevio !== undefined ? Number(kmAvisoPrevio) : undefined },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CONFIGURAR_PLAN_MANTENIMIENTO_VEHICULO",
      entidad: "PlanMantenimientoVehiculo",
      entidadId: plan.id,
      detalle: `${vehiculoExiste.placa} — ${plan.tipo} cada ${plan.intervaloKm} km (avisar a ${plan.kmAvisoPrevio} km)`,
    });

    res.status(201).json(plan);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al configurar el plan de mantenimiento" });
  }
});

// DELETE /vehiculos/planes-mantenimiento/:planId — deja de avisar para ese
// tipo (borrado real: es solo una regla, no un historial, no hace falta
// borrado suave como el resto del sistema).
vehiculosRouter.delete("/planes-mantenimiento/:planId", puedeEditar, async (req: Request, res: Response) => {
  try {
    const planId = Number(req.params.planId);
    await prisma.planMantenimientoVehiculo.delete({ where: { id: planId } });
    res.status(204).end();
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Plan no encontrado" });
    console.error(error);
    res.status(500).json({ error: "Error al eliminar el plan de mantenimiento" });
  }
});

// GET /vehiculos/:id/mantenimientos
vehiculosRouter.get("/:id/mantenimientos", puedeVer, async (req: Request, res: Response) => {
  try {
    const vehiculoId = Number(req.params.id);
    const paginacion = leerPaginacion(req);
    const where: Prisma.MantenimientoVehiculoWhereInput = { vehiculoId };
    const opciones = {
      where,
      include: { usuario: { select: { id: true, nombre: true } } },
      orderBy: { fecha: "desc" as const },
    };

    if (!paginacion.aplica) {
      const mantenimientos = await prisma.mantenimientoVehiculo.findMany(opciones);
      return res.json(mantenimientos);
    }

    const [mantenimientos, total] = await Promise.all([
      prisma.mantenimientoVehiculo.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.mantenimientoVehiculo.count({ where }),
    ]);
    res.json(respuestaPaginada(mantenimientos, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los mantenimientos" });
  }
});

// POST /vehiculos/:id/mantenimientos — cualquier autenticado (un técnico
// registra su propio mantenimiento desde el móvil, mismo criterio que la
// carga de combustible); no exige "vehiculos_editar". Editar/eliminar un
// mantenimiento ya registrado sí sigue admin-only (ver PUT/DELETE abajo) —
// es una corrección administrativa, no parte del flujo normal del técnico.
// Body multipart/form-data: tipo, kilometraje, fecha?, costo?, taller?,
// descripcion?, numeroFactura?, proximoKilometraje? (solo se usa si NO hay
// un PlanMantenimientoVehiculo activo para este tipo — si lo hay, el
// backend calcula el próximo solo y lo que venga en el body se ignora),
// comprobante? (foto de la factura/ticket).
vehiculosRouter.post(
  "/:id/mantenimientos",
  capturarEmpresaAntesDeMulterVehiculos,
  subirComprobanteMantenimientoMiddleware,
  async (req: Request, res: Response) => {
    const empresaId = (req as any).empresaIdParaUpload as string;
    try {
      await ejecutarConEmpresa(empresaId, async () => {
        const vehiculoId = Number(req.params.id);
        const body: MantenimientoBody = {
          tipo: req.body.tipo,
          fecha: req.body.fecha || undefined,
          kilometraje: Number(req.body.kilometraje),
          costo: req.body.costo ? Number(req.body.costo) : undefined,
          taller: req.body.taller || undefined,
          descripcion: req.body.descripcion || undefined,
          proximoKilometraje: req.body.proximoKilometraje ? Number(req.body.proximoKilometraje) : undefined,
          numeroFactura: req.body.numeroFactura || undefined,
        };

        const errorValidacion = validarMantenimiento(body);
        if (errorValidacion) {
          if (req.file) fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: errorValidacion });
        }

        const vehiculoExiste = await prisma.vehiculo.findUnique({ where: { id: vehiculoId }, select: { id: true, placa: true } });
        if (!vehiculoExiste) {
          if (req.file) fs.unlinkSync(req.file.path);
          return res.status(404).json({ error: "Vehículo no encontrado" });
        }

        // Si hay un plan vigente para este tipo, el próximo kilometraje se
        // calcula solo (kilometraje de ESTE mantenimiento + intervaloKm) —
        // "empieza de nuevo el conteo" automáticamente, sin que el usuario
        // tenga que volver a escribirlo. Sin plan, sigue siendo manual.
        const plan = await prisma.planMantenimientoVehiculo.findUnique({
          where: { vehiculoId_tipo: { vehiculoId, tipo: body.tipo as any } },
        });
        const proximoKilometraje =
          plan && plan.activo ? Number(body.kilometraje) + plan.intervaloKm : body.proximoKilometraje ?? null;

        const comprobanteUrl = req.file ? `/uploads/${empresaId}/comprobantes-mantenimiento/${req.file.filename}` : null;

        const mantenimiento = await prisma.$transaction(async (tx) => {
          const creado = await tx.mantenimientoVehiculo.create({
            data: {
              vehiculoId,
              tipo: body.tipo as any,
              fecha: body.fecha ? new Date(body.fecha) : new Date(),
              kilometraje: Number(body.kilometraje),
              costo: body.costo !== undefined && body.costo !== null ? new Prisma.Decimal(body.costo) : null,
              taller: body.taller || null,
              descripcion: body.descripcion || null,
              proximoKilometraje,
              numeroFactura: body.numeroFactura || null,
              comprobanteUrl,
              usuarioId: req.usuario!.usuarioId,
            },
            include: { usuario: { select: { id: true, nombre: true } } },
          });
          await recalcularKilometrajeVehiculo(tx, vehiculoId);
          return creado;
        });

        await registrarAuditoria(prisma, {
          usuarioId: req.usuario!.usuarioId,
          accion: "CREAR_MANTENIMIENTO_VEHICULO",
          entidad: "MantenimientoVehiculo",
          entidadId: mantenimiento.id,
          detalle: `${vehiculoExiste.placa} — ${mantenimiento.tipo} (km ${mantenimiento.kilometraje})`,
        });

        res.status(201).json(mantenimiento);
      });
    } catch (error) {
      if (req.file) fs.unlinkSync(req.file.path);
      console.error(error);
      res.status(500).json({ error: "Error al registrar el mantenimiento" });
    }
  }
);

// PUT /vehiculos/mantenimientos/:mantenimientoId
vehiculosRouter.put("/mantenimientos/:mantenimientoId", puedeEditar, async (req: Request, res: Response) => {
  try {
    const mantenimientoId = Number(req.params.mantenimientoId);
    const body = req.body as MantenimientoBody;

    const errorValidacion = validarMantenimiento(body);
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });

    const existente = await prisma.mantenimientoVehiculo.findUnique({ where: { id: mantenimientoId } });
    if (!existente) return res.status(404).json({ error: "Mantenimiento no encontrado" });

    const mantenimiento = await prisma.$transaction(async (tx) => {
      const actualizado = await tx.mantenimientoVehiculo.update({
        where: { id: mantenimientoId },
        data: {
          tipo: body.tipo as any,
          fecha: body.fecha ? new Date(body.fecha) : existente.fecha,
          kilometraje: Number(body.kilometraje),
          costo: body.costo !== undefined && body.costo !== null ? new Prisma.Decimal(body.costo) : null,
          taller: body.taller || null,
          descripcion: body.descripcion || null,
          proximoKilometraje: body.proximoKilometraje ?? null,
          numeroFactura: body.numeroFactura || null,
        },
        include: { usuario: { select: { id: true, nombre: true } } },
      });
      await recalcularKilometrajeVehiculo(tx, existente.vehiculoId);
      return actualizado;
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_MANTENIMIENTO_VEHICULO",
      entidad: "MantenimientoVehiculo",
      entidadId: mantenimiento.id,
      detalle: `${mantenimiento.tipo} (km ${mantenimiento.kilometraje})`,
    });

    res.json(mantenimiento);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al editar el mantenimiento" });
  }
});

// DELETE /vehiculos/mantenimientos/:mantenimientoId
vehiculosRouter.delete("/mantenimientos/:mantenimientoId", puedeEditar, async (req: Request, res: Response) => {
  try {
    const mantenimientoId = Number(req.params.mantenimientoId);
    const existente = await prisma.mantenimientoVehiculo.findUnique({ where: { id: mantenimientoId } });
    if (!existente) return res.status(404).json({ error: "Mantenimiento no encontrado" });

    await prisma.$transaction(async (tx) => {
      await tx.mantenimientoVehiculo.delete({ where: { id: mantenimientoId } });
      await recalcularKilometrajeVehiculo(tx, existente.vehiculoId);
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "ELIMINAR_MANTENIMIENTO_VEHICULO",
      entidad: "MantenimientoVehiculo",
      entidadId: mantenimientoId,
      detalle: `${existente.tipo} (km ${existente.kilometraje})`,
    });

    res.status(204).end();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al eliminar el mantenimiento" });
  }
});
