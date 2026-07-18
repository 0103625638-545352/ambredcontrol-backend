// Rutas de PROFORMAS: cotizaciones con el mismo formato visual que una
// factura, pero que NO son un comprobante electrónico (no se envían al SRI)
// y NO descuentan stock — son solo un precio ofrecido al cliente. Cuando el
// cliente acepta, se "convierten" en una Factura o Nota de Venta real (ahí
// sí se valida y descuenta stock), usando el mismo patrón de transacción que
// esas rutas ya usan.
import { Router, Request, Response } from "express";
import { prisma, empresaActiva } from "../db";
import { Prisma } from "@prisma/client";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { generarRideProformaPdf } from "../utils/generarRideProforma";
import { generarClaveAcceso } from "../utils/claveAcceso";
import { descontarStockVenta } from "../utils/descontarStockVenta";
import { registrarAuditoria } from "../utils/auditoria";
import { sucursalDelUsuarioActual } from "../utils/sucursales";
import { bodegaValidaEnSucursal } from "../utils/bodegas";
import { cajaAbiertaDelUsuarioActual } from "../utils/cajaSesionActual";
import { precioParaCliente } from "../utils/precios";

export const proformasRouter = Router();

interface ItemProforma {
  productoId: number;
  cantidad: number;
}

interface CrearProformaBody {
  clienteId: number;
  items: ItemProforma[];
  validaHasta?: string; // fecha ISO opcional
}

// GET /proformas
proformasRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const opciones = {
      include: {
        cliente: true,
        facturaConvertida: { select: { secuencial: true } },
        notaVentaConvertida: { select: { secuencial: true } },
      },
      orderBy: { fechaEmision: "desc" as const },
    };

    if (!paginacion.aplica) {
      const proformas = await prisma.proforma.findMany(opciones);
      return res.json(proformas);
    }

    const [proformas, total] = await Promise.all([
      prisma.proforma.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.proforma.count(),
    ]);
    res.json(respuestaPaginada(proformas, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar proformas" });
  }
});

// GET /proformas/:id
proformasRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const proforma = await prisma.proforma.findUnique({
      where: { id },
      include: {
        cliente: { include: { tipoPrecio: true } },
        detalles: { include: { producto: true } },
        facturaConvertida: { select: { secuencial: true } },
        notaVentaConvertida: { select: { secuencial: true } },
      },
    });
    if (!proforma) return res.status(404).json({ error: "Proforma no encontrada" });
    res.json(proforma);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar la proforma" });
  }
});

// GET /proformas/:id/pdf
proformasRouter.get("/:id/pdf", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const proforma = await prisma.proforma.findUnique({
      where: { id },
      include: { cliente: true, detalles: { include: { producto: true } } },
    });
    if (!proforma) return res.status(404).json({ error: "Proforma no encontrada" });

    const empresaPdf = empresaActiva();
    const pdfBytes = await generarRideProformaPdf(proforma, {
      ruc: empresaPdf.ruc,
      razonSocial: empresaPdf.razonSocial,
      dirMatriz: empresaPdf.direccionMatriz,
    });

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="proforma-${proforma.secuencial}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el PDF: " + error.message });
  }
});

