import { Router, Request, Response } from "express";
import { compararPassword, generarToken, hashPassword } from "../utils/auth";
import { requireAuth } from "../middleware/auth";
import { obtenerPrismaDeEmpresa, prisma } from "../db";
import { listarEmpresasPublico, obtenerEmpresa } from "../utils/empresas";
import { provisionarEmpresa } from "../utils/provisionarEmpresa";
import { eliminarEmpresa } from "../utils/eliminarEmpresa";
import { generarCodigoRecuperacion } from "../utils/codigoRecuperacion";
import { enviarCorreoTextoPlano } from "../utils/email";

export const authRouter = Router();

// Bloqueo por intentos fallidos: tras MAX_INTENTOS_FALLIDOS seguidos, el
// usuario queda bloqueado MINUTOS_BLOQUEO minutos — corta ataques de fuerza
// bruta sin necesitar nada más (ni un servicio externo ni un límite por IP).
const MAX_INTENTOS_FALLIDOS = 5;
const MINUTOS_BLOQUEO = 15;

// Recuperación de contraseña por código de correo — candado DEDICADO,
// separado del de arriba (ver comentario en Usuario.codigoRecuperacionHash
// del schema).
const MINUTOS_EXPIRACION_CODIGO = 15;
const MAX_INTENTOS_CODIGO = 5;

// GET /auth/empresas
// Público (nadie tiene token todavía al entrar al login) — solo expone
// id + nombre, nunca la conexión a la base de datos ni datos del RUC.
authRouter.get("/empresas", (_req: Request, res: Response) => {
  res.json(listarEmpresasPublico());
});

