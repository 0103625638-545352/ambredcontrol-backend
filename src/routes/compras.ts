// Rutas de COMPRAS: el "reverso" de una factura. Registrar una compra
// aumenta el stock (en vez de disminuirlo) y archiva el comprobante que el
// PROVEEDOR ya emitió — por eso no hay clave de acceso ni secuencial propio,
// solo guardamos el número de documento tal cual viene del proveedor.
import { Router, Request, Response } from "express";
import { prisma, empresaActiva } from "../db";
import { Prisma } from "@prisma/client";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { generarReciboCompraPdf } from "../utils/generarReciboCompra";
import { calcularEstadoPago } from "../utils/estadoPago";
import { registrarAuditoria } from "../utils/auditoria";
import { sucursalDelUsuarioActual } from "../utils/sucursales";
import { bodegaValidaEnSucursal } from "../utils/bodegas";
import { cajaAbiertaDelUsuarioActual } from "../utils/cajaSesionActual";
import { leerRangoFechas } from "../utils/rangoFechas";
import { lineasPorCompra } from "../utils/contabilidad";
import { crearAsiento, revertirAsientoDeOrigen } from "../utils/asientos";
import { crearPagoConAsiento } from "../utils/pagos";
import { validarPlanCuotas, type CuotaInput } from "../utils/cuotas";
import { totalDevueltoDeCompra } from "../utils/devolucionesCompra";
import { actualizarCostoPromedio } from "../utils/costeoInventario";

export const comprasRouter = Router();

interface ItemCompra {
  productoId: number;
  cantidad: number;
  costoUnitario: number;
  // Obligatorios solo si el producto tiene manejaLotes=true: esa cantidad
  // entra como un lote nuevo, con su propia caducidad.
  fechaCaducidad?: string;
  numeroLote?: string;
}

interface CrearCompraBody {
  proveedorId: number;
  numeroFactura: string;
  bodegaId: number;
  items: ItemCompra[];
  fechaVencimiento?: string; // opcional: toda compra arranca sin pagar, así que siempre tiene sentido preguntarlo
  cuotas?: CuotaInput[]; // plan de pago a plazos al proveedor, ver modelo Cuota
  // Código de la tabla "Sustento Tributario" del SRI (ver el comentario del
  // campo en schema.prisma) — obligatorio para compras nuevas, así el ATS
  // (ver GET /reportes/ats) ya no sale con esta columna vacía.
  sustentoTributario: string;
}

// GET /compras
// Sin "?page=" trae TODAS. Con "?page=" pagina (tabla de historial de Compras).
comprasRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.CompraWhereInput = rango ? { fechaEmision: rango } : {};
    const opciones = {
      where,
      include: {
        proveedor: true,
        retencion: { select: { id: true, secuencial: true, claveAcceso: true, estado: true, total: true } },
      },
      orderBy: { fechaEmision: "desc" as const },
    };

    if (!paginacion.aplica) {
      const compras = await prisma.compra.findMany(opciones);
      return res.json(compras);
    }

    const [compras, total] = await Promise.all([
      prisma.compra.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.compra.count({ where }),
    ]);
    res.json(respuestaPaginada(compras, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar compras" });
  }
});