// POST /proformas
// Body: { clienteId, items: [{ productoId, cantidad }], validaHasta? }
// A diferencia de /facturas y /notas-venta, NO valida stock ni lo descuenta
// — es solo una cotización con el precio/IVA actual del producto.
proformasRouter.post("/", async (req: Request, res: Response) => {
  const { clienteId, items, validaHasta } = req.body as CrearProformaBody;

  if (!clienteId || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "clienteId e items (con al menos 1 producto) son obligatorios" });
  }

  try {
    const proforma = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const cliente = await tx.cliente.findUnique({ where: { id: clienteId }, include: { tipoPrecio: true } });
      if (!cliente) throw new Error("CLIENTE_NO_ENCONTRADO");

      let subtotal0 = new Prisma.Decimal(0);
      let subtotal12 = new Prisma.Decimal(0);
      let ivaTotal = new Prisma.Decimal(0);
      const detallesData = [];

      for (const item of items) {
        if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
          throw new Error(`CANTIDAD_INVALIDA:${item.productoId}`);
        }

        const producto = await tx.producto.findUnique({ where: { id: item.productoId } });
        if (!producto) throw new Error(`PRODUCTO_NO_ENCONTRADO:${item.productoId}`);

        const precioUnitario = precioParaCliente(producto, cliente);
        if (precioUnitario === null) {
          throw new Error(`SIN_COSTO_PRODUCTO:${producto.nombre}`);
        }
        const bruto = precioUnitario.mul(item.cantidad);
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
          precioUnitario,
          subtotal: bruto,
          ivaValor,
        });
      }

      const total = subtotal0.add(subtotal12).add(ivaTotal);

      // Numeración propia ("PRO"), independiente de la de Factura/NotaVenta/NotaCredito.
      const secuencial = await tx.secuencial.upsert({
        where: {
          puntoVenta_establecimiento_tipoComprobante: {
            puntoVenta: "001",
            establecimiento: "001",
            tipoComprobante: "PRO",
          },
        },
        create: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "PRO", ultimoNumero: 1 },
        update: { ultimoNumero: { increment: 1 } },
      });
      const numeroFormateado = String(secuencial.ultimoNumero).padStart(9, "0");
      const secuencialTexto = `PRO-001-001-${numeroFormateado}`;

      return tx.proforma.create({
        data: {
          secuencial: secuencialTexto,
          clienteId,
          validaHasta: validaHasta ? new Date(validaHasta) : undefined,
          subtotal0,
          subtotal12,
          iva: ivaTotal,
          total,
          detalles: { create: detallesData },
        },
        include: { detalles: { include: { producto: true } }, cliente: true },
      });
    });

    res.status(201).json(proforma);
  } catch (error: any) {
    if (error.message === "CLIENTE_NO_ENCONTRADO") {
      return res.status(404).json({ error: "El cliente no existe" });
    }
    if (typeof error.message === "string" && error.message.startsWith("CANTIDAD_INVALIDA")) {
      return res.status(400).json({ error: "La cantidad de cada producto debe ser un entero mayor a 0" });
    }
    if (typeof error.message === "string" && error.message.startsWith("PRODUCTO_NO_ENCONTRADO")) {
      return res.status(404).json({ error: `Producto no encontrado: ${error.message.split(":")[1]}` });
    }
    if (typeof error.message === "string" && error.message.startsWith("SIN_COSTO_PRODUCTO")) {
      return res.status(400).json({
        error: `"${error.message.split(":")[1]}" no tiene costo registrado todavía (compra pendiente) — no se puede cotizar`,
      });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear la proforma" });
  }
});

// PUT /proformas/:id
// Body: { clienteId, items: [{ productoId, cantidad }], validaHasta? }
// Reemplaza por completo los ítems de una proforma mientras siga CREADA
// (permite quitar/agregar/ajustar cantidades sin anular y recrear todo desde
// cero). Misma lógica de cálculo que POST /proformas; el secuencial "PRO-xxx"
// no cambia.
proformasRouter.put("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { clienteId, items, validaHasta } = req.body as CrearProformaBody;

  if (!clienteId || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "clienteId e items (con al menos 1 producto) son obligatorios" });
  }

  try {
    const proformaExistente = await prisma.proforma.findUnique({ where: { id } });
    if (!proformaExistente) return res.status(404).json({ error: "Proforma no encontrada" });
    if (proformaExistente.estado !== "CREADA") {
      return res.status(409).json({ error: `No se puede editar: esta proforma ya está en estado "${proformaExistente.estado}"` });
    }

    const proforma = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const cliente = await tx.cliente.findUnique({ where: { id: clienteId }, include: { tipoPrecio: true } });
      if (!cliente) throw new Error("CLIENTE_NO_ENCONTRADO");

      let subtotal0 = new Prisma.Decimal(0);
      let subtotal12 = new Prisma.Decimal(0);
      let ivaTotal = new Prisma.Decimal(0);
      const detallesData = [];

      for (const item of items) {
        if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
          throw new Error(`CANTIDAD_INVALIDA:${item.productoId}`);
        }

        const producto = await tx.producto.findUnique({ where: { id: item.productoId } });
        if (!producto) throw new Error(`PRODUCTO_NO_ENCONTRADO:${item.productoId}`);

        const precioUnitario = precioParaCliente(producto, cliente);
        if (precioUnitario === null) {
          throw new Error(`SIN_COSTO_PRODUCTO:${producto.nombre}`);
        }
        const bruto = precioUnitario.mul(item.cantidad);
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
          precioUnitario,
          subtotal: bruto,
          ivaValor,
        });
      }

      const total = subtotal0.add(subtotal12).add(ivaTotal);

      return tx.proforma.update({
        where: { id },
        data: {
          clienteId,
          validaHasta: validaHasta ? new Date(validaHasta) : null,
          subtotal0,
          subtotal12,
          iva: ivaTotal,
          total,
          detalles: { deleteMany: {}, create: detallesData },
        },
        include: { detalles: { include: { producto: true } }, cliente: true },
      });
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_PROFORMA",
      entidad: "Proforma",
      entidadId: id,
      detalle: `Proforma ${proforma.secuencial}`,
    });

    res.json(proforma);
  } catch (error: any) {
    if (error.message === "CLIENTE_NO_ENCONTRADO") {
      return res.status(404).json({ error: "El cliente no existe" });
    }
    if (typeof error.message === "string" && error.message.startsWith("CANTIDAD_INVALIDA")) {
      return res.status(400).json({ error: "La cantidad de cada producto debe ser un entero mayor a 0" });
    }
    if (typeof error.message === "string" && error.message.startsWith("PRODUCTO_NO_ENCONTRADO")) {
      return res.status(404).json({ error: `Producto no encontrado: ${error.message.split(":")[1]}` });
    }
    if (typeof error.message === "string" && error.message.startsWith("SIN_COSTO_PRODUCTO")) {
      return res.status(400).json({
        error: `"${error.message.split(":")[1]}" no tiene costo registrado todavía (compra pendiente) — no se puede cotizar`,
      });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar la proforma" });
  }
});

