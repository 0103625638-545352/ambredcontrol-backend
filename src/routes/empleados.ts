// Catálogo de empleados — base del módulo de Nómina (rol de pagos,
// décimos, vacaciones, utilidades, liquidación dependen de este). Mismo
// patrón CRUD que routes/clientes.ts.
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { validarCedula } from "../utils/validarIdentificacion";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerTextoBusqueda } from "../utils/busqueda";
import { registrarAuditoria } from "../utils/auditoria";
import { fechaLocalDeString } from "../utils/rangoFechas";
import { requirePermiso } from "../middleware/auth";
import { hashPassword } from "../utils/auth";

export const empleadosRouter = Router();

const puedeVer = requirePermiso("nomina");
const puedeEditar = requirePermiso("nomina_editar");

const PIN_REGEX = /^\d{4,6}$/;

// "pinHash" nunca debe salir en una respuesta HTTP (mismo criterio que
// Usuario.passwordHash en routes/usuarios.ts) — se selecciona internamente
// solo para poder derivar "tienePin" y se descarta antes de responder.
const SELECT_EMPLEADO = {
  id: true,
  cedula: true,
  nombres: true,
  apellidos: true,
  cargo: true,
  fechaIngreso: true,
  fechaSalida: true,
  sueldoMensual: true,
  sucursalId: true,
  sucursal: true,
  cargasFamiliares: true,
  fondoReservaMensualizado: true,
  horaEntradaEsperada: true,
  horaSalidaEsperada: true,
  activo: true,
  createdAt: true,
  pinHash: true,
  // Para que el frontend sepa si este Empleado ya tiene una cuenta de
  // Usuario vinculada (ver módulo de Visitas Técnicas) y muestre "Crear
  // cuenta de acceso" solo cuando falta — select acotado, NUNCA "usuario:
  // true" a secas, porque eso filtraría passwordHash (mismo criterio que
  // pinHash arriba).
  usuario: { select: { id: true, usuario: true } },
} as const;

function serializarEmpleado<T extends { pinHash: string | null }>(empleado: T) {
  const { pinHash, ...resto } = empleado;
  return { ...resto, tienePin: pinHash !== null };
}

// GET /empleados
// Sin "?page=" trae TODOS (lo necesitan los selectores de empleado en
// Nómina). Con "?page=" pagina (la tabla de Empleados). "?q=" busca por
// cédula, nombres o apellidos.
empleadosRouter.get("/", puedeVer, async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const busqueda = leerTextoBusqueda(req);
    const where: Prisma.EmpleadoWhereInput = {
      ...(busqueda && {
        OR: [
          { cedula: { contains: busqueda, mode: "insensitive" } },
          { nombres: { contains: busqueda, mode: "insensitive" } },
          { apellidos: { contains: busqueda, mode: "insensitive" } },
        ],
      }),
    };
    const opciones = { where, select: SELECT_EMPLEADO, orderBy: { apellidos: "asc" as const } };

    if (!paginacion.aplica) {
      const empleados = await prisma.empleado.findMany(opciones);
      return res.json(empleados.map(serializarEmpleado));
    }

    const [empleados, total] = await Promise.all([
      prisma.empleado.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.empleado.count({ where }),
    ]);
    const respuesta = respuestaPaginada(empleados, total, paginacion);
    res.json({ ...respuesta, datos: respuesta.datos.map(serializarEmpleado) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar empleados" });
  }
});

// GET /empleados/:id
empleadosRouter.get("/:id", puedeVer, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const empleado = await prisma.empleado.findUnique({ where: { id }, select: SELECT_EMPLEADO });
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });
    res.json(serializarEmpleado(empleado));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar el empleado" });
  }
});

interface CrearEmpleadoBody {
  cedula: string;
  nombres: string;
  apellidos: string;
  cargo: string;
  fechaIngreso: string;
  sueldoMensual: number;
  sucursalId?: number;
  cargasFamiliares?: number;
  fondoReservaMensualizado?: boolean;
  horaEntradaEsperada?: string;
  horaSalidaEsperada?: string;
}

