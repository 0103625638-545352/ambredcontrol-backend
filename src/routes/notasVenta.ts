// Rutas para NOTAS DE VENTA: comprobantes de venta internos, para clientes
// que no necesitan una factura formal. A diferencia de /facturas, esta ruta
// NUNCA habla con el SRI — no hay clave de acceso, no hay firma, no hay
// "enviar-sri". Es, a propósito, un flujo mucho más simple.

import { Router, Request, Response } from "express";
import { prisma, empresaActiva } from "../db";
import { Prisma } from "@prisma/client";
import { generarReciboNotaVentaPdf } from "../utils/generarReciboNotaVenta";
import { generarReciboTermicoPdf } from "../utils/generarReciboTermico";
import { requirePermiso } from "../middleware/auth";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { calcularEstadoPago } from "../utils/estadoPago";
import { descontarStockVenta } from "../utils/descontarStockVenta";
import { registrarAuditoria } from "../utils/auditoria";
import { sucursalDelUsuarioActual } from "../utils/sucursales";
import { bodegaValidaEnSucursal } from "../utils/bodegas";
import { cajaAbiertaDelUsuarioActual } from "../utils/cajaSesionActual";
import { leerRangoFechas } from "../utils/rangoFechas";
import { precioParaCliente } from "../utils/precios";
import { lineasPorVenta, lineasPorCostoVenta } from "../utils/contabilidad";
import { crearAsiento, revertirAsientoDeOrigen } from "../utils/asientos";
import { crearPagoConAsiento } from "../utils/pagos";
import { validarPlanCuotas, type CuotaInput } from "../utils/cuotas";

export const notasVentaRouter = Router();

interface ItemCarrito {
  productoId: number;
  cantidad: number;
  descuento?: number;
}

interface CrearNotaVentaBody {
  clienteId: number;
  bodegaId: number;
  items: ItemCarrito[];
  aplicaIva?: boolean; // en Ecuador, la nota de venta normalmente NO desglosa IVA
  fechaVencimiento?: string; // opcional: solo tiene sentido si la venta queda con saldo pendiente
  // OJO: el plan de cuotas NO se crea acá — se crea en POST /:id/pagos,
  // junto con el abono inicial (ver el comentario en ese handler más abajo).
}

// GET /notas-venta
// La lista no trae "detalles" (las líneas) — NotasVentaPage solo necesita el
// resumen; el detalle completo se pide aparte con GET /:id.
notasVentaRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.NotaVentaWhereInput = rango ? { fechaEmision: rango } : {};
    const opciones = {
      where,
      include: { cliente: true },
      orderBy: { fechaEmision: "desc" as const },
    };

    if (!paginacion.aplica) {
      const notasVenta = await prisma.notaVenta.findMany(opciones);
      return res.json(notasVenta);
    }

    const [notasVenta, total] = await Promise.all([
      prisma.notaVenta.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.notaVenta.count({ where }),
    ]);
    res.json(respuestaPaginada(notasVenta, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar notas de venta" });
  }
});

// GET /notas-venta/:id
notasVentaRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const notaVenta = await prisma.notaVenta.findUnique({
      where: { id },
      include: {
        cliente: true,
        detalles: { include: { producto: true } },
        pagos: { orderBy: { fecha: "desc" }, include: { cuentaBancaria: true, bancoOrigen: true, cuota: { select: { numero: true } } } },
        cuotas: { orderBy: { numero: "asc" } },
      },
    });
    if (!notaVenta) return res.status(404).json({ error: "Nota de venta no encontrada" });
    res.json(notaVenta);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar la nota de venta" });
  }
});

