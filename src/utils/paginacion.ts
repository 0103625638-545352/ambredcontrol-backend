// Paginación reutilizable para las rutas de listado (GET /productos, /facturas, etc.).
//
// Es OPCIONAL a propósito: solo se activa si quien llama manda "?page=" en la
// query string. Así, los lugares que necesitan la lista COMPLETA para
// funcionar (la grilla de productos del Punto de Venta, el selector de
// cliente, el desplegable de "facturas autorizadas" al crear una nota de
// crédito) siguen recibiendo el arreglo entero, sin tener que tocarlos.
// Las pantallas de administración (tablas de Productos, Facturas, etc.)
// mandan "page" a propósito para traer de a poco y no volverse lentas
// a medida que el negocio acumula historial.

import { Request } from "express";

const PAGE_SIZE_DEFECTO = 20;
const PAGE_SIZE_MAXIMO = 100; // límite duro: nadie puede pedir, sin querer o a propósito, la tabla completa de un jalón

export interface Paginacion {
  aplica: boolean;
  skip: number | undefined;
  take: number | undefined;
  page: number;
  pageSize: number;
}

export function leerPaginacion(req: Request): Paginacion {
  if (req.query.page === undefined) {
    return { aplica: false, skip: undefined, take: undefined, page: 1, pageSize: PAGE_SIZE_DEFECTO };
  }

  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const pageSizeCrudo = parseInt(req.query.pageSize as string, 10) || PAGE_SIZE_DEFECTO;
  const pageSize = Math.min(Math.max(1, pageSizeCrudo), PAGE_SIZE_MAXIMO);

  return { aplica: true, skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

export function respuestaPaginada<T>(datos: T[], total: number, paginacion: Paginacion) {
  return {
    datos,
    paginacion: {
      page: paginacion.page,
      pageSize: paginacion.pageSize,
      total,
      totalPaginas: Math.max(1, Math.ceil(total / paginacion.pageSize)),
    },
  };
}
