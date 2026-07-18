// Un "middleware" es una función que se ejecuta ANTES de que la petición
// llegue a la ruta final. Este en particular revisa que venga un token válido;
// si no, corta la petición ahí mismo con un error 401, sin dejarla avanzar.

import { Request, Response, NextFunction } from "express";
import { verificarToken } from "../utils/auth";
import { ejecutarConEmpresa, prisma } from "../db";

// Extendemos el tipo Request de Express para poder guardar el usuario decodificado
declare global {
  namespace Express {
    interface Request {
      usuario?: { usuarioId: number; usuario: string; rol: string; empresaId: string };
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization; // formato esperado: "Bearer <token>"

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autenticado. Inicia sesión." });
  }

  const token = authHeader.split(" ")[1];

  try {
    const payload = verificarToken(token);
    req.usuario = payload; // queda disponible para las rutas siguientes

    // Multiempresa: todo lo que corra a partir de acá (incluida cualquier
    // ruta async downstream) debe usar la base de datos de ESTA empresa —
    // ver db.ts. Si la empresa del token ya no existe (ej. se desactivó),
    // ejecutarConEmpresa lanza y lo capturamos como sesión inválida.
    try {
      ejecutarConEmpresa(payload.empresaId, () => next());
    } catch {
      return res.status(401).json({ error: "La empresa de esta sesión ya no está disponible. Inicia sesión de nuevo." });
    }
  } catch (error) {
    return res.status(401).json({ error: "Sesión inválida o expirada. Inicia sesión de nuevo." });
  }
}

// Variante para proteger rutas que solo el administrador puede usar
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.usuario?.rol !== "ADMIN") {
    return res.status(403).json({ error: "Solo un administrador puede hacer esto" });
  }
  next();
}

// Variante para proteger rutas detrás de un permiso configurable (ver
// utils/permisos.ts). Un ADMIN siempre pasa. Para cualquier otro usuario se
// consulta la base de datos EN EL MOMENTO de la petición (no el JWT, que es
// solo una foto de cuando inició sesión) — así, si un administrador le quita
// un permiso a alguien, se aplica en su siguiente petición, no cuando vuelva
// a iniciar sesión. De paso, esto también revisa "activo": un usuario
// desactivado queda bloqueado de inmediato en cualquier acción con permiso,
// no solo al intentar loguearse de nuevo.
export function requirePermiso(clave: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.usuario?.rol === "ADMIN") return next();
    try {
      const usuario = await prisma.usuario.findUnique({
        where: { id: req.usuario!.usuarioId },
        select: { activo: true, permisos: true },
      });
      if (!usuario?.activo || !usuario.permisos.includes(clave)) {
        return res.status(403).json({ error: "No tienes permiso para hacer esto" });
      }
      next();
    } catch (error) {
      console.error("Error al verificar permisos:", error);
      res.status(500).json({ error: "Error al verificar permisos" });
    }
  };
}