// POST /notas-venta/:id/pagos
// Registra un abono contra esta nota de venta — igual que en Factura, porque
// una nota de venta también se puede vender "al fiado" y quedar pendiente de cobro.
notasVentaRouter.post("/:id/pagos", requirePermiso("ventas"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const {
      monto,
      formaPago,
      referencia,
      cuentaBancariaId,
      bancoOrigenId,
      numeroCuentaOrigen,
      tarjetaUltimosDigitos,
      tarjetaTipo,
      tarjetaReferencia,
      tarjetaLote,
      chequeNumero,
      chequeFechaCobro,
      cuotas,
    } = req.body;

    if (typeof monto !== "number" || monto <= 0) {
      return res.status(400).json({ error: "monto debe ser un número mayor a 0" });
    }
    if (!formaPago) {
      return res.status(400).json({ error: "formaPago es obligatorio" });
    }
    if (cuotas && cuotas.length > 0) {
      try {
        validarPlanCuotas(cuotas);
      } catch (error: any) {
        if (error.message === "CUOTAS_VACIAS") return res.status(400).json({ error: "El plan de cuotas no puede estar vacío" });
        if (error.message === "CUOTAS_NUMERO_INVALIDO") {
          return res.status(400).json({ error: "Las cuotas deben numerarse 1, 2, 3... sin saltos ni repetidos" });
        }
        if (error.message === "CUOTAS_MONTO_INVALIDO") return res.status(400).json({ error: "El monto de cada cuota debe ser mayor a 0" });
        if (error.message === "CUOTAS_FECHA_INVALIDA") return res.status(400).json({ error: "Cada cuota necesita una fecha de vencimiento válida" });
        throw error;
      }
    }
    const exigeCuentaBancaria = ["TRANSFERENCIA", "TARJETA", "CHEQUE"].includes(formaPago);
    if (exigeCuentaBancaria) {
      if (!cuentaBancariaId) {
        return res.status(400).json({ error: "cuentaBancariaId es obligatorio para esta forma de pago" });
      }
      const cuenta = await prisma.cuentaBancaria.findUnique({ where: { id: cuentaBancariaId } });
      if (!cuenta || !cuenta.activa) {
        return res.status(400).json({ error: "La cuenta bancaria indicada no existe o está inactiva" });
      }
    }

    const notaVenta = await prisma.notaVenta.findUnique({ where: { id } });
    if (!notaVenta) return res.status(404).json({ error: "Nota de venta no encontrada" });
    if (notaVenta.estado === "ANULADA") {
      return res.status(409).json({ error: "No se puede registrar un pago sobre una nota de venta anulada" });
    }

    const saldoPendiente = notaVenta.total.sub(notaVenta.montoPagado);
    const montoDecimal = new Prisma.Decimal(monto);
    if (montoDecimal.gt(saldoPendiente)) {
      return res.status(400).json({ error: `El monto supera el saldo pendiente ($${saldoPendiente.toFixed(2)})` });
    }

    // Si esta nota de venta tiene un plan de Cuotas, el cobro es ESTRICTO:
    // solo se puede pagar la próxima cuota pendiente (en orden), por su
    // monto EXACTO — mismo criterio que registrarPagoDeFactura en facturas.ts.
    const proximaCuota = await prisma.cuota.findFirst({
      where: { notaVentaId: id, estado: "PENDIENTE" },
      orderBy: { numero: "asc" },
    });
    if (proximaCuota && !montoDecimal.equals(proximaCuota.monto)) {
      return res.status(400).json({
        error: `Este documento tiene un plan de cuotas: hay que pagar la cuota ${proximaCuota.numero} por $${proximaCuota.monto.toFixed(2)} exacto, en orden`,
      });
    }

    const notaVentaActualizada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await crearPagoConAsiento(tx, {
        notaVentaId: id,
        monto: montoDecimal,
        formaPago,
        referencia,
        cuentaBancariaId: exigeCuentaBancaria ? cuentaBancariaId : undefined,
        cuotaId: proximaCuota?.id,
        bancoOrigenId,
        numeroCuentaOrigen,
        tarjetaUltimosDigitos,
        tarjetaTipo,
        tarjetaReferencia,
        tarjetaLote,
        chequeNumero,
        chequeFechaCobro,
        descripcion: `Cobro nota de venta ${notaVenta.secuencial}`,
        usuarioId: req.usuario!.usuarioId,
      });
      if (proximaCuota) {
        await tx.cuota.update({ where: { id: proximaCuota.id }, data: { estado: "PAGADA" } });
      }
      // El plan de cuotas del SALDO RESTANTE se crea acá, DESPUÉS de aplicar
      // este pago — mismo criterio que registrarPagoDeFactura en
      // facturas.ts (ver el porqué en el comentario de ese archivo).
      if (cuotas && cuotas.length > 0) {
        await tx.cuota.createMany({
          data: cuotas.map((c: CuotaInput) => ({
            notaVentaId: id,
            numero: c.numero,
            monto: c.monto,
            fechaVencimiento: new Date(c.fechaVencimiento),
          })),
        });
      }
      const nuevoMontoPagado = notaVenta.montoPagado.add(montoDecimal);
      return tx.notaVenta.update({
        where: { id },
        data: { montoPagado: nuevoMontoPagado, estadoPago: calcularEstadoPago(nuevoMontoPagado, notaVenta.total) },
        include: {
          pagos: { orderBy: { fecha: "desc" }, include: { cuentaBancaria: true, bancoOrigen: true, cuota: { select: { numero: true } } } },
          cuotas: { orderBy: { numero: "asc" } },
        },
      });
    });

    res.status(201).json(notaVentaActualizada);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar el pago" });
  }
});