// POST /empleados
empleadosRouter.post("/", puedeEditar, async (req: Request, res: Response) => {
  try {
    const {
      cedula,
      nombres,
      apellidos,
      cargo,
      fechaIngreso,
      sueldoMensual,
      sucursalId,
      cargasFamiliares,
      fondoReservaMensualizado,
      horaEntradaEsperada,
      horaSalidaEsperada,
    } = req.body as CrearEmpleadoBody;

    if (!cedula || !nombres || !apellidos || !cargo || !fechaIngreso || sueldoMensual === undefined) {
      return res.status(400).json({ error: "cedula, nombres, apellidos, cargo, fechaIngreso y sueldoMensual son obligatorios" });
    }

    const validacion = validarCedula(cedula);
    if (!validacion.valido) {
      return res.status(400).json({ error: validacion.mensaje });
    }
    if (Number(sueldoMensual) <= 0) {
      return res.status(400).json({ error: "El sueldo mensual debe ser mayor a 0" });
    }

    const empleado = await prisma.empleado.create({
      data: {
        cedula,
        nombres,
        apellidos,
        cargo,
        fechaIngreso: fechaLocalDeString(fechaIngreso, false),
        sueldoMensual: new Prisma.Decimal(sueldoMensual),
        sucursalId: sucursalId ?? null,
        cargasFamiliares: cargasFamiliares ?? 0,
        fondoReservaMensualizado: fondoReservaMensualizado === true,
        horaEntradaEsperada: horaEntradaEsperada || null,
        horaSalidaEsperada: horaSalidaEsperada || null,
      },
      select: SELECT_EMPLEADO,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_EMPLEADO",
      entidad: "Empleado",
      entidadId: empleado.id,
      detalle: `${empleado.nombres} ${empleado.apellidos} (${empleado.cedula})`,
    });

    res.status(201).json(serializarEmpleado(empleado));
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe un empleado con esa cédula" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear el empleado" });
  }
});

// PUT /empleados/:id
// No permite cambiar "cedula" — es la clave de negocio del empleado, igual
// criterio que "identificacion" en Cliente.
empleadosRouter.put("/:id", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombres, apellidos, cargo, sueldoMensual, sucursalId, cargasFamiliares, fondoReservaMensualizado, horaEntradaEsperada, horaSalidaEsperada } =
      req.body;

    if (!nombres || !apellidos || !cargo || sueldoMensual === undefined) {
      return res.status(400).json({ error: "nombres, apellidos, cargo y sueldoMensual son obligatorios" });
    }
    if (Number(sueldoMensual) <= 0) {
      return res.status(400).json({ error: "El sueldo mensual debe ser mayor a 0" });
    }

    const empleado = await prisma.empleado.update({
      where: { id },
      data: {
        nombres,
        apellidos,
        cargo,
        sueldoMensual: new Prisma.Decimal(sueldoMensual),
        sucursalId: sucursalId ?? null,
        cargasFamiliares: cargasFamiliares ?? 0,
        fondoReservaMensualizado: fondoReservaMensualizado === true,
        horaEntradaEsperada: horaEntradaEsperada || null,
        horaSalidaEsperada: horaSalidaEsperada || null,
      },
      select: SELECT_EMPLEADO,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_EMPLEADO",
      entidad: "Empleado",
      entidadId: empleado.id,
      detalle: `${empleado.nombres} ${empleado.apellidos} (${empleado.cedula})`,
    });

    res.json(serializarEmpleado(empleado));
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Empleado no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar el empleado" });
  }
});

// PATCH /empleados/:id/desactivar
// No borra el registro (hace falta para el historial de rol de pagos/
// décimos ya generados) — igual criterio que "activo" en Producto/Cliente.
// Opcionalmente registra fechaSalida, insumo para Liquidación.
empleadosRouter.patch("/:id/desactivar", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { fechaSalida } = req.body as { fechaSalida?: string };

    const empleado = await prisma.empleado.update({
      where: { id },
      data: { activo: false, fechaSalida: fechaSalida ? fechaLocalDeString(fechaSalida, false) : new Date() },
      select: SELECT_EMPLEADO,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_EMPLEADO",
      entidad: "Empleado",
      entidadId: empleado.id,
      detalle: `${empleado.nombres} ${empleado.apellidos} (${empleado.cedula})`,
    });

    res.json(serializarEmpleado(empleado));
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Empleado no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al desactivar el empleado" });
  }
});

// PATCH /empleados/:id/pin
// Asigna o reemplaza el PIN de marcación de un empleado (ver
// routes/marcaciones.ts) — solo un admin/nomina_editar puede hacerlo, el
// empleado no tiene forma de cambiarlo por su cuenta esta ronda. Reinicia
// también el candado de intentos fallidos, igual criterio que resetear la
// contraseña de un Usuario en routes/usuarios.ts.
empleadosRouter.patch("/:id/pin", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { pin } = req.body as { pin?: string };

    if (!pin || !PIN_REGEX.test(pin)) {
      return res.status(400).json({ error: "El PIN debe tener entre 4 y 6 dígitos numéricos" });
    }

    const pinHash = await hashPassword(pin);
    const empleado = await prisma.empleado.update({
      where: { id },
      data: { pinHash, intentosFallidosPin: 0, bloqueadoHastaPin: null },
      select: SELECT_EMPLEADO,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CONFIGURAR_PIN_EMPLEADO",
      entidad: "Empleado",
      entidadId: empleado.id,
      detalle: `${empleado.nombres} ${empleado.apellidos} (${empleado.cedula})`,
    });

    res.json(serializarEmpleado(empleado));
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Empleado no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al configurar el PIN" });
  }
});