// PATCH /proformas/:id/anular
// Como nunca tocó el stock, anular una proforma es simplemente marcarla —
// no hay nada que devolver.
proformasRouter.patch("/:id/anular", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const proforma = await prisma.proforma.findUnique({ where: { id } });
    if (!proforma) return res.status(404).json({ error: "Proforma no encontrada" });
    if (proforma.estado !== "CREADA") {
      return res.status(409).json({ error: `No se puede anular: esta proforma ya está en estado "${proforma.estado}"` });
    }

    const proformaAnulada = await prisma.proforma.update({ where: { id }, data: { estado: "ANULADA" } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "ANULAR_PROFORMA",
      entidad: "Proforma",
      entidadId: id,
      detalle: `Proforma ${proforma.secuencial}`,
    });

    res.json({ mensaje: "Proforma anulada", proforma: proformaAnulada });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al anular la proforma" });
  }
});

// POST /proformas/:id/convertir-factura
// El cliente aceptó la cotización: se crea una Factura real con los mismos
// productos/cantidades (mismo patrón de transacción que POST /facturas —
// AHÍ SÍ se valida y descuenta stock, con el precio/IVA vigente en ese
// momento, que puede diferir del cotizado si cambió mientras tanto).
proformasRouter.post("/:id/convertir-factura", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { bodegaId } = req.body as { bodegaId: number };
    const proforma = await prisma.proforma.findUnique({ where: { id }, include: { detalles: true, cliente: { include: { tipoPrecio: true } } } });
    if (!proforma) return res.status(404).json({ error: "Proforma no encontrada" });
    if (proforma.estado !== "CREADA") {
      return res.status(409).json({ error: `No se puede convertir: esta proforma ya está en estado "${proforma.estado}"` });
    }

    const sucursal = await sucursalDelUsuarioActual(req.usuario!.usuarioId);
    await bodegaValidaEnSucursal(bodegaId, sucursal.id);
    const cajaAbierta = await cajaAbiertaDelUsuarioActual(req.usuario!.usuarioId);

    const factura = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let subtotal0 = new Prisma.Decimal(0);
      let subtotal12 = new Prisma.Decimal(0);
      let ivaTotal = new Prisma.Decimal(0);
      const detallesData = [];

      for (const item of proforma.detalles) {
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

        const precioUnitario = precioParaCliente(producto, proforma.cliente);
        if (precioUnitario === null) {
          throw new Error(`SIN_COSTO_PRODUCTO:${producto.nombre}`);
        }
        const bruto = precioUnitario.mul(item.cantidad);
        const ivaPorcentaje = producto.ivaPorcentaje;
        const ivaValor = ivaPorcentaje.gt(0) ? bruto.mul(ivaPorcentaje).div(100) : new Prisma.Decimal(0);

        if (ivaPorcentaje.gt(0)) subtotal12 = subtotal12.add(bruto);
        else subtotal0 = subtotal0.add(bruto);
        ivaTotal = ivaTotal.add(ivaValor);

        detallesData.push({ productoId: producto.id, cantidad: item.cantidad, precioUnitario, descuento: new Prisma.Decimal(0), subtotal: bruto, ivaValor });

        await descontarStockVenta(tx, producto, item.cantidad, `Venta - factura (desde proforma ${proforma.secuencial})`, sucursal.id, bodegaId);
      }

      const total = subtotal0.add(subtotal12).add(ivaTotal);

      const secuencial = await tx.secuencial.upsert({
        where: { puntoVenta_establecimiento_tipoComprobante: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "01" } },
        create: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "01", ultimoNumero: 1 },
        update: { ultimoNumero: { increment: 1 } },
      });
      const numeroFormateado = String(secuencial.ultimoNumero).padStart(9, "0");
      const secuencialTexto = `001-001-${numeroFormateado}`;

      const empresaConversion = empresaActiva();
      const claveAcceso = generarClaveAcceso({
        fechaEmision: new Date(),
        ruc: empresaConversion.ruc,
        ambiente: empresaConversion.ambienteSri,
        establecimiento: empresaConversion.establecimiento,
        puntoEmision: empresaConversion.puntoEmision,
        secuencial: secuencial.ultimoNumero,
      });

      const facturaCreada = await tx.factura.create({
        data: {
          secuencial: secuencialTexto,
          claveAcceso,
          clienteId: proforma.clienteId,
          sucursalId: sucursal.id,
          bodegaId,
          puntoVentaId: cajaAbierta?.puntoVentaId ?? null,
          subtotal0,
          subtotal12,
          iva: ivaTotal,
          total,
          detalles: { create: detallesData },
        },
      });

      await tx.proforma.update({ where: { id }, data: { estado: "CONVERTIDA", facturaConvertidaId: facturaCreada.id } });

      return facturaCreada;
    });

    res.status(201).json(factura);
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
    res.status(500).json({ error: "Error al convertir la proforma en factura" });
  }
});

