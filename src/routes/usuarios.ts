import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { hashPassword } from "../utils/auth";
import { generarPasswordTemporal } from "../utils/passwordTemporal";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerTextoBusqueda } from "../utils/busqueda";
import { registrarAuditoria } from "../utils/auditoria";
import { CLAVES_VALIDAS } from "../utils/permisos";
import { leerRangoFechas } from "../utils/rangoFechas";
import { emailValido } from "../utils/validarEmail";

export const usuariosRouter = Router();

const SELECT_USUARIO = {
  id: true,
  nombre: true,
  usuario: true,
  email: true,
  rol: true,
  permisos: true,
  activo: true,
  createdAt: true,
  sucursalId: true,
  sucursal: { select: { id: true, nombre: true } },
  // Vínculo opcional con Empleado (ver módulo de Visitas Técnicas) — para
  // saber "qué empleado es esta persona" y mostrarle solo su propia ruta
  // del día. La mayoría de usuarios no lo tienen (cajeros/admins que no
  // hacen visitas técnicas).
  empleadoId: true,
  empleado: { select: { id: true, nombres: true, apellidos: true } },
  debeCambiarPassword: true,
} as const;

function permisosInvalidos(permisos: unknown): string | null {
  if (permisos === undefined) return null;
  if (!Array.isArray(permisos) || !permisos.every((p) => typeof p === "string")) {
    return "permisos debe ser un arreglo de strings";
  }
  const desconocidos = permisos.filter((p) => !CLAVES_VALIDAS.includes(p));
  if (desconocidos.length > 0) return `permisos desconocidos: ${desconocidos.join(", ")}`;
  return null;
}

// Todo usuario activo necesita una sucursal fija — incluido ADMIN (con solo
// 2 usuarios y 2 locales no vale la pena un caso especial "el admin flota").
async function sucursalInvalida(sucursalId: unknown): Promise<string | null> {
  if (typeof sucursalId !== "number") return "sucursalId es obligatorio";
  const sucursal = await prisma.sucursal.findUnique({ where: { id: sucursalId } });
  if (!sucursal || !sucursal.activa) return "La sucursal indicada no existe o está inactiva";
  return null;
}

// A diferencia de sucursalId, empleadoId es opcional — solo se valida si
// viene. "usuarioIdActual" excluye al propio usuario del chequeo de
// "ya vinculado a otro" al editar (si no, un usuario no podría guardarse a
// sí mismo sin cambios).
async function empleadoInvalido(empleadoId: unknown, usuarioIdActual?: number): Promise<string | null> {
  if (empleadoId == null) return null;
  if (typeof empleadoId !== "number") return "empleadoId debe ser un número";
  const empleado = await prisma.empleado.findUnique({ where: { id: empleadoId }, include: { usuario: true } });
  if (!empleado || !empleado.activo) return "El empleado indicado no existe o está inactivo";
  if (empleado.usuario && empleado.usuario.id !== usuarioIdActual) {
    return `${empleado.nombres} ${empleado.apellidos} ya está vinculado a otro usuario`;
  }
  return null;
}

// GET /usuarios
// Lista todos los usuarios (sin exponer nunca el passwordHash en la respuesta).
// "?q=" busca por nombre o nombre de usuario, sin importar mayúsculas/minúsculas.
usuariosRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const busqueda = leerTextoBusqueda(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.UsuarioWhereInput = {
      ...(busqueda && {
        OR: [
          { nombre: { contains: busqueda, mode: "insensitive" } },
          { usuario: { contains: busqueda, mode: "insensitive" } },
        ],
      }),
      ...(rango && { createdAt: rango }),
    };

    if (!paginacion.aplica) {
      const usuarios = await prisma.usuario.findMany({ where, select: SELECT_USUARIO, orderBy: { nombre: "asc" } });
      return res.json(usuarios);
    }

    const [usuarios, total] = await Promise.all([
      prisma.usuario.findMany({
        where,
        select: SELECT_USUARIO,
        orderBy: { nombre: "asc" },
        skip: paginacion.skip,
        take: paginacion.take,
      }),
      prisma.usuario.count({ where }),
    ]);
    res.json(respuestaPaginada(usuarios, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar usuarios" });
  }
});

// POST /usuarios
// Body: { nombre, usuario, password, rol }
// Solo un ADMIN puede llegar aquí (el middleware requireAdmin ya lo garantiza
// antes de que esta función se ejecute).
usuariosRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { nombre, usuario, password, email, rol, permisos, sucursalId, empleadoId } = req.body;

    if (!nombre || !usuario || !password) {
      return res.status(400).json({ error: "nombre, usuario y password son obligatorios" });
    }
    if (email && !emailValido(email)) {
      return res.status(400).json({ error: "El correo no tiene un formato válido" });
    }
    if (rol && rol !== "ADMIN" && rol !== "CAJERO") {
      return res.status(400).json({ error: 'rol debe ser "ADMIN" o "CAJERO"' });
    }
    const errorPermisos = permisosInvalidos(permisos);
    if (errorPermisos) return res.status(400).json({ error: errorPermisos });
    const errorSucursal = await sucursalInvalida(sucursalId);
    if (errorSucursal) return res.status(400).json({ error: errorSucursal });
    const errorEmpleado = await empleadoInvalido(empleadoId);
    if (errorEmpleado) return res.status(400).json({ error: errorEmpleado });

    const passwordHash = await hashPassword(password);

    const nuevoUsuario = await prisma.usuario.create({
      data: { nombre, usuario, passwordHash, email: email || null, rol: rol ?? "CAJERO", permisos: permisos ?? [], sucursalId, empleadoId: empleadoId ?? null },
      select: { id: true, nombre: true, usuario: true, email: true, rol: true, permisos: true, activo: true, sucursalId: true, empleadoId: true },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_USUARIO",
      entidad: "Usuario",
      entidadId: nuevoUsuario.id,
      detalle: `${nuevoUsuario.nombre} (${nuevoUsuario.usuario}, rol ${nuevoUsuario.rol}, permisos: ${nuevoUsuario.permisos.join(", ") || "ninguno"})`,
    });

    res.status(201).json(nuevoUsuario);
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe un usuario con ese nombre de usuario" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear el usuario" });
  }
});