// GET /compras/pendientes-serie
// Líneas de compra de productos que controlan número de serie
// (Producto.controlaNumeroSerie) a las que bodega todavía no les capturó
// todas las series — ver POST /compras/detalles/:compraDetalleId/series.
// Registrado ANTES de "GET /:id" a propósito: si fuera después, Express
// probaría primero "/:id" con id="pendientes-serie" (calza igual de bien
// como parámetro) y esta ruta nunca se alcanzaría.
comprasRouter.get("/pendientes-serie", async (req: Request, res: Response) => {
  try {
    const detalles = await prisma.compraDetalle.findMany({
      where: { producto: { controlaNumeroSerie: true } },
      include: {
        producto: { select: { id: true, nombre: true, codigo: true } },
        compra: { select: { id: true, numeroFactura: true, fechaEmision: true, estado: true, proveedor: { select: { razonSocial: true } } } },
        numerosSerie: { select: { id: true } },
      },
      orderBy: { compra: { fechaEmision: "desc" } },
    });

    const pendientes = detalles
      .filter((d) => d.compra.estado !== "ANULADA")
      .map((d) => ({
        compraDetalleId: d.id,
        compraId: d.compra.id,
        numeroFactura: d.compra.numeroFactura,
        proveedor: d.compra.proveedor.razonSocial,
        fechaEmision: d.compra.fechaEmision,
        producto: d.producto,
        cantidad: d.cantidad,
        capturadas: d.numerosSerie.length,
        faltantes: d.cantidad - d.numerosSerie.length,
      }))
      .filter((d) => d.faltantes > 0);

    res.json(pendientes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las líneas pendientes de serializar" });
  }
});

// POST /compras/detalles/:compraDetalleId/series
// Body: { series: string[] } — bodega captura de una vez los números de
// serie de esta línea (o parte de ellos; el resto queda pendiente para
// después). No se puede capturar más series que "faltantes" en esta línea.
comprasRouter.post("/detalles/:compraDetalleId/series", async (req: Request, res: Response) => {
  try {
    const compraDetalleId = Number(req.params.compraDetalleId);
    const series = req.body.series;
    if (!Array.isArray(series) || series.length === 0) {
      return res.status(400).json({ error: "Debes enviar al menos un número de serie" });
    }
    const limpias = series.map((s) => String(s).trim()).filter(Boolean);
    if (limpias.length !== series.length) {
      return res.status(400).json({ error: "Ningún número de serie puede quedar vacío" });
    }
    if (new Set(limpias).size !== limpias.length) {
      return res.status(400).json({ error: "Hay números de serie repetidos en la lista" });
    }

    const detalle = await prisma.compraDetalle.findUnique({
      where: { id: compraDetalleId },
      include: { producto: true, numerosSerie: true, compra: { select: { estado: true } } },
    });
    if (!detalle) return res.status(404).json({ error: "Línea de compra no encontrada" });
    if (detalle.compra.estado === "ANULADA") {
      return res.status(409).json({ error: "Esta compra está anulada" });
    }
    if (!detalle.producto.controlaNumeroSerie) {
      return res.status(400).json({ error: "Este producto no controla número de serie" });
    }
    const faltantes = detalle.cantidad - detalle.numerosSerie.length;
    if (limpias.length > faltantes) {
      return res.status(400).json({ error: `Solo faltan ${faltantes} serie(s) por capturar en esta línea` });
    }

    await prisma.numeroSerieProducto.createMany({
      data: limpias.map((numeroSerie) => ({
        productoId: detalle.productoId,
        compraDetalleId: detalle.id,
        numeroSerie,
      })),
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CAPTURAR_SERIES_COMPRA",
      entidad: "CompraDetalle",
      entidadId: detalle.id,
      detalle: `${detalle.producto.nombre}: +${limpias.length} serie(s) (${limpias.join(", ")})`,
    });

    res.status(201).json({ creadas: limpias.length });
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Alguno de esos números de serie ya está registrado para este producto" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al capturar los números de serie" });
  }
});

// GET /compras/:id
comprasRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const compra = await prisma.compra.findUnique({
      where: { id },
      include: {
        proveedor: true,
        detalles: { include: { producto: true, devolucionesDetalle: true } },
        pagos: { orderBy: { fecha: "desc" }, include: { cuentaBancaria: true, bancoOrigen: true, cuota: { select: { numero: true } } } },
        cuotas: { orderBy: { numero: "asc" } },
        retencion: { select: { id: true, secuencial: true, claveAcceso: true, estado: true, total: true } },
      },
    });
    if (!compra) return res.status(404).json({ error: "Compra no encontrada" });
    res.json(compra);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar la compra" });
  }
});