// DELETE /notas-venta/:id/pagos/:pagoId
// Corrige un pago mal registrado — mismo patrón que en Factura/Compra.
notasVentaRouter.delete("/:id/pagos/:pagoId", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const pagoId = Number(req.params.pagoId);

    const notaVenta = await prisma.notaVenta.findUnique({ where: { id } });
    if (!notaVenta) return res.status(404).json({ error: "Nota de venta no encontrada" });

    const pago = await prisma.pago.findUnique({ where: { id: pagoId } });
    if (!pago || pago.notaVentaId !== id) {
      return res.status(404).json({ error: "Pago no encontrado" });
    }

    const notaVentaActualizada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.pago.delete({ where: { id: pagoId } });
      // Si este pago había liquidado una Cuota, la reabrimos — mismo
      // criterio que en facturas.ts.
      if (pago.cuotaId) {
        await tx.cuota.update({ where: { id: pago.cuotaId }, data: { estado: "PENDIENTE" } });
      }
      await revertirAsientoDeOrigen(tx, "PAGO", pagoId, req.usuario!.usuarioId);
      const nuevoMontoPagado = notaVenta.montoPagado.sub(pago.monto);
      const actualizada = await tx.notaVenta.update({
        where: { id },
        data: { montoPagado: nuevoMontoPagado, estadoPago: calcularEstadoPago(nuevoMontoPagado, notaVenta.total) },
        include: {
          pagos: { orderBy: { fecha: "desc" }, include: { cuentaBancaria: true, bancoOrigen: true, cuota: { select: { numero: true } } } },
          cuotas: { orderBy: { numero: "asc" } },
        },
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "ELIMINAR_PAGO",
        entidad: "NotaVenta",
        entidadId: id,
        detalle: `Nota de venta ${notaVenta.secuencial}: pago de $${pago.monto.toFixed(2)} (${pago.formaPago})`,
      });

      return actualizada;
    });

    res.json(notaVentaActualizada);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al eliminar el pago" });
  }
});

// GET /notas-venta/:id/recibo
// Genera y descarga el PDF del recibo (no es un RIDE: esto nunca pasó por el SRI).
notasVentaRouter.get("/:id/recibo", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const notaVenta = await prisma.notaVenta.findUnique({
      where: { id },
      include: { cliente: true, detalles: { include: { producto: true } } },
    });
    if (!notaVenta) return res.status(404).json({ error: "Nota de venta no encontrada" });

    const empresa = empresaActiva();
    const pdfBytes = await generarReciboNotaVentaPdf(
      {
        secuencial: notaVenta.secuencial,
        fechaEmision: notaVenta.fechaEmision,
        aplicaIva: notaVenta.aplicaIva,
        subtotal0: notaVenta.subtotal0,
        subtotal12: notaVenta.subtotal12,
        iva: notaVenta.iva,
        total: notaVenta.total,
        estado: notaVenta.estado,
        cliente: notaVenta.cliente,
        detalles: notaVenta.detalles,
      },
      { ruc: empresa.ruc, razonSocial: empresa.razonSocial, dirMatriz: empresa.direccionMatriz }
    );

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="nota-venta-${notaVenta.secuencial}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el recibo: " + error.message });
  }
});

