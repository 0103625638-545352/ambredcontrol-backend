// Lee el texto de búsqueda desde "?q=" en rutas de listado (GET /productos,
// /clientes, /usuarios). Devuelve undefined si no hay texto, para que sea
// fácil de usar con "&&" al armar el "where" de Prisma sin ensuciar la
// consulta con un filtro vacío.
import { Request } from "express";

export function leerTextoBusqueda(req: Request): string | undefined {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  return q.length > 0 ? q : undefined;
}
