// Rutas de DEVOLUCIÓN A PROVEEDOR: el espejo de NotaCredito, pero del lado de
// compras. Permite devolver solo ALGUNAS unidades de una compra (ej. 2
// defectuosas de 10), a diferencia de PATCH /compras/:id/anular que anula el
// documento completo y se bloquea si ya se usó cualquier parte del stock.
//
// A diferencia de NotaCredito (documento electrónico real que esta empresa
// emite y envía al SRI), esto es un registro puramente interno: el proveedor
// ya emitió su propio soporte de la devolución, igual que Compra ya es un
// registro interno de lo que el proveedor facturó. Por eso no tiene
// claveAcceso ni estado (mismo criterio que RetencionRecibida).
import { Router, Request, Response } from "express";
import { prisma, empresaActiva } from "../db";
import { Prisma } from "@prisma/client";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerRangoFechas } from "../utils/rangoFechas";
import { generarReciboDevolucionCompraPdf } from "../utils/generarReciboDevolucionCompra";
import { registrarAuditoria } from "../utils/auditoria";
import { lineasPorDevolucionCompra } from "../utils/contabilidad";
import { crearAsiento } from "../utils/asientos";
import { actualizarCostoPromedio } from "../utils/costeoInventario";

export const devolucionesCompraRouter = Router();

const INCLUDE_DEVOLUCION = {
  detalles: { include: { producto: true } },
  compra: { include: { proveedor: true } },
} as const;

// GET /devoluciones-compra
// Sin "?page=" trae TODAS. Con "?page=" pagina.
devolucionesCompraRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.DevolucionCompraWhereInput = rango ? { fechaEmision: rango } : {};
    const opciones = { where, include: INCLUDE_DEVOLUCION, orderBy: { fechaEmision: "desc" as const } };

    if (!paginacion.aplica) {
      const devoluciones = await prisma.devolucionCompra.findMany(opciones);
      return res.json(devoluciones);
    }

    const [devoluciones, total] = await Promise.all([
      prisma.devolucionCompra.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.devolucionCompra.count({ where }),
    ]);
    res.json(respuestaPaginada(devoluciones, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar devoluciones a proveedor" });
  }
});

// GET /devoluciones-compra/:id
devolucionesCompraRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const devolucion = await prisma.devolucionCompra.findUnique({ where: { id }, include: INCLUDE_DEVOLUCION });
    if (!devolucion) return res.status(404).json({ error: "Devolución no encontrada" });
    res.json(devolucion);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar la devolución" });
  }
});

// GET /devoluciones-compra/:id/recibo
devolucionesCompraRouter.get("/:id/recibo", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const devolucion = await prisma.devolucionCompra.findUnique({ where: { id }, include: INCLUDE_DEVOLUCION });
    if (!devolucion) return res.status(404).json({ error: "Devolución no encontrada" });

    const empresa = empresaActiva();
    const pdfBytes = await generarReciboDevolucionCompraPdf(
      {
        secuencial: devolucion.secuencial,
        fechaEmision: devolucion.fechaEmision,
        motivo: devolucion.motivo,
        subtotal0: devolucion.subtotal0,
        subtotal12: devolucion.subtotal12,
        iva: devolucion.iva,
        total: devolucion.total,
        proveedor: devolucion.compra.proveedor,
        detalles: devolucion.detalles,
        compraOrigen: { numeroFactura: devolucion.compra.numeroFactura },
      },
      { ruc: empresa.ruc, razonSocial: empresa.razonSocial, dirMatriz: empresa.direccionMatriz }
    );

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="devolucion-${devolucion.secuencial}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el recibo: " + error.message });
  }
});