// GET /notas-venta/:id/recibo-termico
// Igual que /recibo, pero en un PDF angosto (80mm) para impresora térmica.
notasVentaRouter.get("/:id/recibo-termico", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const notaVenta = await prisma.notaVenta.findUnique({
      where: { id },
      include: { cliente: true, detalles: { include: { producto: true } } },
    });
    if (!notaVenta) return res.status(404).json({ error: "Nota de venta no encontrada" });

    const empresa = empresaActiva();
    const pdfBytes = await generarReciboTermicoPdf(
      {
        tipoDocumento: "NOTA DE VENTA",
        secuencial: notaVenta.secuencial,
        claveAcceso: null, // la nota de venta nunca pasa por el SRI
        fechaEmision: notaVenta.fechaEmision,
        estado: notaVenta.estado,
        cliente: notaVenta.cliente,
        detalles: notaVenta.detalles.map((d: (typeof notaVenta.detalles)[number]) => ({
          nombre: d.producto.nombre,
          cantidad: d.cantidad,
          precioUnitario: d.precioUnitario,
          subtotal: d.subtotal,
        })),
        subtotal0: notaVenta.subtotal0,
        subtotal12: notaVenta.subtotal12,
        iva: notaVenta.iva,
        total: notaVenta.total,
        notaPie: "Comprobante interno. NO constituye un comprobante electrónico autorizado por el SRI.",
      },
      { ruc: empresa.ruc, razonSocial: empresa.razonSocial, dirMatriz: empresa.direccionMatriz }
    );

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="nota-venta-${notaVenta.secuencial}-termico.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el recibo térmico: " + error.message });
  }
});

