// Router de solo lectura para reportería sobre Pago — no hay una entidad
// "Pago" administrable por sí sola (siempre se crea anidada bajo /facturas,
// /compras o /notas-venta, ver utils/pagos.ts), pero el Reporteador Principal
// necesita listar los movimientos bancarios (TRANSFERENCIA/TARJETA/CHEQUE) de
// TODOS los orígenes en una sola vista, así que este es el único endpoint
// que existe hoy sobre este router.
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerRangoFechas } from "../utils/rangoFechas";

export const pagosRouter = Router();

const INCLUDE_PAGO_BANCARIO = {
  cuentaBancaria: true,
  bancoOrigen: true,
  cuota: { select: { numero: true } },
  factura: { select: { secuencial: true, cliente: { select: { razonSocial: true } } } },
  notaVenta: { select: { secuencial: true, cliente: { select: { razonSocial: true } } } },
  compra: { select: { numeroFactura: true, proveedor: { select: { razonSocial: true } } } },
} as const;

// GET /pagos/bancarios?desde=&hasta=
// Todo Pago con formaPago TRANSFERENCIA/TARJETA/CHEQUE, sin importar si es un
// cobro (Factura/NotaVenta) o un pago a proveedor (Compra) — el frontend
// distingue el tipo según cuál de esas 3 relaciones viene no-nula.
pagosRouter.get("/bancarios", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.PagoWhereInput = {
      formaPago: { in: ["TRANSFERENCIA", "TARJETA", "CHEQUE"] },
      // Pagos registrados ANTES de que existiera el catálogo de cuentas
      // bancarias no tienen cuentaBancariaId — quedan fuera de este reporte
      // (no hay nada que conciliar sin saber a qué cuenta fueron) en vez de
      // llegar al frontend con cuentaBancaria en null.
      cuentaBancariaId: { not: null },
      ...(rango ? { fecha: rango } : {}),
    };
    const opciones = { where, include: INCLUDE_PAGO_BANCARIO, orderBy: { fecha: "desc" as const } };

    if (!paginacion.aplica) {
      const pagos = await prisma.pago.findMany(opciones);
      return res.json(pagos);
    }

    const [pagos, total] = await Promise.all([
      prisma.pago.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.pago.count({ where }),
    ]);
    res.json(respuestaPaginada(pagos, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los movimientos bancarios" });
  }
});