// POST /compras/:id/pagos
// Registra un abono a un proveedor — el reverso de POST /facturas/:id/pagos.
comprasRouter.post("/:id/pagos", async (req: Request, res: Response) => {
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
    } = req.body;

    if (typeof monto !== "number" || monto <= 0) {
      return res.status(400).json({ error: "monto debe ser un número mayor a 0" });
    }
    if (!formaPago) {
      return res.status(400).json({ error: "formaPago es obligatorio" });
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

    const compra = await prisma.compra.findUnique({ where: { id } });
    if (!compra) return res.status(404).json({ error: "Compra no encontrada" });
    if (compra.estado === "ANULADA") {
      return res.status(409).json({ error: "No se puede registrar un pago sobre una compra anulada" });
    }

    // DevolucionCompra nunca edita compra.total/montoPagado (el documento
    // original queda intacto, igual que NotaCredito nunca edita Factura.total)
    // — el saldo real se calcula restando lo ya devuelto acá.
    const saldoPendiente = compra.total.sub(compra.montoPagado).sub(await totalDevueltoDeCompra(prisma, id));
    const montoDecimal = new Prisma.Decimal(monto);
    if (montoDecimal.gt(saldoPendiente)) {
      return res.status(400).json({ error: `El monto supera el saldo pendiente ($${saldoPendiente.toFixed(2)})` });
    }

    // Si esta compra tiene un plan de Cuotas, el pago es ESTRICTO: solo se
    // puede pagar la próxima cuota pendiente (en orden), por su monto EXACTO
    // — mismo criterio que registrarPagoDeFactura en facturas.ts.
    const proximaCuota = await prisma.cuota.findFirst({
      where: { compraId: id, estado: "PENDIENTE" },
      orderBy: { numero: "asc" },
    });
    if (proximaCuota && !montoDecimal.equals(proximaCuota.monto)) {
      return res.status(400).json({
        error: `Esta compra tiene un plan de cuotas: hay que pagar la cuota ${proximaCuota.numero} por $${proximaCuota.monto.toFixed(2)} exacto, en orden`,
      });
    }

    const compraActualizada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await crearPagoConAsiento(tx, {
        compraId: id,
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
        descripcion: `Pago compra Fact. ${compra.numeroFactura}`,
        usuarioId: req.usuario!.usuarioId,
      });
      if (proximaCuota) {
        await tx.cuota.update({ where: { id: proximaCuota.id }, data: { estado: "PAGADA" } });
      }
      const nuevoMontoPagado = compra.montoPagado.add(montoDecimal);
      return tx.compra.update({
        where: { id },
        data: { montoPagado: nuevoMontoPagado, estadoPago: calcularEstadoPago(nuevoMontoPagado, compra.total) },
        include: {
          pagos: { orderBy: { fecha: "desc" }, include: { cuentaBancaria: true, bancoOrigen: true, cuota: { select: { numero: true } } } },
          cuotas: { orderBy: { numero: "asc" } },
        },
      });
    });

    res.status(201).json(compraActualizada);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar el pago" });
  }
});

// DELETE /compras/:id/pagos/:pagoId
// Corrige un pago mal registrado — el reverso de DELETE /facturas/:id/pagos/:pagoId.
comprasRouter.delete("/:id/pagos/:pagoId", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const pagoId = Number(req.params.pagoId);

    const compra = await prisma.compra.findUnique({ where: { id } });
    if (!compra) return res.status(404).json({ error: "Compra no encontrada" });

    const pago = await prisma.pago.findUnique({ where: { id: pagoId } });
    if (!pago || pago.compraId !== id) {
      return res.status(404).json({ error: "Pago no encontrado" });
    }

    const compraActualizada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.pago.delete({ where: { id: pagoId } });
      // Si este pago había liquidado una Cuota, la reabrimos — mismo
      // criterio que en facturas.ts/notasVenta.ts.
      if (pago.cuotaId) {
        await tx.cuota.update({ where: { id: pago.cuotaId }, data: { estado: "PENDIENTE" } });
      }
      await revertirAsientoDeOrigen(tx, "PAGO", pagoId, req.usuario!.usuarioId);
      const nuevoMontoPagado = compra.montoPagado.sub(pago.monto);
      const actualizada = await tx.compra.update({
        where: { id },
        data: { montoPagado: nuevoMontoPagado, estadoPago: calcularEstadoPago(nuevoMontoPagado, compra.total) },
        include: {
          pagos: { orderBy: { fecha: "desc" }, include: { cuentaBancaria: true, bancoOrigen: true, cuota: { select: { numero: true } } } },
          cuotas: { orderBy: { numero: "asc" } },
        },
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "ELIMINAR_PAGO",
        entidad: "Compra",
        entidadId: id,
        detalle: `Compra Fact. ${compra.numeroFactura}: pago de $${pago.monto.toFixed(2)} (${pago.formaPago})`,
      });

      return actualizada;
    });

    res.json(compraActualizada);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al eliminar el pago" });
  }
});