// POST /notas-venta
// Body esperado: { clienteId: number, items: [{ productoId, cantidad, descuento? }] }
notasVentaRouter.post("/", requirePermiso("ventas"), async (req: Request, res: Response) => {
  const { clienteId, bodegaId, items, aplicaIva, fechaVencimiento } = req.body as CrearNotaVentaBody;

  if (!clienteId || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "clienteId e items (con al menos 1 producto) son obligatorios" });
  }

  // Por defecto NO se aplica IVA (así es como funciona una nota de venta en
  // Ecuador); solo se calcula si el cliente del POST lo pide explícitamente.
  const seAplicaIva = aplicaIva === true;

  try {
    const sucursal = await sucursalDelUsuarioActual(req.usuario!.usuarioId);
    await bodegaValidaEnSucursal(bodegaId, sucursal.id);
    const cajaAbierta = await cajaAbiertaDelUsuarioActual(req.usuario!.usuarioId);

    const notaVenta = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const cliente = await tx.cliente.findUnique({ where: { id: clienteId }, include: { tipoPrecio: true } });
      if (!cliente) throw new Error("CLIENTE_NO_ENCONTRADO");

      let subtotal0 = new Prisma.Decimal(0);
      let subtotal12 = new Prisma.Decimal(0);
      let ivaTotal = new Prisma.Decimal(0);
      let costoVentaTotal = new Prisma.Decimal(0);

      const detallesData = [];

      for (const item of items) {
        if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
          throw new Error(`CANTIDAD_INVALIDA:${item.productoId}`);
        }

        const producto = await tx.producto.findUnique({ where: { id: item.productoId } });
        if (!producto) throw new Error(`PRODUCTO_NO_ENCONTRADO:${item.productoId}`);

        if (producto.manejaLotes) {
          if (producto.stockActual < item.cantidad) {
            throw new Error(`STOCK_INSUFICIENTE:${producto.nombre}`);
          }
        } else {
          const stockLocal = await tx.stockBodega.findUnique({
            where: { productoId_bodegaId: { productoId: producto.id, bodegaId } },
          });
          if (!stockLocal || stockLocal.cantidad < item.cantidad) {
            throw new Error(`STOCK_INSUFICIENTE:${producto.nombre}`);
          }
        }

        const descuento = new Prisma.Decimal(item.descuento ?? 0);
        const precioUnitario = precioParaCliente(producto, cliente);
        if (precioUnitario === null) {
          throw new Error(`SIN_COSTO_PRODUCTO:${producto.nombre}`);
        }
        const bruto = precioUnitario.mul(item.cantidad).sub(descuento);
        // Si esta nota de venta NO aplica IVA, tratamos la línea como si fuera
        // 0% sin importar la tarifa configurada en el producto — la nota de
        // venta, a diferencia de la factura, no está obligada a desglosar IVA.
        const ivaPorcentaje = seAplicaIva ? producto.ivaPorcentaje : new Prisma.Decimal(0);
        const ivaValor = ivaPorcentaje.gt(0) ? bruto.mul(ivaPorcentaje).div(100) : new Prisma.Decimal(0);

        if (ivaPorcentaje.gt(0)) {
          subtotal12 = subtotal12.add(bruto);
        } else {
          subtotal0 = subtotal0.add(bruto);
        }
        ivaTotal = ivaTotal.add(ivaValor);
        // costoPromedioActual no puede ser null acá: si lo fuera,
        // precioParaCliente ya habría devuelto null y disparado
        // SIN_COSTO_PRODUCTO más arriba, antes de llegar a esta línea.
        costoVentaTotal = costoVentaTotal.add(producto.costoPromedioActual!.mul(item.cantidad));

        detallesData.push({
          productoId: producto.id,
          cantidad: item.cantidad,
          precioUnitario,
          descuento,
          subtotal: bruto,
          ivaValor,
        });

        await descontarStockVenta(tx, producto, item.cantidad, "Venta - nota de venta", sucursal.id, bodegaId);
      }

      const total = subtotal0.add(subtotal12).add(ivaTotal);

      // Secuencial propio para notas de venta ("NV"), independiente del de facturas.
      const secuencial = await tx.secuencial.upsert({
        where: {
          puntoVenta_establecimiento_tipoComprobante: {
            puntoVenta: "001",
            establecimiento: "001",
            tipoComprobante: "NV",
          },
        },
        create: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "NV", ultimoNumero: 1 },
        update: { ultimoNumero: { increment: 1 } },
      });

      const numeroFormateado = String(secuencial.ultimoNumero).padStart(9, "0");
      const secuencialTexto = `001-001-${numeroFormateado}`;

      const notaVentaCreada = await tx.notaVenta.create({
        data: {
          secuencial: secuencialTexto,
          clienteId,
          sucursalId: sucursal.id,
          bodegaId,
          puntoVentaId: cajaAbierta?.puntoVentaId ?? null,
          aplicaIva: seAplicaIva,
          subtotal0,
          subtotal12,
          iva: ivaTotal,
          total,
          fechaVencimiento: fechaVencimiento ? new Date(fechaVencimiento) : undefined,
          detalles: { create: detallesData },
        },
        include: { detalles: { include: { producto: true } }, cliente: true },
      });

      await crearAsiento(tx, {
        origen: "NOTA_VENTA",
        origenId: notaVentaCreada.id,
        descripcion: `Nota de venta ${secuencialTexto}`,
        lineas: [...lineasPorVenta({ subtotal0, subtotal12, iva: ivaTotal, total }), ...lineasPorCostoVenta(costoVentaTotal)],
        usuarioId: req.usuario!.usuarioId,
      });

      return notaVentaCreada;
    });

    res.status(201).json(notaVenta);
  } catch (error: any) {
    if (error.message === "SIN_SUCURSAL_ASIGNADA") {
      return res.status(400).json({ error: "Tu usuario no tiene una sucursal asignada — pídele a un administrador que te asigne una" });
    }
    if (error.message === "BODEGA_OBLIGATORIA") {
      return res.status(400).json({ error: "Debes elegir una bodega" });
    }
    if (error.message === "BODEGA_NO_ENCONTRADA") {
      return res.status(400).json({ error: "La bodega indicada no existe o está inactiva" });
    }
    if (error.message === "BODEGA_NO_PERTENECE_A_SUCURSAL") {
      return res.status(400).json({ error: "Esa bodega no pertenece a tu sucursal" });
    }
    if (error.message === "CLIENTE_NO_ENCONTRADO") {
      return res.status(404).json({ error: "El cliente no existe" });
    }
    if (typeof error.message === "string" && error.message.startsWith("CANTIDAD_INVALIDA")) {
      return res.status(400).json({ error: "La cantidad de cada producto debe ser un entero mayor a 0" });
    }
    if (typeof error.message === "string" && error.message.startsWith("PRODUCTO_NO_ENCONTRADO")) {
      return res.status(404).json({ error: `Producto no encontrado: ${error.message.split(":")[1]}` });
    }
    if (typeof error.message === "string" && error.message.startsWith("STOCK_INSUFICIENTE")) {
      return res.status(409).json({ error: `Stock insuficiente para: ${error.message.split(":")[1]}` });
    }
    if (typeof error.message === "string" && error.message.startsWith("SIN_COSTO_PRODUCTO")) {
      return res.status(400).json({
        error: `"${error.message.split(":")[1]}" no tiene costo registrado todavía (compra pendiente) — no se puede vender`,
      });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear la nota de venta" });
  }
});

