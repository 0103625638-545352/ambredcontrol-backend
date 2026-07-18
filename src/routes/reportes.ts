import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { Prisma } from "@prisma/client";
import { calcularDiasAtraso, bucketMora, type BucketMora } from "../utils/vencimientos";
import { fechaLocalDeString, aClaveDia } from "../utils/rangoFechas";
import { listarIpsSuspendidas } from "../utils/mikrotik";

export const reportesRouter = Router();

function moraVacia(): Record<BucketMora, Prisma.Decimal> {
  return { AL_DIA: new Prisma.Decimal(0), "1_30": new Prisma.Decimal(0), "31_60": new Prisma.Decimal(0), "61_90": new Prisma.Decimal(0), MAS_90: new Prisma.Decimal(0) };
}

function moraPorBucketAFixed(mora: Record<BucketMora, Prisma.Decimal>): Record<BucketMora, string> {
  return { AL_DIA: mora.AL_DIA.toFixed(2), "1_30": mora["1_30"].toFixed(2), "31_60": mora["31_60"].toFixed(2), "61_90": mora["61_90"].toFixed(2), MAS_90: mora.MAS_90.toFixed(2) };
}

// Rango de fechas compartido por los 3 reportes de abajo: si no se pasan
// "desde"/"hasta" por query, usamos el mes calendario actual por defecto.
function calcularRangoFechas(req: Request): { desde: Date; hasta: Date } {
  const hoy = new Date();
  const primerDiaMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const ultimoDiaMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0, 23, 59, 59);

  const desde = req.query.desde ? fechaLocalDeString(req.query.desde as string, false) : primerDiaMes;
  // Sumamos el día completo si viene una fecha "hasta" (para incluir todo ese día)
  const hasta = req.query.hasta ? fechaLocalDeString(req.query.hasta as string, true) : ultimoDiaMes;

  return { desde, hasta };
}

