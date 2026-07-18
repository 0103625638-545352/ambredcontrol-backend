// Resumen inicial que ve cualquier usuario autenticado al entrar al sistema
// (cajero o admin) — a diferencia de /reportes, que exige rol ADMIN porque
// expone desgloses más finos (ranking de productos, filtros por fecha, etc.).
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma, empresaActiva } from "../db";
import { obtenerStockBajo, obtenerCertificadoPorCaducar, obtenerCertificadoInvalido, obtenerEstadoBackupBaseDatos } from "../utils/alertasNegocio";
import { aClaveDia } from "../utils/rangoFechas";

export const dashboardRouter = Router();

// GET /dashboard/resumen
// Totales del mes calendario actual (facturas no anuladas) + las últimas
// facturas emitidas, para pintar las tarjetas y la tabla de la pantalla de inicio.
// Ventana de aviso: productos/lotes que caducan dentro de este número de
// días (o que ya caducaron) aparecen en la alerta del dashboard.
const DIAS_ALERTA_CADUCIDAD = 30;

// Ventana de la tendencia de ventas del Dashboard — más corta que el mes
// calendario completo que ya usa Reportes, a propósito: acá el punto es un
// vistazo rápido de "cómo van los últimos días", no un análisis de período.
const DIAS_TENDENCIA_VENTAS = 14;
const TOP_PRODUCTOS_DASHBOARD = 5;

// Qué tan a fondo se le arma el resumen a QUIEN pida esto — antes se
// calculaban y mandaban cifras de ventas (neto/IVA/total, tendencia,
// facturas recientes...) y stock a cualquier usuario autenticado, sin
// importar sus permisos: un técnico sin "ventas" ni "productos" terminaba
// viendo esos números en su propio Dashboard aunque no pudiera entrar a
// Facturas ni a Productos. Mismo criterio que requirePermiso (fresco de la
// base, no del JWT, porque los permisos pueden cambiar sin re-login).
async function permisosDashboard(req: Request): Promise<{ puedeVentas: boolean; puedeProductos: boolean }> {
  if (req.usuario!.rol === "ADMIN") return { puedeVentas: true, puedeProductos: true };
  const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario!.usuarioId }, select: { permisos: true } });
  const permisos = usuario?.permisos ?? [];
  return { puedeVentas: permisos.includes("ventas"), puedeProductos: permisos.includes("productos") };
}