// POST /auth/login
// Body: { empresaId, usuario, password }
// Cada empresa tiene su PROPIA base de datos (con su propia tabla Usuario),
// así que hay que saber a cuál conectarse ANTES de poder validar la
// contraseña — por eso "empresaId" es obligatorio, no algo que se infiera
// del usuario/contraseña.
authRouter.post("/login", async (req: Request, res: Response) => {
  try {
    const { empresaId, usuario, password } = req.body;

    if (!empresaId || !usuario || !password) {
      return res.status(400).json({ error: "empresaId, usuario y password son obligatorios" });
    }

    const empresa = obtenerEmpresa(empresaId);
    if (!empresa) {
      return res.status(400).json({ error: "La empresa seleccionada no existe" });
    }

    const prismaEmpresa = obtenerPrismaDeEmpresa(empresaId);
    const usuarioEncontrado = await prismaEmpresa.usuario.findUnique({
      where: { usuario },
      include: { sucursal: { select: { id: true, nombre: true } } },
    });

    // Por seguridad, damos el MISMO mensaje de error tanto si el usuario no existe
    // como si la contraseña es incorrecta. Así no le confirmamos a un atacante
    // si el nombre de usuario existe o no.
    if (!usuarioEncontrado || !usuarioEncontrado.activo) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    }

    if (usuarioEncontrado.bloqueadoHasta && usuarioEncontrado.bloqueadoHasta > new Date()) {
      const minutosRestantes = Math.ceil((usuarioEncontrado.bloqueadoHasta.getTime() - Date.now()) / 60_000);
      return res.status(429).json({ error: `Demasiados intentos fallidos. Intenta de nuevo en ${minutosRestantes} minuto(s).` });
    }

    const passwordValida = await compararPassword(password, usuarioEncontrado.passwordHash);
    if (!passwordValida) {
      const nuevosIntentos = usuarioEncontrado.intentosFallidos + 1;
      const seBloqueaAhora = nuevosIntentos >= MAX_INTENTOS_FALLIDOS;
      await prismaEmpresa.usuario.update({
        where: { id: usuarioEncontrado.id },
        data: seBloqueaAhora
          ? { intentosFallidos: 0, bloqueadoHasta: new Date(Date.now() + MINUTOS_BLOQUEO * 60_000) }
          : { intentosFallidos: nuevosIntentos },
      });
      if (seBloqueaAhora) {
        return res.status(429).json({ error: `Demasiados intentos fallidos. Intenta de nuevo en ${MINUTOS_BLOQUEO} minutos.` });
      }
      return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    }

    // Login correcto: si venía con intentos fallidos acumulados (sin llegar
    // a bloquearse), se limpian — cada intento exitoso "perdona" los anteriores.
    if (usuarioEncontrado.intentosFallidos > 0) {
      await prismaEmpresa.usuario.update({ where: { id: usuarioEncontrado.id }, data: { intentosFallidos: 0 } });
    }

    const token = generarToken({
      usuarioId: usuarioEncontrado.id,
      usuario: usuarioEncontrado.usuario,
      rol: usuarioEncontrado.rol,
      empresaId: empresa.id,
    });

    res.json({
      token,
      usuario: {
        id: usuarioEncontrado.id,
        nombre: usuarioEncontrado.nombre,
        usuario: usuarioEncontrado.usuario,
        rol: usuarioEncontrado.rol,
        permisos: usuarioEncontrado.permisos,
        sucursalId: usuarioEncontrado.sucursal?.id ?? null,
        sucursalNombre: usuarioEncontrado.sucursal?.nombre ?? null,
        empleadoId: usuarioEncontrado.empleadoId,
        debeCambiarPassword: usuarioEncontrado.debeCambiarPassword,
      },
      empresa: { id: empresa.id, nombre: empresa.nombre },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

// POST /auth/recuperar-password/solicitar
// Body: { empresaId, usuario }
// Público (nadie tiene sesión todavía si olvidó su contraseña) — mismo
// truco que /auth/login para resolver a qué base conectarse ANTES de tocar
// cualquier Usuario. Busca por "usuario" (no por email): quien pide esto ya
// sabe su propio usuario, igual que al iniciar sesión, y así este endpoint
// nunca sirve para adivinar qué correos existen en el sistema.
authRouter.post("/recuperar-password/solicitar", async (req: Request, res: Response) => {
  try {
    const { empresaId, usuario } = req.body;
    if (!empresaId || !usuario) {
      return res.status(400).json({ error: "empresaId y usuario son obligatorios" });
    }

    const empresa = obtenerEmpresa(empresaId);
    if (!empresa) {
      return res.status(400).json({ error: "La empresa seleccionada no existe" });
    }

    // Misma respuesta SIEMPRE, sin importar si el usuario no existe, está
    // inactivo, o no tiene correo registrado — igual espíritu anti-
    // enumeración que /auth/login (mensaje genérico ante credenciales
    // incorrectas). Nunca se revela cuál de los casos ocurrió.
    const mensajeGenerico = { mensaje: "Si el usuario existe y tiene un correo registrado, se envió un código a ese correo." };

    const prismaEmpresa = obtenerPrismaDeEmpresa(empresaId);
    const usuarioEncontrado = await prismaEmpresa.usuario.findUnique({ where: { usuario } });

    if (!usuarioEncontrado || !usuarioEncontrado.activo || !usuarioEncontrado.email) {
      return res.json(mensajeGenerico);
    }

    const codigo = generarCodigoRecuperacion();
    const codigoRecuperacionHash = await hashPassword(codigo);

    await prismaEmpresa.usuario.update({
      where: { id: usuarioEncontrado.id },
      data: {
        codigoRecuperacionHash,
        codigoRecuperacionExpira: new Date(Date.now() + MINUTOS_EXPIRACION_CODIGO * 60_000),
        codigoRecuperacionIntentos: 0,
      },
    });

    // "Mejor esfuerzo" a propósito (ver utils/email.ts) — no se examina el
    // resultado: el código ya quedó guardado, y aunque el envío falle la
    // respuesta sigue siendo la misma genérica de arriba.
    await enviarCorreoTextoPlano({
      destinatario: usuarioEncontrado.email,
      asunto: `Código de recuperación — ${empresa.nombre}`,
      textoPlano:
        `Hola ${usuarioEncontrado.nombre},\n\n` +
        `Tu código para recuperar tu contraseña es: ${codigo}\n\n` +
        `Vence en ${MINUTOS_EXPIRACION_CODIGO} minutos. Si no lo solicitaste, ignora este correo.`,
    });

    res.json(mensajeGenerico);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al solicitar la recuperación" });
  }
});

// POST /auth/recuperar-password/confirmar
// Body: { empresaId, usuario, codigo, passwordNueva }
// A diferencia del paso "solicitar", acá SÍ se distinguen los errores
// (código incorrecto / vencido / agotado): quien llama ya tiene un código
// real en su correo, no es alguien enumerando usuarios.
authRouter.post("/recuperar-password/confirmar", async (req: Request, res: Response) => {
  try {
    const { empresaId, usuario, codigo, passwordNueva } = req.body;
    if (!empresaId || !usuario || !codigo || !passwordNueva) {
      return res.status(400).json({ error: "empresaId, usuario, codigo y passwordNueva son obligatorios" });
    }
    if (passwordNueva.length < 8) {
      return res.status(400).json({ error: "La contraseña nueva debe tener al menos 8 caracteres" });
    }

    const empresa = obtenerEmpresa(empresaId);
    if (!empresa) {
      return res.status(400).json({ error: "La empresa seleccionada no existe" });
    }

    const prismaEmpresa = obtenerPrismaDeEmpresa(empresaId);
    const usuarioEncontrado = await prismaEmpresa.usuario.findUnique({ where: { usuario } });

    if (!usuarioEncontrado || !usuarioEncontrado.activo || !usuarioEncontrado.codigoRecuperacionHash) {
      return res.status(400).json({ error: "Código inválido o vencido. Solicita uno nuevo." });
    }
    if (!usuarioEncontrado.codigoRecuperacionExpira || usuarioEncontrado.codigoRecuperacionExpira < new Date()) {
      throw new Error("CODIGO_VENCIDO");
    }
    if (usuarioEncontrado.codigoRecuperacionIntentos >= MAX_INTENTOS_CODIGO) {
      throw new Error("CODIGO_AGOTADO");
    }

    const codigoValido = await compararPassword(String(codigo), usuarioEncontrado.codigoRecuperacionHash);
    if (!codigoValido) {
      const nuevosIntentos = usuarioEncontrado.codigoRecuperacionIntentos + 1;
      const seAgotaAhora = nuevosIntentos >= MAX_INTENTOS_CODIGO;
      await prismaEmpresa.usuario.update({
        where: { id: usuarioEncontrado.id },
        data: seAgotaAhora
          ? { codigoRecuperacionHash: null, codigoRecuperacionExpira: null, codigoRecuperacionIntentos: 0 }
          : { codigoRecuperacionIntentos: nuevosIntentos },
      });
      throw new Error(seAgotaAhora ? "CODIGO_AGOTADO" : "CODIGO_INCORRECTO");
    }

    const passwordHash = await hashPassword(passwordNueva);
    // Igual que el reseteo de admin: limpia también intentosFallidos/
    // bloqueadoHasta del LOGIN (recuperar la contraseña también desbloquea
    // la cuenta) — pero, a diferencia de ese reseteo, NO se marca
    // debeCambiarPassword: la persona ya eligió su contraseña real y
    // definitiva por su propia voluntad, no una temporal impuesta.
    await prismaEmpresa.usuario.update({
      where: { id: usuarioEncontrado.id },
      data: {
        passwordHash,
        codigoRecuperacionHash: null,
        codigoRecuperacionExpira: null,
        codigoRecuperacionIntentos: 0,
        intentosFallidos: 0,
        bloqueadoHasta: null,
      },
    });

    res.json({ mensaje: "Contraseña actualizada. Ya puedes iniciar sesión." });
  } catch (error: any) {
    if (error.message === "CODIGO_VENCIDO") {
      return res.status(400).json({ error: "El código venció. Solicita uno nuevo." });
    }
    if (error.message === "CODIGO_AGOTADO") {
      return res.status(400).json({ error: "Demasiados intentos. Solicita un código nuevo." });
    }
    if (error.message === "CODIGO_INCORRECTO") {
      return res.status(400).json({ error: "Código incorrecto." });
    }
    console.error(error);
    res.status(500).json({ error: "Error al confirmar la recuperación" });
  }
});

// POST /auth/empresas
// Crea una empresa nueva de punta a punta (base de datos + esquema + primer
// usuario administrador). Público en el sentido de que no exige un token de
// sesión (nadie tiene uno todavía en el login) — pero exige la CLAVE MAESTRA
// configurada en el .env del servidor, para que no cualquiera que llegue a
// la pantalla de login pueda crear bases de datos en el servidor.
// Body: { claveMaestra, nombre, ruc, razonSocial, direccionMatriz, ambienteSri,
//         establecimiento, puntoEmision, obligadoContabilidad, agenteRetencion,
//         adminNombre, adminUsuario, adminPassword }
authRouter.post("/empresas", async (req: Request, res: Response) => {
  try {
    const claveMaestraConfigurada = process.env.CLAVE_MAESTRA_NUEVA_EMPRESA;
    if (!claveMaestraConfigurada) {
      return res.status(400).json({
        error: "El servidor no tiene configurada CLAVE_MAESTRA_NUEVA_EMPRESA — no se pueden crear empresas nuevas.",
      });
    }

    const {
      claveMaestra,
      nombre,
      ruc,
      razonSocial,
      direccionMatriz,
      ambienteSri,
      establecimiento,
      puntoEmision,
      obligadoContabilidad,
      agenteRetencion,
      adminNombre,
      adminUsuario,
      adminPassword,
    } = req.body;

    if (claveMaestra !== claveMaestraConfigurada) {
      return res.status(403).json({ error: "Clave maestra incorrecta" });
    }

    if (!nombre || !ruc || !razonSocial || !adminNombre || !adminUsuario || !adminPassword) {
      return res.status(400).json({
        error: "nombre, ruc, razonSocial, adminNombre, adminUsuario y adminPassword son obligatorios",
      });
    }
    if (adminPassword.length < 8) {
      return res.status(400).json({ error: "La contraseña del administrador debe tener al menos 8 caracteres" });
    }

    const empresa = await provisionarEmpresa({
      nombre,
      ruc,
      razonSocial,
      direccionMatriz: direccionMatriz || "",
      ambienteSri: ambienteSri === "2" ? "2" : "1",
      establecimiento: establecimiento || "001",
      puntoEmision: puntoEmision || "001",
      obligadoContabilidad: obligadoContabilidad === true,
      agenteRetencion: agenteRetencion === true,
      adminNombre,
      adminUsuario,
      adminPassword,
    });

    res.status(201).json({ id: empresa.id, nombre: empresa.nombre });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al crear la empresa: " + error.message });
  }
});

// POST /auth/empresas/:empresaId/eliminar
// Borra una empresa de punta a punta: su base de datos, su carpeta de
// archivos y su entrada en el registro — IRREVERSIBLE. Público en el mismo
// sentido que POST /auth/empresas (se usa desde el login, antes de tener
// sesión), así que exige TRES cosas a la vez para evitar un borrado por
// error o por alguien sin autoridad real sobre esa empresa puntual:
//   1. La clave maestra del servidor (mismo gate que crear una empresa).
//   2. Escribir el nombre EXACTO de la empresa (evita apuntar a la que no era).
//   3. Usuario y contraseña de un ADMIN real de ESA empresa (prueba que quien
//      borra de verdad administra ese negocio, no solo conoce la clave maestra).
// Body: { claveMaestra, nombreConfirmacion, usuario, password }
authRouter.post("/empresas/:empresaId/eliminar", async (req: Request, res: Response) => {
  try {
    const claveMaestraConfigurada = process.env.CLAVE_MAESTRA_NUEVA_EMPRESA;
    if (!claveMaestraConfigurada) {
      return res.status(400).json({ error: "El servidor no tiene configurada CLAVE_MAESTRA_NUEVA_EMPRESA" });
    }

    const { claveMaestra, nombreConfirmacion, usuario, password } = req.body;
    if (!claveMaestra || !nombreConfirmacion || !usuario || !password) {
      return res.status(400).json({
        error: "claveMaestra, nombreConfirmacion, usuario y password son obligatorios",
      });
    }
    if (claveMaestra !== claveMaestraConfigurada) {
      return res.status(403).json({ error: "Clave maestra incorrecta" });
    }

    const empresa = obtenerEmpresa(String(req.params.empresaId));
    if (!empresa) {
      return res.status(404).json({ error: "La empresa no existe" });
    }
    if (nombreConfirmacion.trim() !== empresa.nombre) {
      return res.status(400).json({ error: "El nombre no coincide exactamente con el de la empresa" });
    }

    const prismaEmpresa = obtenerPrismaDeEmpresa(empresa.id);
    const usuarioEncontrado = await prismaEmpresa.usuario.findUnique({ where: { usuario } });
    if (!usuarioEncontrado || !usuarioEncontrado.activo || usuarioEncontrado.rol !== "ADMIN") {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos, o el usuario no es administrador de esta empresa" });
    }
    const passwordValida = await compararPassword(password, usuarioEncontrado.passwordHash);
    if (!passwordValida) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos, o el usuario no es administrador de esta empresa" });
    }

    await eliminarEmpresa(empresa);

    res.json({ mensaje: `Empresa "${empresa.nombre}" eliminada` });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al eliminar la empresa: " + error.message });
  }
});

// GET /auth/yo
// Devuelve los datos del usuario autenticado, útil para que el frontend
// verifique si el token guardado sigue siendo válido al recargar la página.
authRouter.get("/yo", requireAuth, async (req: Request, res: Response) => {
  // Este endpoint pasa por el middleware de autenticación (lo agregamos en index.ts),
  // así que si llegamos aquí, req.usuario ya existe. La sucursal se relee de
  // la BD (no del JWT) para reflejar una reasignación reciente sin forzar un
  // nuevo inicio de sesión.
  const usuario = await prisma.usuario.findUnique({
    where: { id: req.usuario!.usuarioId },
    select: { sucursal: { select: { id: true, nombre: true } }, empleadoId: true, debeCambiarPassword: true },
  });
  res.json({
    ...req.usuario,
    sucursalId: usuario?.sucursal?.id ?? null,
    sucursalNombre: usuario?.sucursal?.nombre ?? null,
    empleadoId: usuario?.empleadoId ?? null,
    debeCambiarPassword: usuario?.debeCambiarPassword ?? false,
  });
});

// POST /auth/cambiar-password
// Cualquier usuario autenticado puede cambiar su propia contraseña — sirve
// tanto para el cambio obligatorio tras un reseteo (la "actual" es la
// temporal que le dieron) como para un cambio voluntario cualquiera.
// Body: { passwordActual, passwordNueva }
authRouter.post("/cambiar-password", requireAuth, async (req: Request, res: Response) => {
  try {
    const { passwordActual, passwordNueva } = req.body;
    if (!passwordActual || !passwordNueva) {
      return res.status(400).json({ error: "passwordActual y passwordNueva son obligatorios" });
    }
    if (passwordNueva.length < 8) {
      return res.status(400).json({ error: "La contraseña nueva debe tener al menos 8 caracteres" });
    }

    const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario!.usuarioId } });
    if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });

    const passwordValida = await compararPassword(passwordActual, usuario.passwordHash);
    if (!passwordValida) {
      return res.status(401).json({ error: "La contraseña actual no es correcta" });
    }

    const passwordHash = await hashPassword(passwordNueva);
    await prisma.usuario.update({
      where: { id: usuario.id },
      data: { passwordHash, debeCambiarPassword: false },
    });

    res.json({ mensaje: "Contraseña actualizada" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al cambiar la contraseña" });
  }
});