// PATCH /notas-venta/:id/anular
// Como la nota de venta nunca pasa por el SRI, se puede anular mientras no
// esté ya anulada (a diferencia de Factura, no hay estados "ENVIADA/AUTORIZADA"
// que lo impidan).
notasVentaRouter.patch("/:id/anular", requirePermiso("facturas_anular"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    const notaVenta = await prisma.notaVenta.findUnique({
      where: { id },
      include: { detalles: { include: { producto: true } } },
    });

    if (!notaVenta) return res.status(404).json({ error: "Nota de venta no encontrada" });

    if (notaVenta.estado === "ANULADA") {
      return res.status(409).json({ error: "Esta nota de venta ya está anulada" });
    }

    const notaVentaAnulada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const detalle of notaVenta.detalles) {
        await tx.producto.update({
          where: { id: detalle.productoId },
          data: { stockActual: { increment: detalle.cantidad } },
        });
        if (!detalle.producto.manejaLotes) {
          await tx.stockSucursal.update({
            where: { productoId_sucursalId: { productoId: detalle.productoId, sucursalId: notaVenta.sucursalId } },
            data: { cantidad: { increment: detalle.cantidad } },
          });
          await tx.stockBodega.update({
            where: { productoId_bodegaId: { productoId: detalle.productoId, bodegaId: notaVenta.bodegaId } },
            data: { cantidad: { increment: detalle.cantidad } },
          });
        }
        await tx.movimientoInventario.create({
          data: {
            productoId: detalle.productoId,
            tipo: "ENTRADA",
            cantidad: detalle.cantidad,
            motivo: `Anulación de nota de venta ${notaVenta.secuencial}`,
            sucursalId: detalle.producto.manejaLotes ? null : notaVenta.sucursalId,
            bodegaId: detalle.producto.manejaLotes ? null : notaVenta.bodegaId,
          },
        });
      }

      const anulada = await tx.notaVenta.update({ where: { id }, data: { estado: "ANULADA" } });

      await revertirAsientoDeOrigen(tx, "NOTA_VENTA", id, req.usuario!.usuarioId);

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "ANULAR_NOTA_VENTA",
        entidad: "NotaVenta",
        entidadId: id,
        detalle: `Nota de venta ${notaVenta.secuencial}`,
      });

      return anulada;
    });

    res.json({ mensaje: "Nota de venta anulada y stock devuelto", notaVenta: notaVentaAnulada });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al anular la nota de venta" });
  }
});