// POST /devoluciones-compra
// Body: { compraId: number, motivo: string, items: [{ productoId, cantidad }] }
//
// "items" define QUÉ se devuelve y CUÁNTO — puede ser toda la compra o solo
// algunos productos/cantidades (devolución parcial). Los costos SIEMPRE se
// prorratean de la compra original, nunca del costo actual del producto —
// mismo criterio que NotaCredito con Factura.
devolucionesCompraRouter.post("/", async (req: Request, res: Response) => {
  const { compraId, motivo, items } = req.body as {
    compraId: number;
    motivo: string;
    items: { productoId: number; cantidad: number }[];
  };

  if (!compraId || !motivo || !items || items.length === 0) {
    return res.status(400).json({ error: "compraId, motivo e items son obligatorios" });
  }

  try {
    const nuevaDevolucion = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const compra = await tx.compra.findUnique({
        where: { id: compraId },
        include: { detalles: { include: { devolucionesDetalle: true } }, proveedor: true },
      });

      if (!compra) throw new Error("COMPRA_NO_ENCONTRADA");

      // Guarda que NotaCredito no necesita (una factura ANULADA no tiene
      // notas de crédito posibles porque nunca llegó a AUTORIZADA), pero acá
      // sí hace falta: sin esto se podría devolver stock que "anular" ya
      // había devuelto, dejándolo contado dos veces.
      if (compra.estado === "ANULADA") {
        throw new Error("COMPRA_ANULADA");
      }

      let subtotal0 = new Prisma.Decimal(0);
      let subtotal12 = new Prisma.Decimal(0);
      let ivaTotal = new Prisma.Decimal(0);
      const detallesData = [];

      for (const item of items) {
        if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
          throw new Error(`CANTIDAD_INVALIDA:${item.productoId}`);
        }

        // Buscamos la línea correspondiente en la compra ORIGINAL, para
        // prorratear su costo exacto — no aceptamos un costo nuevo del frontend.
        const detalleOriginal = compra.detalles.find((d: (typeof compra.detalles)[number]) => d.productoId === item.productoId);
        if (!detalleOriginal) throw new Error(`PRODUCTO_NO_EN_COMPRA:${item.productoId}`);

        // A diferencia de NotaCredito (que solo compara contra la cantidad
        // original de la línea): acá puede haber más de una devolución
        // parcial en el tiempo sobre la misma compra, así que hay que restar
        // lo ya devuelto antes de aceptar esta nueva cantidad.
        const yaDevuelto = detalleOriginal.devolucionesDetalle.reduce(
          (acc: number, d: (typeof detalleOriginal.devolucionesDetalle)[number]) => acc + d.cantidad,
          0
        );
        const disponibleParaDevolver = detalleOriginal.cantidad - yaDevuelto;
        if (item.cantidad > disponibleParaDevolver) {
          throw new Error(`CANTIDAD_EXCEDE:${item.productoId}:${disponibleParaDevolver}`);
        }

        const producto = await tx.producto.findUnique({ where: { id: item.productoId } });
        if (!producto) throw new Error(`PRODUCTO_NO_ENCONTRADO:${item.productoId}`);

        // Chequeo de stock disponible — mismo criterio que PATCH
        // /compras/:id/anular, pero solo contra la cantidad que se devuelve
        // ahora, no la cantidad original completa de la línea.
        if (producto.manejaLotes) {
          if (producto.stockActual < item.cantidad) {
            throw new Error(`STOCK_INSUFICIENTE:${producto.nombre}`);
          }
        } else {
          const stockLocal = await tx.stockBodega.findUnique({
            where: { productoId_bodegaId: { productoId: item.productoId, bodegaId: compra.bodegaId } },
          });
          if (!stockLocal || stockLocal.cantidad < item.cantidad) {
            throw new Error(`STOCK_INSUFICIENTE:${producto.nombre}`);
          }
        }

        // Prorrateo del costo unitario original (igual fórmula que NotaCredito)
        const costoUnitarioOriginal = detalleOriginal.subtotal.div(detalleOriginal.cantidad);
        const subtotalLinea = costoUnitarioOriginal.mul(item.cantidad);
        const ivaLinea = detalleOriginal.cantidad > 0
          ? detalleOriginal.ivaValor.div(detalleOriginal.cantidad).mul(item.cantidad)
          : new Prisma.Decimal(0);

        if (producto.ivaPorcentaje.gt(0)) {
          subtotal12 = subtotal12.add(subtotalLinea);
        } else {
          subtotal0 = subtotal0.add(subtotalLinea);
        }
        ivaTotal = ivaTotal.add(ivaLinea);

        detallesData.push({
          compraDetalleId: detalleOriginal.id,
          productoId: item.productoId,
          cantidad: item.cantidad,
          costoUnitario: costoUnitarioOriginal,
          subtotal: subtotalLinea,
          ivaValor: ivaLinea,
        });

        // Sacamos el stock: se lo devolvemos físicamente al proveedor. Nota:
        // igual que "anular" hoy, esto no ajusta LoteProducto.cantidad para
        // productos con lote (limitación ya existente ahí, no algo que esta
        // feature resuelve).
        const nuevoCostoPromedio = actualizarCostoPromedio(
          producto.stockActual,
          producto.costoPromedioActual,
          -item.cantidad,
          costoUnitarioOriginal
        );
        await tx.producto.update({
          where: { id: item.productoId },
          data: {
            stockActual: { decrement: item.cantidad },
            costoPromedioActual: nuevoCostoPromedio,
          },
        });
        if (!producto.manejaLotes) {
          await tx.stockSucursal.update({
            where: { productoId_sucursalId: { productoId: item.productoId, sucursalId: compra.sucursalId } },
            data: { cantidad: { decrement: item.cantidad } },
          });
          await tx.stockBodega.update({
            where: { productoId_bodegaId: { productoId: item.productoId, bodegaId: compra.bodegaId } },
            data: { cantidad: { decrement: item.cantidad } },
          });
        }
        await tx.movimientoInventario.create({
          data: {
            productoId: item.productoId,
            tipo: "SALIDA",
            cantidad: item.cantidad,
            motivo: `Devolución a proveedor - Compra Fact. ${compra.numeroFactura}`,
            sucursalId: producto.manejaLotes ? null : compra.sucursalId,
            bodegaId: producto.manejaLotes ? null : compra.bodegaId,
          },
        });
      }

      const total = subtotal0.add(subtotal12).add(ivaTotal);

      // Secuencial propio, interno (tipoComprobante "DC") — mismo criterio
      // que "NV"/"PRO", nunca pasa por el SRI.
      const secuencial = await tx.secuencial.upsert({
        where: {
          puntoVenta_establecimiento_tipoComprobante: {
            puntoVenta: "001",
            establecimiento: "001",
            tipoComprobante: "DC",
          },
        },
        create: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "DC", ultimoNumero: 1 },
        update: { ultimoNumero: { increment: 1 } },
      });

      const numeroFormateado = String(secuencial.ultimoNumero).padStart(9, "0");
      const secuencialTexto = `DC-001-001-${numeroFormateado}`;

      const devolucionCreada = await tx.devolucionCompra.create({
        data: {
          secuencial: secuencialTexto,
          motivo,
          compraId,
          subtotal0,
          subtotal12,
          iva: ivaTotal,
          total,
          detalles: { create: detallesData },
        },
        include: INCLUDE_DEVOLUCION,
      });

      await crearAsiento(tx, {
        origen: "DEVOLUCION_COMPRA",
        origenId: devolucionCreada.id,
        descripcion: `Devolución ${secuencialTexto} contra compra Fact. ${compra.numeroFactura}`,
        lineas: lineasPorDevolucionCompra({ subtotal0, subtotal12, iva: ivaTotal }),
        usuarioId: req.usuario!.usuarioId,
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "CREAR_DEVOLUCION_COMPRA",
        entidad: "DevolucionCompra",
        entidadId: devolucionCreada.id,
        detalle: `Devolución ${secuencialTexto} contra compra Fact. ${compra.numeroFactura} (${compra.proveedor.razonSocial}): ${motivo}`,
      });

      return devolucionCreada;
    });

    res.status(201).json(nuevaDevolucion);
  } catch (error: any) {
    if (error.message === "COMPRA_NO_ENCONTRADA") {
      return res.status(404).json({ error: "La compra no existe" });
    }
    if (error.message === "COMPRA_ANULADA") {
      return res.status(409).json({ error: "No se puede devolver mercadería de una compra anulada" });
    }
    if (typeof error.message === "string" && error.message.startsWith("CANTIDAD_INVALIDA")) {
      return res.status(400).json({ error: "La cantidad a devolver de cada producto debe ser un entero mayor a 0" });
    }
    if (typeof error.message === "string" && error.message.startsWith("PRODUCTO_NO_EN_COMPRA")) {
      return res.status(400).json({ error: "Uno de los productos no pertenece a esa compra" });
    }
    if (typeof error.message === "string" && error.message.startsWith("CANTIDAD_EXCEDE")) {
      const [, , disponible] = error.message.split(":");
      return res.status(400).json({ error: `No puedes devolver más cantidad de la disponible (quedan ${disponible} por devolver en esa línea)` });
    }
    if (typeof error.message === "string" && error.message.startsWith("PRODUCTO_NO_ENCONTRADO")) {
      return res.status(404).json({ error: `Producto no encontrado: ${error.message.split(":")[1]}` });
    }
    if (typeof error.message === "string" && error.message.startsWith("STOCK_INSUFICIENTE")) {
      return res.status(409).json({ error: `No se puede devolver: ya se usó/vendió parte del stock de "${error.message.split(":")[1]}"` });
    }
    console.error(error);
    res.status(500).json({ error: "Error al registrar la devolución" });
  }
});
