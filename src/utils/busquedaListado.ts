// Piezas comunes del buscador dinámico de los listados de documentos
// (Facturas, Notas de venta, Compras, Proformas, Notas de crédito, Guías de
// remisión, Devoluciones, Traslados, Egresos de bodega). Cada ruta arma su
// propio "where" (los campos buscables cambian por documento); esto solo
// evita repetir la lectura/validación de los parámetros de la query.

import { Request } from "express";
import { Prisma } from "@prisma/client";

// Texto libre "?q=" — recortado y con un tope de largo (nadie busca un
// párrafo, y así una query absurda no llega a la base).
export function leerBusqueda(req: Request): string {
  const q = req.query.q;
  return typeof q === "string" ? q.trim().slice(0, 100) : "";
}

// Lee "?<clave>=" solo si es uno de los valores válidos del enum de Prisma
// (cualquier otra cosa se ignora, igual que si no se hubiera mandado).
export function leerEnum<T extends string>(req: Request, clave: string, valores: Record<string, T>): T | undefined {
  const valor = req.query[clave];
  if (typeof valor !== "string") return undefined;
  return (Object.values(valores) as string[]).includes(valor) ? (valor as T) : undefined;
}

// Filtro "contiene, sin distinguir mayúsculas" para campos de texto.
export function contiene(q: string): Prisma.StringFilter {
  return { contains: q, mode: "insensitive" };
}

// Resumen para el pie del listado a partir de un aggregate de Prisma
// (_count + _sum.total) — mismo formato en todas las rutas.
export function resumenListado(suma: { _count: number; _sum: { total: Prisma.Decimal | null } }) {
  return { cantidadVigentes: suma._count, totalVigentes: suma._sum.total ?? new Prisma.Decimal(0) };
}