// GET /compras/:id/recibo
// Genera el PDF de soporte documental (no es un comprobante electrónico —
// la factura real la emitió el proveedor; esto solo respalda el registro).
comprasRouter.get("/:id/recibo", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const compra = await prisma.compra.findUnique({
      where: { id },
      include: { proveedor: true, detalles: { include: { producto: true } } },
    });
    if (!compra) return res.status(404).json({ error: "Compra no encontrada" });

    const empresa = empresaActiva();
    const pdfBytes = await generarReciboCompraPdf(
      {
        numeroFactura: compra.numeroFactura,
        fechaEmision: compra.fechaEmision,
        subtotal0: compra.subtotal0,
        subtotal12: compra.subtotal12,
        iva: compra.iva,
        total: compra.total,
        estado: compra.estado,
        proveedor: compra.proveedor,
        detalles: compra.detalles,
      },
      { ruc: empresa.ruc, razonSocial: empresa.razonSocial, dirMatriz: empresa.direccionMatriz }
    );

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="compra-${compra.numeroFactura}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el recibo: " + error.message });
  }
});

// POST /compras
// Body: { proveedorId, numeroFactura, items: [{ productoId, cantidad, costoUnitario }] }
// A diferencia de vender, cada línea SUMA stock y el movimiento de inventario
// queda como ENTRADA — el resto (transacción atómica, cálculo de IVA con
// Decimal) sigue el mismo patrón que /facturas y /notas-venta.
comprasRouter.post("/", async (req: Request, res: Response) => {
  const { proveedorId, numeroFactura, bodegaId, items, fechaVencimiento, cuotas, sustentoTributario } = req.body as CrearCompraBody;

  if (!proveedorId || !numeroFactura || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "proveedorId, numeroFactura e items (con al menos 1 producto) son obligatorios" });
  }
  if (!sustentoTributario || !sustentoTributario.trim()) {
    return res.status(400).json({ error: "sustentoTributario es obligatorio (código de la tabla del SRI, ej. 01, 06)" });
  }

  try {
    if (cuotas && cuotas.length > 0) validarPlanCuotas(cuotas);
    const sucursal = await sucursalDelUsuarioActual(req.usuario!.usuarioId);
    await bodegaValidaEnSucursal(bodegaId, sucursal.id);
    // Igual que en facturas/notas de venta: si quien registra la compra
    // tiene una caja abierta, el efectivo que sale por esta compra se resta
    // de esa caja puntual (ver utils/caja.ts) — sin esto, con varias cajas
    // abiertas a la vez en la misma sucursal no habría forma de saber a
    // cuál de todas restarle este gasto.
    const cajaAbierta = await cajaAbiertaDelUsuarioActual(req.usuario!.usuarioId);

    const compra = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const proveedor = await tx.proveedor.findUnique({ where: { id: proveedorId } });
      if (!proveedor) throw new Error("PROVEEDOR_NO_ENCONTRADO");

      let subtotal0 = new Prisma.Decimal(0);
      let subtotal12 = new Prisma.Decimal(0);
      let ivaTotal = new Prisma.Decimal(0);

      const detallesData = [];

      for (const item of items) {
        if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
          throw new Error(`CANTIDAD_INVALIDA:${item.productoId}`);
        }
        if (typeof item.costoUnitario !== "number" || item.costoUnitario < 0) {
          throw new Error(`COSTO_INVALIDO:${item.productoId}`);
        }

        const producto = await tx.producto.findUnique({ where: { id: item.productoId } });
        if (!producto) throw new Error(`PRODUCTO_NO_ENCONTRADO:${item.productoId}`);
        if (producto.manejaLotes && !item.fechaCaducidad) {
          throw new Error(`FALTA_CADUCIDAD:${producto.nombre}`);
        }

        const costoUnitario = new Prisma.Decimal(item.costoUnitario);
        const bruto = costoUnitario.mul(item.cantidad);
        const ivaPorcentaje = producto.ivaPorcentaje;
        const ivaValor = ivaPorcentaje.gt(0) ? bruto.mul(ivaPorcentaje).div(100) : new Prisma.Decimal(0);

        if (ivaPorcentaje.gt(0)) {
          subtotal12 = subtotal12.add(bruto);
        } else {
          subtotal0 = subtotal0.add(bruto);
        }
        ivaTotal = ivaTotal.add(ivaValor);

        detallesData.push({
          productoId: producto.id,
          cantidad: item.cantidad,
          costoUnitario,
          subtotal: bruto,
          ivaValor,
        });

        let loteProductoId: number | undefined;
        if (producto.manejaLotes) {
          const lote = await tx.loteProducto.create({
            data: {
              productoId: producto.id,
              numeroLote: item.numeroLote || undefined,
              fechaCaducidad: new Date(item.fechaCaducidad as string),
              cantidad: item.cantidad,
            },
          });
          loteProductoId = lote.id;
        }

        const nuevoCostoPromedio = actualizarCostoPromedio(producto.stockActual, producto.costoPromedioActual, item.cantidad, costoUnitario);
        await tx.producto.update({
          where: { id: producto.id },
          data: {
            stockActual: { increment: item.cantidad },
            costoPromedioActual: nuevoCostoPromedio,
          },
        });
        if (!producto.manejaLotes) {
          await tx.stockSucursal.upsert({
            where: { productoId_sucursalId: { productoId: producto.id, sucursalId: sucursal.id } },
            create: { productoId: producto.id, sucursalId: sucursal.id, cantidad: item.cantidad },
            update: { cantidad: { increment: item.cantidad } },
          });
          await tx.stockBodega.upsert({
            where: { productoId_bodegaId: { productoId: producto.id, bodegaId } },
            create: { productoId: producto.id, bodegaId, cantidad: item.cantidad },
            update: { cantidad: { increment: item.cantidad } },
          });
        }
        await tx.movimientoInventario.create({
          data: {
            productoId: producto.id,
            tipo: "ENTRADA",
            cantidad: item.cantidad,
            motivo: `Compra a ${proveedor.razonSocial} - Fact. ${numeroFactura}`,
            loteProductoId,
            sucursalId: producto.manejaLotes ? null : sucursal.id,
            bodegaId: producto.manejaLotes ? null : bodegaId,
          },
        });
      }

      const total = subtotal0.add(subtotal12).add(ivaTotal);

      const compraCreada = await tx.compra.create({
        data: {
          proveedorId,
          numeroFactura,
          sucursalId: sucursal.id,
          bodegaId,
          puntoVentaId: cajaAbierta?.puntoVentaId ?? null,
          subtotal0,
          subtotal12,
          iva: ivaTotal,
          total,
          fechaVencimiento: fechaVencimiento ? new Date(fechaVencimiento) : undefined,
          sustentoTributario: sustentoTributario.trim(),
          detalles: { create: detallesData },
        },
        include: { detalles: { include: { producto: true } }, proveedor: true },
      });

      if (cuotas && cuotas.length > 0) {
        await tx.cuota.createMany({
          data: cuotas.map((c) => ({
            compraId: compraCreada.id,
            numero: c.numero,
            monto: c.monto,
            fechaVencimiento: new Date(c.fechaVencimiento),
          })),
        });
      }

      await crearAsiento(tx, {
        origen: "COMPRA",
        origenId: compraCreada.id,
        descripcion: `Compra a ${proveedor.razonSocial} - Fact. ${numeroFactura}`,
        lineas: lineasPorCompra({ subtotal0, subtotal12, iva: ivaTotal, total }),
        usuarioId: req.usuario!.usuarioId,
      });

      return compraCreada;
    });

    res.status(201).json(compra);
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
    if (error.message === "PROVEEDOR_NO_ENCONTRADO") {
      return res.status(404).json({ error: "El proveedor no existe" });
    }
    if (typeof error.message === "string" && error.message.startsWith("CANTIDAD_INVALIDA")) {
      return res.status(400).json({ error: "La cantidad de cada producto debe ser un entero mayor a 0" });
    }
    if (typeof error.message === "string" && error.message.startsWith("COSTO_INVALIDO")) {
      return res.status(400).json({ error: "El costo unitario de cada producto debe ser un número mayor o igual a 0" });
    }
    if (typeof error.message === "string" && error.message.startsWith("FALTA_CADUCIDAD")) {
      return res.status(400).json({ error: `"${error.message.split(":")[1]}" maneja lotes: cada línea necesita fecha de caducidad` });
    }
    if (typeof error.message === "string" && error.message.startsWith("PRODUCTO_NO_ENCONTRADO")) {
      return res.status(404).json({ error: `Producto no encontrado: ${error.message.split(":")[1]}` });
    }
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya registraste una compra con ese número de factura para este proveedor" });
    }
    if (error.message === "CUOTAS_VACIAS") return res.status(400).json({ error: "El plan de cuotas no puede estar vacío" });
    if (error.message === "CUOTAS_NUMERO_INVALIDO") {
      return res.status(400).json({ error: "Las cuotas deben numerarse 1, 2, 3... sin saltos ni repetidos" });
    }
    if (error.message === "CUOTAS_MONTO_INVALIDO") return res.status(400).json({ error: "El monto de cada cuota debe ser mayor a 0" });
    if (error.message === "CUOTAS_FECHA_INVALIDA") return res.status(400).json({ error: "Cada cuota necesita una fecha de vencimiento válida" });
    console.error(error);
    res.status(500).json({ error: "Error al registrar la compra" });
  }
});