// POST /proformas/:id/convertir-nota-venta
// Igual que convertir-factura, pero crea una Nota de Venta (recibo interno,
// nunca pasa por el SRI). Por defecto no aplica IVA — igual que al crear una
// nota de venta desde cero — así que si la proforma cotizó CON IVA y el
// cliente prefiere Nota de Venta, el monto final puede diferir del cotizado.
proformasRouter.post("/:id/convertir-nota-venta", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { aplicaIva, bodegaId } = req.body as { aplicaIva?: boolean; bodegaId: number };
    const proforma = await prisma.proforma.findUnique({ where: { id }, include: { detalles: true, cliente: { include: { tipoPrecio: true } } } });
    if (!proforma) return res.status(404).json({ error: "Proforma no encontrada" });
    if (proforma.estado !== "CREADA") {
      return res.status(409).json({ error: `No se puede convertir: esta proforma ya está en estado "${proforma.estado}"` });
    }

    const seAplicaIva = aplicaIva === true;
    const sucursal = await sucursalDelUsuarioActual(req.usuario!.usuarioId);
    await bodegaValidaEnSucursal(bodegaId, sucursal.id);
    const cajaAbierta = await cajaAbiertaDelUsuarioActual(req.usuario!.usuarioId);

    const notaVenta = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let subtotal0 = new Prisma.Decimal(0);
      let subtotal12 = new Prisma.Decimal(0);
      let ivaTotal = new Prisma.Decimal(0);
      const detallesData = [];

      for (const item of proforma.detalles) {
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

        const precioUnitario = precioParaCliente(producto, proforma.cliente);
        if (precioUnitario === null) {
          throw new Error(`SIN_COSTO_PRODUCTO:${producto.nombre}`);
        }
        const bruto = precioUnitario.mul(item.cantidad);
        const ivaPorcentaje = seAplicaIva ? producto.ivaPorcentaje : new Prisma.Decimal(0);
        const ivaValor = ivaPorcentaje.gt(0) ? bruto.mul(ivaPorcentaje).div(100) : new Prisma.Decimal(0);

        if (ivaPorcentaje.gt(0)) subtotal12 = subtotal12.add(bruto);
        else subtotal0 = subtotal0.add(bruto);
        ivaTotal = ivaTotal.add(ivaValor);

        detallesData.push({ productoId: producto.id, cantidad: item.cantidad, precioUnitario, descuento: new Prisma.Decimal(0), subtotal: bruto, ivaValor });

        await descontarStockVenta(tx, producto, item.cantidad, `Venta - nota de venta (desde proforma ${proforma.secuencial})`, sucursal.id, bodegaId);
      }

      const total = subtotal0.add(subtotal12).add(ivaTotal);

      const secuencial = await tx.secuencial.upsert({
        where: { puntoVenta_establecimiento_tipoComprobante: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "NV" } },
        create: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "NV", ultimoNumero: 1 },
        update: { ultimoNumero: { increment: 1 } },
      });
      const numeroFormateado = String(secuencial.ultimoNumero).padStart(9, "0");
      const secuencialTexto = `001-001-${numeroFormateado}`;

      const notaVentaCreada = await tx.notaVenta.create({
        data: {
          secuencial: secuencialTexto,
          clienteId: proforma.clienteId,
          sucursalId: sucursal.id,
          bodegaId,
          puntoVentaId: cajaAbierta?.puntoVentaId ?? null,
          aplicaIva: seAplicaIva,
          subtotal0,
          subtotal12,
          iva: ivaTotal,
          total,
          detalles: { create: detallesData },
        },
      });

      await tx.proforma.update({ where: { id }, data: { estado: "CONVERTIDA", notaVentaConvertidaId: notaVentaCreada.id } });

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
    res.status(500).json({ error: "Error al convertir la proforma en nota de venta" });
  }
});