dashboardRouter.get("/resumen", async (req: Request, res: Response) => {
  try {
    const { puedeVentas, puedeProductos } = await permisosDashboard(req);
    const hoy = new Date();
    const primerDiaMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const ultimoDiaMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0, 23, 59, 59);
    const limiteCaducidad = new Date(hoy.getTime() + DIAS_ALERTA_CADUCIDAD * 24 * 60 * 60 * 1000);
    const desdeTendencia = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - (DIAS_TENDENCIA_VENTAS - 1));

    const [
      facturasDelMes,
      ultimasFacturas,
      ultimasNotasVenta,
      lotesPorCaducar,
      productosPorCaducarSinLote,
      productosStockBajo,
      sucursales,
      ventasFacturasPorSucursal,
      ventasNotasVentaPorSucursal,
      facturasTendencia,
      notasVentaTendencia,
      detallesFacturaMes,
      detallesNotaVentaMes,
    ] = await Promise.all([
      prisma.factura.findMany({
        where: { fechaEmision: { gte: primerDiaMes, lte: ultimoDiaMes }, estado: { not: "ANULADA" } },
      }),
      prisma.factura.findMany({
        include: { cliente: true },
        orderBy: { fechaEmision: "desc" },
        take: 5,
      }),
      prisma.notaVenta.count({
        where: { fechaEmision: { gte: primerDiaMes, lte: ultimoDiaMes }, estado: { not: "ANULADA" } },
      }),
      prisma.loteProducto.findMany({
        where: { cantidad: { gt: 0 }, fechaCaducidad: { lte: limiteCaducidad } },
        include: { producto: { select: { nombre: true, activo: true } } },
        orderBy: { fechaCaducidad: "asc" },
      }),
      prisma.producto.findMany({
        where: { activo: true, manejaLotes: false, fechaCaducidad: { lte: limiteCaducidad } },
        select: { id: true, nombre: true, stockActual: true, fechaCaducidad: true },
        orderBy: { fechaCaducidad: "asc" },
      }),
      obtenerStockBajo(),
      prisma.sucursal.findMany({ where: { activa: true }, select: { id: true, nombre: true } }),
      prisma.factura.groupBy({
        by: ["sucursalId"],
        where: { fechaEmision: { gte: primerDiaMes, lte: ultimoDiaMes }, estado: { not: "ANULADA" } },
        _sum: { total: true },
        _count: { _all: true },
      }),
      prisma.notaVenta.groupBy({
        by: ["sucursalId"],
        where: { fechaEmision: { gte: primerDiaMes, lte: ultimoDiaMes }, estado: { not: "ANULADA" } },
        _sum: { total: true },
        _count: { _all: true },
      }),
      prisma.factura.findMany({
        where: { fechaEmision: { gte: desdeTendencia, lte: ultimoDiaMes }, estado: { not: "ANULADA" } },
        select: { fechaEmision: true, total: true },
      }),
      prisma.notaVenta.findMany({
        where: { fechaEmision: { gte: desdeTendencia, lte: ultimoDiaMes }, estado: { not: "ANULADA" } },
        select: { fechaEmision: true, total: true },
      }),
      prisma.facturaDetalle.findMany({
        where: { factura: { fechaEmision: { gte: primerDiaMes, lte: ultimoDiaMes }, estado: { not: "ANULADA" } } },
        select: { productoId: true, cantidad: true, producto: { select: { nombre: true } } },
      }),
      prisma.notaVentaDetalle.findMany({
        where: { notaVenta: { fechaEmision: { gte: primerDiaMes, lte: ultimoDiaMes }, estado: { not: "ANULADA" } } },
        select: { productoId: true, cantidad: true, producto: { select: { nombre: true } } },
      }),
    ]);

    // Ventas del mes actual (facturas + notas de venta) agrupadas por
    // sucursal, para comparar locales en la misma tarjeta del Dashboard.
    const ventasPorSucursal = sucursales.map((s) => {
      const facturasSucursal = ventasFacturasPorSucursal.find((v) => v.sucursalId === s.id);
      const notasVentaSucursal = ventasNotasVentaPorSucursal.find((v) => v.sucursalId === s.id);
      const totalFacturas = facturasSucursal?._sum.total ?? new Prisma.Decimal(0);
      const totalNotasVenta = notasVentaSucursal?._sum.total ?? new Prisma.Decimal(0);
      return {
        sucursalId: s.id,
        sucursalNombre: s.nombre,
        documentos: (facturasSucursal?._count._all ?? 0) + (notasVentaSucursal?._count._all ?? 0),
        total: totalFacturas.add(totalNotasVenta).toFixed(2),
      };
    });

    // Unificamos ambas formas de caducidad (por lote y "suelta") en una sola
    // lista, ordenada de lo que vence más pronto a lo que vence más tarde.
    const productosPorCaducar = [
      ...lotesPorCaducar
        .filter((l) => l.producto.activo)
        .map((l) => ({
          productoId: l.productoId,
          productoNombre: l.producto.nombre,
          numeroLote: l.numeroLote,
          fechaCaducidad: l.fechaCaducidad,
          cantidad: l.cantidad,
          vencido: l.fechaCaducidad < hoy,
        })),
      ...productosPorCaducarSinLote
        .filter((p) => p.stockActual > 0)
        .map((p) => ({
          productoId: p.id,
          productoNombre: p.nombre,
          numeroLote: null as string | null,
          fechaCaducidad: p.fechaCaducidad as Date,
          cantidad: p.stockActual,
          vencido: (p.fechaCaducidad as Date) < hoy,
        })),
    ].sort((a, b) => a.fechaCaducidad.getTime() - b.fechaCaducidad.getTime());

    // Tendencia de ventas de los últimos días (facturas + notas de venta),
    // rellenando también los días sin ventas con $0 — mismo criterio que
    // GET /reportes/ventas-por-dia, para que el gráfico no tenga huecos
    // silenciosos que se puedan confundir con "no se cargaron los datos".
    const acumuladoPorDia = new Map<string, Prisma.Decimal>();
    for (const d of [...facturasTendencia, ...notasVentaTendencia]) {
      const clave = aClaveDia(d.fechaEmision);
      acumuladoPorDia.set(clave, (acumuladoPorDia.get(clave) ?? new Prisma.Decimal(0)).add(d.total));
    }
    const ventasUltimosDias: { fecha: string; total: string }[] = [];
    const cursorTendencia = new Date(desdeTendencia);
    while (cursorTendencia <= hoy) {
      const clave = aClaveDia(cursorTendencia);
      ventasUltimosDias.push({ fecha: clave, total: (acumuladoPorDia.get(clave) ?? new Prisma.Decimal(0)).toFixed(2) });
      cursorTendencia.setDate(cursorTendencia.getDate() + 1);
    }

    // Ranking de productos más vendidos del mes en curso, mismo criterio
    // (por cantidad) que GET /reportes/productos-mas-vendidos, pero acotado
    // a los primeros N — acá el punto es un vistazo rápido, el ranking
    // completo con filtro de fechas libre sigue viviendo en Reportes.
    const acumuladoProductos = new Map<number, { nombre: string; cantidad: number }>();
    for (const d of [...detallesFacturaMes, ...detallesNotaVentaMes]) {
      const actual = acumuladoProductos.get(d.productoId) ?? { nombre: d.producto.nombre, cantidad: 0 };
      actual.cantidad += d.cantidad;
      acumuladoProductos.set(d.productoId, actual);
    }
    const topProductosMes = Array.from(acumuladoProductos.entries())
      .map(([productoId, datos]) => ({ productoId, nombre: datos.nombre, cantidad: datos.cantidad }))
      .sort((a, b) => b.cantidad - a.cantidad)
      .slice(0, TOP_PRODUCTOS_DASHBOARD);

    let neto = new Prisma.Decimal(0);
    let iva = new Prisma.Decimal(0);
    let total = new Prisma.Decimal(0);
    for (const f of facturasDelMes) {
      neto = neto.add(f.subtotal0).add(f.subtotal12);
      iva = iva.add(f.iva);
      total = total.add(f.total);
    }

    // Las consultas de arriba corren siempre (simplicidad sobre ahorro de
    // consultas — el Dashboard no es una ruta de alto tráfico), pero lo que
    // se manda de vuelta si depende de "ventas"/"productos": sin el permiso
    // correspondiente, el campo va vacío/en cero en vez de con las cifras
    // reales, para que un técnico (o cualquiera sin esos permisos) no las
    // vea ni mirando la respuesta cruda de la API.
    res.json({
      ambiente: empresaActiva().ambienteSri === "2" ? "PRODUCCIÓN" : "PRUEBAS",
      resumen: puedeVentas
        ? {
            documentosEmitidosMes: facturasDelMes.length,
            notasVentaMes: ultimasNotasVenta,
            neto: neto.toFixed(2),
            iva: iva.toFixed(2),
            total: total.toFixed(2),
          }
        : { documentosEmitidosMes: 0, notasVentaMes: 0, neto: "0.00", iva: "0.00", total: "0.00" },
      facturasRecientes: puedeVentas
        ? ultimasFacturas.map((f) => ({
            id: f.id,
            secuencial: f.secuencial,
            fechaEmision: f.fechaEmision,
            cliente: f.cliente.razonSocial,
            estado: f.estado,
            total: f.total,
          }))
        : [],
      productosStockBajo: puedeProductos ? productosStockBajo : [],
      productosPorCaducar: puedeProductos ? productosPorCaducar : [],
      certificadoPorCaducar: puedeVentas ? obtenerCertificadoPorCaducar() : null,
      certificadoInvalido: puedeVentas ? obtenerCertificadoInvalido() : null,
      // Solo se avisa si el respaldo automático está configurado — sin
      // BACKUP_DB_PATH, "atrasado" sería siempre true y sería puro ruido.
      backupAtrasado: puedeVentas && process.env.BACKUP_DB_PATH ? obtenerEstadoBackupBaseDatos().atrasado : false,
      ventasPorSucursal: puedeVentas ? ventasPorSucursal : [],
      ventasUltimosDias: puedeVentas ? ventasUltimosDias : [],
      topProductosMes: puedeVentas ? topProductosMes : [],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el resumen del dashboard" });
  }
});