// PATCH /compras/:id/sustento-tributario
// Completa o corrige el código de sustento tributario de una compra que ya
// existe — el único campo editable de una Compra después de creada (el
// resto queda fijo porque ya movió stock/contabilidad). Pensado sobre todo
// para compras registradas ANTES de que este campo existiera (ver
// Compra.sustentoTributario en schema.prisma), para que el reporte ATS
// (GET /reportes/ats) no se quede con esa columna vacía para siempre.
comprasRouter.patch("/:id/sustento-tributario", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { sustentoTributario } = req.body;
    if (!sustentoTributario || !String(sustentoTributario).trim()) {
      return res.status(400).json({ error: "sustentoTributario es obligatorio" });
    }

    const compra = await prisma.compra.update({
      where: { id },
      data: { sustentoTributario: String(sustentoTributario).trim() },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_SUSTENTO_TRIBUTARIO_COMPRA",
      entidad: "Compra",
      entidadId: compra.id,
      detalle: `Compra Fact. ${compra.numeroFactura}: sustento tributario = ${compra.sustentoTributario}`,
    });

    res.json(compra);
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Compra no encontrada" });
    console.error(error);
    res.status(500).json({ error: "Error al actualizar el sustento tributario" });
  }
});

// PATCH /compras/:id/anular
// Deshace la compra: le quita al stock lo que esta compra le había sumado.
// Si para entonces ya se vendió parte de esas unidades, no hay cómo "devolver"
// stock que ya no existe — bloqueamos la anulación en vez de dejar el stock
// en negativo o inconsistente.
comprasRouter.patch("/:id/anular", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    const compra = await prisma.compra.findUnique({
      where: { id },
      include: { detalles: { include: { producto: true, devolucionesDetalle: true } } },
    });

    if (!compra) return res.status(404).json({ error: "Compra no encontrada" });
    if (compra.estado === "ANULADA") {
      return res.status(409).json({ error: "Esta compra ya está anulada" });
    }

    // Si ya se registró alguna devolución a proveedor contra esta compra, no
    // se puede anular el documento completo: se restaría del stock la
    // cantidad ORIGINAL de cada línea, sin saber que una parte ya se le quitó
    // antes por la devolución (quedaría restado de más). En vez de prorratear
    // esta resta, se bloquea — mismo criterio "bloquear en vez de adivinar"
    // que ya usa el resto del sistema (ej. no se puede devolver de una compra
    // anulada).
    const tieneDevoluciones = compra.detalles.some((d) => d.devolucionesDetalle.length > 0);
    if (tieneDevoluciones) {
      return res.status(409).json({
        error: "Esta compra ya tiene una devolución a proveedor registrada — devuelve el resto en vez de anular todo",
      });
    }

    for (const detalle of compra.detalles) {
      if (detalle.producto.manejaLotes) {
        if (detalle.producto.stockActual < detalle.cantidad) {
          return res.status(409).json({
            error: `No se puede anular: ya se usó/vendió parte del stock de "${detalle.producto.nombre}"`,
          });
        }
      } else {
        // El chequeo de bodega es el que manda (más fino): puede haber
        // menos stock ahí que en el total de la sucursal si un traslado
        // movió parte a otra bodega desde que se registró esta compra.
        const stockBodegaLocal = await prisma.stockBodega.findUnique({
          where: { productoId_bodegaId: { productoId: detalle.productoId, bodegaId: compra.bodegaId } },
        });
        if (!stockBodegaLocal || stockBodegaLocal.cantidad < detalle.cantidad) {
          return res.status(409).json({
            error: `No se puede anular: ya se usó/vendió/trasladó parte del stock de "${detalle.producto.nombre}" en esa bodega`,
          });
        }
      }
    }

    const compraAnulada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const detalle of compra.detalles) {
        const nuevoCostoPromedio = actualizarCostoPromedio(
          detalle.producto.stockActual,
          detalle.producto.costoPromedioActual,
          -detalle.cantidad,
          detalle.costoUnitario
        );
        await tx.producto.update({
          where: { id: detalle.productoId },
          data: {
            stockActual: { decrement: detalle.cantidad },
            // Seguro sin prorratear: el bloqueo de arriba garantiza que acá
            // nunca hay devoluciones previas contra esta compra, así que se
            // revierte la línea completa a su costo original.
            costoPromedioActual: nuevoCostoPromedio,
          },
        });
        if (!detalle.producto.manejaLotes) {
          await tx.stockSucursal.update({
            where: { productoId_sucursalId: { productoId: detalle.productoId, sucursalId: compra.sucursalId } },
            data: { cantidad: { decrement: detalle.cantidad } },
          });
          await tx.stockBodega.update({
            where: { productoId_bodegaId: { productoId: detalle.productoId, bodegaId: compra.bodegaId } },
            data: { cantidad: { decrement: detalle.cantidad } },
          });
        }
        await tx.movimientoInventario.create({
          data: {
            productoId: detalle.productoId,
            tipo: "SALIDA",
            cantidad: detalle.cantidad,
            motivo: `Anulación de compra - Fact. ${compra.numeroFactura}`,
            sucursalId: detalle.producto.manejaLotes ? null : compra.sucursalId,
            bodegaId: detalle.producto.manejaLotes ? null : compra.bodegaId,
          },
        });
      }

      // Limpia los números de serie que bodega ya había capturado contra
      // esta compra y que TODAVÍA están en bodega (sin entregar) — si ya se
      // usó/vendió parte del stock, los chequeos de arriba ya bloquearon
      // la anulación completa, así que acá nunca debería quedar ninguno en
      // estado ENTREGADO; se deja fuera del delete de todos modos, por si
      // acaso, en vez de asumirlo.
      await tx.numeroSerieProducto.deleteMany({
        where: { compraDetalleId: { in: compra.detalles.map((d) => d.id) }, estado: "EN_BODEGA" },
      });

      const anulada = await tx.compra.update({ where: { id }, data: { estado: "ANULADA" } });

      await revertirAsientoDeOrigen(tx, "COMPRA", id, req.usuario!.usuarioId);

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "ANULAR_COMPRA",
        entidad: "Compra",
        entidadId: id,
        detalle: `Compra Fact. ${compra.numeroFactura}`,
      });

      return anulada;
    });

    res.json({ mensaje: "Compra anulada y stock corregido", compra: compraAnulada });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al anular la compra" });
  }
});