// PUT /usuarios/:id
// Edita nombre, rol y permisos de un usuario existente. El cambio de
// contraseña no está incluido acá — para eso existe
// PATCH /:id/resetear-password (abajo) y, para el propio usuario,
// POST /auth/cambiar-password.
usuariosRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre, email, rol, permisos, sucursalId, empleadoId } = req.body;

    if (!nombre) return res.status(400).json({ error: "nombre es obligatorio" });
    if (email && !emailValido(email)) {
      return res.status(400).json({ error: "El correo no tiene un formato válido" });
    }
    if (rol !== "ADMIN" && rol !== "CAJERO") {
      return res.status(400).json({ error: 'rol debe ser "ADMIN" o "CAJERO"' });
    }
    const errorPermisos = permisosInvalidos(permisos);
    if (errorPermisos) return res.status(400).json({ error: errorPermisos });
    const errorSucursal = await sucursalInvalida(sucursalId);
    if (errorSucursal) return res.status(400).json({ error: errorSucursal });
    const errorEmpleado = await empleadoInvalido(empleadoId, id);
    if (errorEmpleado) return res.status(400).json({ error: errorEmpleado });

    // Evita que un admin se quite su propio rol de administrador por
    // accidente y se quede sin poder gestionar usuarios (mismo espíritu que
    // el bloqueo de auto-desactivación de abajo). No cubre el caso de que
    // OTRO admin degrade al último administrador restante — tampoco existe
    // esa protección hoy para la auto-desactivación, así que es un nivel de
    // rigor consistente con el resto del archivo, no un hueco nuevo.
    if (req.usuario?.usuarioId === id && rol !== "ADMIN") {
      return res.status(400).json({ error: "No puedes quitarte tu propio rol de administrador" });
    }

    const usuarioEditado = await prisma.usuario.update({
      where: { id },
      data: { nombre, email: email || null, rol, permisos: permisos ?? [], sucursalId, empleadoId: empleadoId ?? null },
      select: { id: true, nombre: true, usuario: true, email: true, rol: true, permisos: true, activo: true, sucursalId: true, empleadoId: true },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_USUARIO",
      entidad: "Usuario",
      entidadId: usuarioEditado.id,
      detalle: `${usuarioEditado.nombre} (${usuarioEditado.usuario}, rol ${usuarioEditado.rol}, permisos: ${usuarioEditado.permisos.join(", ") || "ninguno"})`,
    });

    res.json(usuarioEditado);
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar el usuario" });
  }
});

// PATCH /usuarios/:id/resetear-password
// Genera una contraseña temporal, la guarda ya hasheada, y marca
// debeCambiarPassword para que el frontend obligue a cambiarla en el
// próximo inicio de sesión — nunca se guarda ni se loguea en texto plano;
// esta respuesta es la ÚNICA vez que sale del servidor, para que el admin
// se la pase al usuario.
usuariosRouter.patch("/:id/resetear-password", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const passwordTemporal = generarPasswordTemporal();
    const passwordHash = await hashPassword(passwordTemporal);

    const usuario = await prisma.usuario.update({
      where: { id },
      data: { passwordHash, debeCambiarPassword: true, intentosFallidos: 0, bloqueadoHasta: null },
      select: { id: true, nombre: true, usuario: true },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "RESETEAR_PASSWORD",
      entidad: "Usuario",
      entidadId: usuario.id,
      detalle: `${usuario.nombre} (${usuario.usuario})`,
    });

    res.json({ passwordTemporal });
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al resetear la contraseña" });
  }
});

// PATCH /usuarios/:id/desactivar
// Borrado suave: el usuario deja de poder iniciar sesión, pero su historial
// (qué facturas creó, etc.) no se pierde.
usuariosRouter.patch("/:id/desactivar", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    // Evitamos que un admin se desactive a sí mismo por accidente y se quede
    // sin poder volver a entrar al sistema.
    if (req.usuario?.usuarioId === id) {
      return res.status(400).json({ error: "No puedes desactivar tu propio usuario" });
    }

    const usuario = await prisma.usuario.update({
      where: { id },
      data: { activo: false },
      select: { id: true, nombre: true, usuario: true, rol: true, activo: true },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_USUARIO",
      entidad: "Usuario",
      entidadId: usuario.id,
      detalle: `${usuario.nombre} (${usuario.usuario})`,
    });

    res.json(usuario);
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al desactivar el usuario" });
  }
});