// GET /reportes/ventas?desde=2026-07-01&hasta=2026-07-31
// Devuelve un resumen de FACTURAS para el rango de fechas dado.
reportesRouter.get("/ventas", async (req: Request, res: Response) => {
  try {
    const { desde, hasta } = calcularRangoFechas(req);

    // Excluimos las facturas anuladas: no representan una venta real.
    const facturas = await prisma.factura.findMany({
      where: {
        fechaEmision: { gte: desde, lte: hasta },
        estado: { not: "ANULADA" },
      },
      include: { cliente: true },
      orderBy: { fechaEmision: "asc" },
    });

    // Sumamos manualmente con Prisma.Decimal para no perder precisión de centavos
    let totalSubtotal0 = new Prisma.Decimal(0);
    let totalSubtotal12 = new Prisma.Decimal(0);
    let totalIva = new Prisma.Decimal(0);
    let totalGeneral = new Prisma.Decimal(0);

    for (const f of facturas) {
      totalSubtotal0 = totalSubtotal0.add(f.subtotal0);
      totalSubtotal12 = totalSubtotal12.add(f.subtotal12);
      totalIva = totalIva.add(f.iva);
      totalGeneral = totalGeneral.add(f.total);
    }

    res.json({
      rango: { desde, hasta },
      resumen: {
        cantidadFacturas: facturas.length,
        subtotal0: totalSubtotal0.toFixed(2),
        subtotal12: totalSubtotal12.toFixed(2),
        iva: totalIva.toFixed(2),
        total: totalGeneral.toFixed(2),
      },
      facturas: facturas.map((f: (typeof facturas)[number]) => ({
        id: f.id,
        secuencial: f.secuencial,
        fechaEmision: f.fechaEmision,
        cliente: f.cliente.razonSocial,
        estado: f.estado,
        total: f.total,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el reporte de ventas" });
  }
});

// GET /reportes/notas-venta?desde=&hasta=
// Igual que /ventas, pero para NOTAS DE VENTA (recibos internos, sin SRI).
// Se reporta por separado porque son un tipo de comprobante distinto: no
// siempre llevan IVA (ver "aplicaIva") y no tienen los mismos estados que
// una factura.
reportesRouter.get("/notas-venta", async (req: Request, res: Response) => {
  try {
    const { desde, hasta } = calcularRangoFechas(req);

    const notasVenta = await prisma.notaVenta.findMany({
      where: {
        fechaEmision: { gte: desde, lte: hasta },
        estado: { not: "ANULADA" },
      },
      include: { cliente: true },
      orderBy: { fechaEmision: "asc" },
    });

    let totalSubtotal0 = new Prisma.Decimal(0);
    let totalSubtotal12 = new Prisma.Decimal(0);
    let totalIva = new Prisma.Decimal(0);
    let totalGeneral = new Prisma.Decimal(0);

    for (const n of notasVenta) {
      totalSubtotal0 = totalSubtotal0.add(n.subtotal0);
      totalSubtotal12 = totalSubtotal12.add(n.subtotal12);
      totalIva = totalIva.add(n.iva);
      totalGeneral = totalGeneral.add(n.total);
    }

    res.json({
      rango: { desde, hasta },
      resumen: {
        cantidadNotasVenta: notasVenta.length,
        subtotal0: totalSubtotal0.toFixed(2),
        subtotal12: totalSubtotal12.toFixed(2),
        iva: totalIva.toFixed(2),
        total: totalGeneral.toFixed(2),
      },
      notasVenta: notasVenta.map((n: (typeof notasVenta)[number]) => ({
        id: n.id,
        secuencial: n.secuencial,
        fechaEmision: n.fechaEmision,
        cliente: n.cliente.razonSocial,
        estado: n.estado,
        aplicaIva: n.aplicaIva,
        total: n.total,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el reporte de notas de venta" });
  }
});

// GET /reportes/compras?desde=&hasta=
// El "reverso" de /ventas: resumen de COMPRAS a proveedores en el rango dado
// (excluye las anuladas, igual criterio que facturas/notas de venta).
reportesRouter.get("/compras", async (req: Request, res: Response) => {
  try {
    const { desde, hasta } = calcularRangoFechas(req);

    const compras = await prisma.compra.findMany({
      where: {
        fechaEmision: { gte: desde, lte: hasta },
        estado: { not: "ANULADA" },
      },
      include: { proveedor: true },
      orderBy: { fechaEmision: "asc" },
    });

    let totalSubtotal0 = new Prisma.Decimal(0);
    let totalSubtotal12 = new Prisma.Decimal(0);
    let totalIva = new Prisma.Decimal(0);
    let totalGeneral = new Prisma.Decimal(0);

    for (const c of compras) {
      totalSubtotal0 = totalSubtotal0.add(c.subtotal0);
      totalSubtotal12 = totalSubtotal12.add(c.subtotal12);
      totalIva = totalIva.add(c.iva);
      totalGeneral = totalGeneral.add(c.total);
    }

    res.json({
      rango: { desde, hasta },
      resumen: {
        cantidadCompras: compras.length,
        subtotal0: totalSubtotal0.toFixed(2),
        subtotal12: totalSubtotal12.toFixed(2),
        iva: totalIva.toFixed(2),
        total: totalGeneral.toFixed(2),
      },
      compras: compras.map((c: (typeof compras)[number]) => ({
        id: c.id,
        numeroFactura: c.numeroFactura,
        fechaEmision: c.fechaEmision,
        proveedor: c.proveedor.razonSocial,
        estado: c.estado,
        total: c.total,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el reporte de compras" });
  }
});

// GET /reportes/cuentas-por-cobrar
// A diferencia de los reportes de arriba, este NO filtra por rango de fechas
// — un documento de hace 3 meses que sigue sin cobrarse debe seguir apareciendo
// hoy. Excluye ANULADA (no tiene sentido cobrar algo que se anuló) y PAGADA
// (ya no hay nada pendiente). Combina Facturas Y Notas de Venta: ambas se
// pueden vender "al fiado" y quedar pendientes de cobro, así que "cuánto me
// deben" tiene que sumar las dos, no solo las facturas.
reportesRouter.get("/cuentas-por-cobrar", async (_req: Request, res: Response) => {
  try {
    const [facturas, notasVenta] = await Promise.all([
      prisma.factura.findMany({
        where: { estado: { not: "ANULADA" }, estadoPago: { not: "PAGADA" } },
        include: { cliente: true },
      }),
      prisma.notaVenta.findMany({
        where: { estado: { not: "ANULADA" }, estadoPago: { not: "PAGADA" } },
        include: { cliente: true },
      }),
    ]);

    const ahora = new Date();
    let totalSaldo = new Prisma.Decimal(0);
    const moraPorBucket = moraVacia();

    function acumularMora(saldo: Prisma.Decimal, diasAtraso: number | null) {
      totalSaldo = totalSaldo.add(saldo);
      const bucket = bucketMora(diasAtraso);
      moraPorBucket[bucket] = moraPorBucket[bucket].add(saldo);
    }

    const detalleFacturas = facturas.map((f: (typeof facturas)[number]) => {
      const saldo = f.total.sub(f.montoPagado);
      const diasAtraso = calcularDiasAtraso(f.fechaVencimiento, f.estadoPago, ahora);
      acumularMora(saldo, diasAtraso);
      return {
        id: f.id,
        tipo: "FACTURA" as const,
        documento: f.secuencial,
        fechaEmision: f.fechaEmision,
        fechaVencimiento: f.fechaVencimiento,
        diasAtraso,
        cliente: f.cliente.razonSocial,
        estado: f.estado,
        estadoPago: f.estadoPago,
        total: f.total,
        montoPagado: f.montoPagado,
        saldo: saldo.toFixed(2),
      };
    });

    const detalleNotasVenta = notasVenta.map((n: (typeof notasVenta)[number]) => {
      const saldo = n.total.sub(n.montoPagado);
      const diasAtraso = calcularDiasAtraso(n.fechaVencimiento, n.estadoPago, ahora);
      acumularMora(saldo, diasAtraso);
      return {
        id: n.id,
        tipo: "NOTA_VENTA" as const,
        documento: n.secuencial,
        fechaEmision: n.fechaEmision,
        fechaVencimiento: n.fechaVencimiento,
        diasAtraso,
        cliente: n.cliente.razonSocial,
        estado: n.estado,
        estadoPago: n.estadoPago,
        total: n.total,
        montoPagado: n.montoPagado,
        saldo: saldo.toFixed(2),
      };
    });

    const documentos = [...detalleFacturas, ...detalleNotasVenta].sort(
      (a, b) => a.fechaEmision.getTime() - b.fechaEmision.getTime()
    );

    res.json({
      resumen: {
        cantidadDocumentos: documentos.length,
        totalPorCobrar: totalSaldo.toFixed(2),
        moraPorBucket: moraPorBucketAFixed(moraPorBucket),
      },
      documentos,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el reporte de cuentas por cobrar" });
  }
});

// GET /reportes/cuentas-por-pagar
// El reverso: compras a proveedores que todavía no hemos terminado de pagar.
reportesRouter.get("/cuentas-por-pagar", async (_req: Request, res: Response) => {
  try {
    const compras = await prisma.compra.findMany({
      where: { estado: { not: "ANULADA" }, estadoPago: { not: "PAGADA" } },
      include: { proveedor: true },
      orderBy: { fechaEmision: "asc" },
    });

    // Una sola consulta agregada para todas las compras del reporte, en vez
    // de una por fila — DevolucionCompra nunca edita compra.total/montoPagado
    // (ver utils/devolucionesCompra.ts), así que el saldo real se calcula acá.
    const devolucionesPorCompra = await prisma.devolucionCompra.groupBy({
      by: ["compraId"],
      _sum: { total: true },
      where: { compraId: { in: compras.map((c: (typeof compras)[number]) => c.id) } },
    });
    const totalDevueltoPorCompraId = new Map(
      devolucionesPorCompra.map((d: (typeof devolucionesPorCompra)[number]) => [d.compraId, d._sum.total ?? new Prisma.Decimal(0)])
    );

    const ahora = new Date();
    let totalSaldo = new Prisma.Decimal(0);
    const moraPorBucket = moraVacia();

    const detalle = compras.map((c: (typeof compras)[number]) => {
      const saldo = c.total.sub(c.montoPagado).sub(totalDevueltoPorCompraId.get(c.id) ?? new Prisma.Decimal(0));
      const diasAtraso = calcularDiasAtraso(c.fechaVencimiento, c.estadoPago, ahora);
      totalSaldo = totalSaldo.add(saldo);
      moraPorBucket[bucketMora(diasAtraso)] = moraPorBucket[bucketMora(diasAtraso)].add(saldo);
      return {
        id: c.id,
        numeroFactura: c.numeroFactura,
        fechaEmision: c.fechaEmision,
        fechaVencimiento: c.fechaVencimiento,
        diasAtraso,
        proveedor: c.proveedor.razonSocial,
        estado: c.estado,
        estadoPago: c.estadoPago,
        total: c.total,
        montoPagado: c.montoPagado,
        saldo: saldo.toFixed(2),
      };
    });

    res.json({
      resumen: {
        cantidadCompras: compras.length,
        totalPorPagar: totalSaldo.toFixed(2),
        moraPorBucket: moraPorBucketAFixed(moraPorBucket),
      },
      compras: detalle,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el reporte de cuentas por pagar" });
  }
});

// GET /reportes/productos-mas-vendidos?desde=&hasta=
// Ranking simple de productos por cantidad vendida en el período — combina
// TANTO facturas como notas de venta, porque para efectos de "qué se está
// vendiendo" ambas son ventas reales que movieron inventario.
reportesRouter.get("/productos-mas-vendidos", async (req: Request, res: Response) => {
  try {
    const { desde, hasta } = calcularRangoFechas(req);

    const detallesFactura = await prisma.facturaDetalle.findMany({
      where: {
        factura: {
          fechaEmision: { gte: desde, lte: hasta },
          estado: { not: "ANULADA" },
        },
      },
      include: { producto: true },
    });

    const detallesNotaVenta = await prisma.notaVentaDetalle.findMany({
      where: {
        notaVenta: {
          fechaEmision: { gte: desde, lte: hasta },
          estado: { not: "ANULADA" },
        },
      },
      include: { producto: true },
    });

    // Agrupamos manualmente por producto (Prisma groupBy no permite incluir
    // fácilmente el nombre del producto en la misma consulta agrupada, y aquí
    // además necesitamos combinar dos tablas distintas)
    const acumulado = new Map<number, { nombre: string; cantidad: number; totalVendido: Prisma.Decimal }>();

    for (const d of [...detallesFactura, ...detallesNotaVenta]) {
      const actual = acumulado.get(d.productoId) ?? {
        nombre: d.producto.nombre,
        cantidad: 0,
        totalVendido: new Prisma.Decimal(0),
      };
      actual.cantidad += d.cantidad;
      actual.totalVendido = actual.totalVendido.add(d.subtotal);
      acumulado.set(d.productoId, actual);
    }

    const ranking = Array.from(acumulado.entries())
      .map(([productoId, datos]) => ({
        productoId,
        nombre: datos.nombre,
        cantidad: datos.cantidad,
        totalVendido: datos.totalVendido.toFixed(2),
      }))
      .sort((a, b) => b.cantidad - a.cantidad);

    res.json(ranking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el ranking de productos" });
  }
});

// GET /reportes/cobros-bancarios?desde=&hasta=
// Movimiento bancario (TRANSFERENCIA/TARJETA/CHEQUE) agrupado por cuenta —
// incluye tanto lo cobrado (Factura/NotaVenta, dinero que entra) como lo
// pagado a proveedores (Compra, dinero que sale), para poder conciliar el
// total de cada cuenta bancaria de la empresa en el período. El detalle
// movimiento por movimiento vive en GET /pagos/bancarios (Reporteador
// Principal) — acá solo interesa el total por cuenta.
reportesRouter.get("/cobros-bancarios", async (req: Request, res: Response) => {
  try {
    const { desde, hasta } = calcularRangoFechas(req);

    const pagos = await prisma.pago.findMany({
      where: {
        formaPago: { in: ["TRANSFERENCIA", "TARJETA", "CHEQUE"] },
        fecha: { gte: desde, lte: hasta },
      },
      include: { cuentaBancaria: true },
    });

    const porCuenta = new Map<
      number,
      { nombre: string; banco: string; numeroCuenta: string; cantidad: number; totalCobrado: Prisma.Decimal; totalPagado: Prisma.Decimal }
    >();
    let totalCobrado = new Prisma.Decimal(0);
    let totalPagado = new Prisma.Decimal(0);

    for (const p of pagos) {
      // Un Pago sin cuentaBancariaId no debería poder existir con estas
      // formaPago (ver validación en facturas.ts/compras.ts/notasVenta.ts),
      // pero por si acaso queda un registro huérfano no lo contamos acá.
      if (!p.cuentaBancariaId || !p.cuentaBancaria) continue;

      const esPago = p.compraId !== null;
      if (esPago) totalPagado = totalPagado.add(p.monto);
      else totalCobrado = totalCobrado.add(p.monto);

      const actual = porCuenta.get(p.cuentaBancariaId) ?? {
        nombre: p.cuentaBancaria.nombre,
        banco: p.cuentaBancaria.banco,
        numeroCuenta: p.cuentaBancaria.numeroCuenta,
        cantidad: 0,
        totalCobrado: new Prisma.Decimal(0),
        totalPagado: new Prisma.Decimal(0),
      };
      actual.cantidad += 1;
      if (esPago) actual.totalPagado = actual.totalPagado.add(p.monto);
      else actual.totalCobrado = actual.totalCobrado.add(p.monto);
      porCuenta.set(p.cuentaBancariaId, actual);
    }

    res.json({
      rango: { desde, hasta },
      resumen: {
        cantidadMovimientos: pagos.length,
        totalCobrado: totalCobrado.toFixed(2),
        totalPagado: totalPagado.toFixed(2),
        neto: totalCobrado.sub(totalPagado).toFixed(2),
      },
      porCuenta: Array.from(porCuenta.entries())
        .map(([cuentaBancariaId, datos]) => ({
          cuentaBancariaId,
          nombre: datos.nombre,
          banco: datos.banco,
          numeroCuenta: datos.numeroCuenta,
          cantidad: datos.cantidad,
          totalCobrado: datos.totalCobrado.toFixed(2),
          totalPagado: datos.totalPagado.toFixed(2),
          neto: datos.totalCobrado.sub(datos.totalPagado).toFixed(2),
        }))
        .sort((a, b) => b.cantidad - a.cantidad),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el reporte de cobros bancarios" });
  }
});

// Convierte una fecha a su clave "YYYY-MM-DD" en hora LOCAL del servidor
// (no UTC) — consistente con calcularRangoFechas, que arma el rango del mes
// con getFullYear()/getMonth() locales, no con toISOString().
// GET /reportes/ventas-por-dia?desde=&hasta=
// Total vendido (facturas + notas de venta, sin anuladas) agrupado por día,
// para graficar la tendencia — a diferencia de /ventas y /notas-venta (que
// listan documento por documento), acá el punto es la SERIE de tiempo. Se
// rellenan también los días sin ventas con $0, para que el gráfico no tenga
// huecos silenciosos que se puedan confundir con "no se cargaron los datos".
reportesRouter.get("/ventas-por-dia", async (req: Request, res: Response) => {
  try {
    const { desde, hasta } = calcularRangoFechas(req);

    const [facturas, notasVenta] = await Promise.all([
      prisma.factura.findMany({
        where: { fechaEmision: { gte: desde, lte: hasta }, estado: { not: "ANULADA" } },
        select: { fechaEmision: true, total: true },
      }),
      prisma.notaVenta.findMany({
        where: { fechaEmision: { gte: desde, lte: hasta }, estado: { not: "ANULADA" } },
        select: { fechaEmision: true, total: true },
      }),
    ]);

    const acumuladoPorDia = new Map<string, Prisma.Decimal>();
    for (const d of [...facturas, ...notasVenta]) {
      const clave = aClaveDia(d.fechaEmision);
      acumuladoPorDia.set(clave, (acumuladoPorDia.get(clave) ?? new Prisma.Decimal(0)).add(d.total));
    }

    const serie: { fecha: string; total: string }[] = [];
    const cursor = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
    const fin = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate());
    while (cursor <= fin) {
      const clave = aClaveDia(cursor);
      serie.push({ fecha: clave, total: (acumuladoPorDia.get(clave) ?? new Prisma.Decimal(0)).toFixed(2) });
      cursor.setDate(cursor.getDate() + 1);
    }

    res.json(serie);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar la serie de ventas por día" });
  }
});

// GET /reportes/rentabilidad?desde=&hasta=
// Margen por producto: ingreso por lo vendido en el rango (facturas + notas
// de venta, igual criterio que /productos-mas-vendidos) contra el COSTO
// PROMEDIO PONDERADO CORRIENTE de ese producto (Producto.costoPromedioActual,
// mantenido incrementalmente en cada compra/devolución a proveedor — ver
// utils/costeoInventario.ts). No se recalcula desde el historial completo de
// compras en cada llamada: se lee directo, ya viene con el include de
// producto que esta consulta ya traía.
//
// Si un producto nunca se compró por esta vía (ej. su stock inicial se cargó
// directo al crear el producto, sin pasar por /compras), no hay costo con qué
// calcular el margen — se reporta "sin datos de costo" en vez de asumir $0,
// que inflaría el margen de forma engañosa.
reportesRouter.get("/rentabilidad", async (req: Request, res: Response) => {
  try {
    const { desde, hasta } = calcularRangoFechas(req);

    const [detallesFactura, detallesNotaVenta] = await Promise.all([
      prisma.facturaDetalle.findMany({
        where: { factura: { fechaEmision: { gte: desde, lte: hasta }, estado: { not: "ANULADA" } } },
        include: { producto: true },
      }),
      prisma.notaVentaDetalle.findMany({
        where: { notaVenta: { fechaEmision: { gte: desde, lte: hasta }, estado: { not: "ANULADA" } } },
        include: { producto: true },
      }),
    ]);

    const ventasAcumuladas = new Map<
      number,
      { nombre: string; cantidad: number; ingresoTotal: Prisma.Decimal; costoPromedio: Prisma.Decimal | null }
    >();
    for (const d of [...detallesFactura, ...detallesNotaVenta]) {
      const actual = ventasAcumuladas.get(d.productoId) ?? {
        nombre: d.producto.nombre,
        cantidad: 0,
        ingresoTotal: new Prisma.Decimal(0),
        costoPromedio: d.producto.costoPromedioActual,
      };
      actual.cantidad += d.cantidad;
      actual.ingresoTotal = actual.ingresoTotal.add(d.subtotal);
      ventasAcumuladas.set(d.productoId, actual);
    }

    const ranking = Array.from(ventasAcumuladas.entries())
      .map(([productoId, datos]) => {
        const costoPromedio = datos.costoPromedio;
        const margen = costoPromedio ? datos.ingresoTotal.sub(costoPromedio.mul(datos.cantidad)) : null;
        const margenPorcentaje = margen && datos.ingresoTotal.gt(0) ? margen.div(datos.ingresoTotal).mul(100) : null;

        return {
          productoId,
          nombre: datos.nombre,
          cantidadVendida: datos.cantidad,
          ingresoTotal: datos.ingresoTotal.toFixed(2),
          costoPromedio: costoPromedio ? costoPromedio.toFixed(2) : null,
          margen: margen ? margen.toFixed(2) : null,
          margenPorcentaje: margenPorcentaje ? margenPorcentaje.toFixed(1) : null,
        };
      })
      .sort((a, b) => {
        if (a.margen === null && b.margen === null) return 0;
        if (a.margen === null) return 1;
        if (b.margen === null) return -1;
        return parseFloat(b.margen) - parseFloat(a.margen);
      });

    res.json({ rango: { desde, hasta }, ranking });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el reporte de rentabilidad" });
  }
});

// GET /reportes/iva-formulario104?desde=&hasta=
// Resumen mensual pensado para armar la declaración de IVA (Formulario 104):
// ventas gravadas, compras con derecho a crédito tributario, y las dos
// direcciones de retención (la que esta empresa practica a sus proveedores
// — obligación aparte de remitir al SRI, no reduce lo que se paga acá — y la
// que un cliente le practica a esta empresa — esa sí reduce el IVA a pagar).
reportesRouter.get("/iva-formulario104", async (req: Request, res: Response) => {
  try {
    const { desde, hasta } = calcularRangoFechas(req);
    const rangoFecha = { gte: desde, lte: hasta };

    const [facturas, notasCredito, notasVentaConIva, compras, retencionesPracticadas, retencionesRecibidas] = await Promise.all([
      prisma.factura.findMany({ where: { fechaEmision: rangoFecha, estado: { not: "ANULADA" } } }),
      prisma.notaCredito.findMany({ where: { fechaEmision: rangoFecha, estado: { not: "ANULADA" } } }),
      prisma.notaVenta.findMany({ where: { fechaEmision: rangoFecha, estado: { not: "ANULADA" }, aplicaIva: true } }),
      prisma.compra.findMany({ where: { fechaEmision: rangoFecha, estado: { not: "ANULADA" } } }),
      prisma.retencion.findMany({ where: { fechaEmision: rangoFecha, estado: { not: "ANULADA" } } }),
      prisma.retencionRecibida.findMany({ where: { fechaEmision: rangoFecha } }),
    ]);

    function sumarGravado(docs: { subtotal0: Prisma.Decimal; subtotal12: Prisma.Decimal; iva: Prisma.Decimal }[]) {
      return docs.reduce(
        (acc, d) => ({
          gravado0: acc.gravado0.add(d.subtotal0),
          gravado12: acc.gravado12.add(d.subtotal12),
          iva: acc.iva.add(d.iva),
        }),
        { gravado0: new Prisma.Decimal(0), gravado12: new Prisma.Decimal(0), iva: new Prisma.Decimal(0) }
      );
    }

    const sumaFacturas = sumarGravado(facturas);
    const sumaNotasCredito = sumarGravado(notasCredito);
    const sumaNotasVenta = sumarGravado(notasVentaConIva);
    const sumaCompras = sumarGravado(compras);

    // Ventas netas = Facturas + Notas de Venta (con IVA activado) − Notas de Crédito
    const ventasGravadas0 = sumaFacturas.gravado0.add(sumaNotasVenta.gravado0).sub(sumaNotasCredito.gravado0);
    const ventasGravadas12 = sumaFacturas.gravado12.add(sumaNotasVenta.gravado12).sub(sumaNotasCredito.gravado12);
    const ivaEnVentas = sumaFacturas.iva.add(sumaNotasVenta.iva).sub(sumaNotasCredito.iva);

    const ivaEnCompras = sumaCompras.iva; // crédito tributario

    const totalIvaPracticado = retencionesPracticadas.reduce((acc, r) => acc.add(r.totalIva), new Prisma.Decimal(0));
    const totalRentaPracticada = retencionesPracticadas.reduce((acc, r) => acc.add(r.totalRenta), new Prisma.Decimal(0));
    const totalIvaRecibido = retencionesRecibidas.reduce((acc, r) => acc.add(r.totalIva), new Prisma.Decimal(0));
    const totalRentaRecibida = retencionesRecibidas.reduce((acc, r) => acc.add(r.totalRenta), new Prisma.Decimal(0));

    // Positivo = IVA a pagar al SRI; negativo = crédito tributario a favor.
    const ivaCausado = ivaEnVentas.sub(ivaEnCompras).sub(totalIvaRecibido);

    res.json({
      rango: { desde, hasta },
      ventas: {
        gravadas0: ventasGravadas0.toFixed(2),
        gravadas12: ventasGravadas12.toFixed(2),
        ivaCobrado: ivaEnVentas.toFixed(2),
        cantidadFacturas: facturas.length,
        cantidadNotasCredito: notasCredito.length,
        cantidadNotasVenta: notasVentaConIva.length,
      },
      compras: {
        gravadas0: sumaCompras.gravado0.toFixed(2),
        gravadas12: sumaCompras.gravado12.toFixed(2),
        ivaPagado: ivaEnCompras.toFixed(2),
        cantidadCompras: compras.length,
      },
      retencionesPracticadas: {
        totalIva: totalIvaPracticado.toFixed(2),
        totalRenta: totalRentaPracticada.toFixed(2),
        cantidad: retencionesPracticadas.length,
      },
      retencionesRecibidas: {
        totalIva: totalIvaRecibido.toFixed(2),
        totalRenta: totalRentaRecibida.toFixed(2),
        cantidad: retencionesRecibidas.length,
      },
      resumen: {
        ivaEnVentas: ivaEnVentas.toFixed(2),
        ivaEnCompras: ivaEnCompras.toFixed(2),
        ivaRetenidoRecibido: totalIvaRecibido.toFixed(2),
        ivaCausado: ivaCausado.toFixed(2),
        esAFavor: ivaCausado.isNeg(),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el reporte de IVA" });
  }
});

// GET /reportes/clientes-internet-por-mes?anio=2026&mes=7&estado=pagaron|no-pagaron
// A diferencia de "Facturación de Internet" (que solo mira el estado ACTUAL,
// nunca un mes pasado), esto responde "¿quién pagó/no pagó su plan en tal
// mes?" para cualquier mes histórico — pensado para el buscador dinámico de
// Reportes (ver frontend/src/utils/interpretarBusqueda.ts). "Pagó ese mes"
// usa el mismo criterio de dos casos que utils/gestionServicioInternet.ts
// (factura del plan PAGADA emitida ese mes, O un cobro adelantado — Pago con
// clienteId puesto — registrado ese mes), solo que parametrizado por mes en
// vez de "el mes en curso". Clientes dados de alta DESPUÉS de ese mes se
// excluyen (todavía no existían, ni pagaron ni dejaron de pagar).
//
// Nota de rendimiento: hace 1-2 consultas por cliente en vez de una sola
// consulta agregada — aceptable para la cantidad de clientes de internet de
// este negocio (decenas/cientos), pero no escalaría a decenas de miles.
reportesRouter.get("/clientes-internet-por-mes", async (req: Request, res: Response) => {
  try {
    const anio = Number(req.query.anio);
    const mes = Number(req.query.mes);
    const estado = req.query.estado === "no-pagaron" ? "no-pagaron" : "pagaron";
    if (!Number.isInteger(anio) || !Number.isInteger(mes) || mes < 1 || mes > 12) {
      return res.status(400).json({ error: "anio y mes son obligatorios (mes entre 1 y 12)" });
    }

    const inicioMes = new Date(anio, mes - 1, 1);
    const inicioMesSiguiente = new Date(anio, mes, 1);

    const clientes = await prisma.cliente.findMany({
      where: { planInternetId: { not: null }, createdAt: { lt: inicioMesSiguiente } },
      include: { planInternet: true },
      orderBy: { razonSocial: "asc" },
    });

    const resultado: {
      id: number;
      identificacion: string;
      razonSocial: string;
      telefono: string | null;
      plan: string;
      pago: boolean;
    }[] = [];

    for (const cliente of clientes) {
      const productoId = cliente.planInternet?.productoId ?? null;
      let pago = false;

      if (productoId) {
        const facturaPagada = await prisma.factura.findFirst({
          where: {
            clienteId: cliente.id,
            detalles: { some: { productoId } },
            estadoPago: "PAGADA",
            fechaEmision: { gte: inicioMes, lt: inicioMesSiguiente },
          },
          select: { id: true },
        });
        pago = !!facturaPagada;
      }

      if (!pago) {
        // Cobro adelantado de internet (ver Pago.clienteId en schema.prisma)
        // — nunca se usa para pagos de facturas normales (esas van por
        // facturaId, con clienteId null), así que no hay riesgo de contar
        // acá un pago de venta de equipos como si fuera del plan.
        const cobroAdelantado = await prisma.pago.findFirst({
          where: { clienteId: cliente.id, fecha: { gte: inicioMes, lt: inicioMesSiguiente } },
          select: { id: true },
        });
        pago = !!cobroAdelantado;
      }

      if ((estado === "pagaron" && pago) || (estado === "no-pagaron" && !pago)) {
        resultado.push({
          id: cliente.id,
          identificacion: cliente.identificacion,
          razonSocial: cliente.razonSocial,
          telefono: cliente.telefono,
          plan: cliente.planInternet?.nombre ?? "",
          pago,
        });
      }
    }

    res.json({ anio, mes, estado, total: resultado.length, clientes: resultado });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el reporte de clientes de internet por mes" });
  }
});

// GET /reportes/clientes-por-estado?estado=activos|suspendidos
// Estado EN VIVO (consulta el Mikrotik de cada nodo al vuelo, igual que
// ClientesPage.tsx) — a diferencia de "clientes que (no) pagaron [mes]", que
// mira la HISTORIA de facturación, esto responde "¿a quién tengo cortado/
// activo AHORA MISMO?", sin importar si pagó o no. Un cliente sin nodo o sin
// IP asignada no puede estar ni "activo" ni "suspendido" de verdad (no hay
// a qué Mikrotik consultarlo) — se excluye de los dos, igual que hace la
// pantalla de Clientes con el mismo caso.
reportesRouter.get("/clientes-por-estado", async (req: Request, res: Response) => {
  try {
    const estado = req.query.estado === "suspendidos" ? "suspendidos" : "activos";

    const clientes = await prisma.cliente.findMany({
      where: { nodoId: { not: null }, direccionIp: { not: null } },
      include: { nodo: { select: { id: true, nombre: true } } },
      orderBy: { razonSocial: "asc" },
    });

    const nodoIds = [...new Set(clientes.map((c: (typeof clientes)[number]) => c.nodoId!))];
    const suspendidasPorNodo = new Map<number, string[]>();
    const nodosConError: string[] = [];

    // Un nodo caído no debe tumbar el reporte entero — se excluyen sus
    // clientes del resultado (no sabemos su estado real) y se avisa cuáles
    // quedaron afuera, en vez de fallar la consulta completa.
    await Promise.all(
      nodoIds.map(async (nodoId) => {
        try {
          suspendidasPorNodo.set(nodoId, await listarIpsSuspendidas(nodoId));
        } catch (error: any) {
          const nombreNodo = clientes.find((c: (typeof clientes)[number]) => c.nodoId === nodoId)?.nodo?.nombre ?? `#${nodoId}`;
          nodosConError.push(nombreNodo);
        }
      })
    );

    const resultado: {
      id: number;
      identificacion: string;
      razonSocial: string;
      telefono: string | null;
      nodo: string;
      direccionIp: string;
    }[] = [];

    for (const cliente of clientes) {
      const suspendidas = suspendidasPorNodo.get(cliente.nodoId!);
      if (!suspendidas) continue; // nodo con error — se excluye, no se sabe su estado real
      const suspendido = suspendidas.includes(cliente.direccionIp!);
      if ((estado === "suspendidos") === suspendido) {
        resultado.push({
          id: cliente.id,
          identificacion: cliente.identificacion,
          razonSocial: cliente.razonSocial,
          telefono: cliente.telefono,
          nodo: cliente.nodo?.nombre ?? "",
          direccionIp: cliente.direccionIp!,
        });
      }
    }

    res.json({ estado, total: resultado.length, clientes: resultado, nodosConError });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el reporte de clientes por estado" });
  }
});
