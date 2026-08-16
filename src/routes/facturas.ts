import { Router, Request, Response } from "express";
import { prisma, empresaActiva } from "../db";
import { Prisma } from "@prisma/client";
import { datosEmisorDeEmpresa, rutaAbsoluta } from "../utils/empresas";
import { obtenerUrlsSri } from "../utils/sriEndpoints";
import { generarClaveAcceso } from "../utils/claveAcceso";
import { guardarComprobanteAutorizado } from "../utils/comprobantesAutorizados";
import { generarXmlFactura } from "../utils/facturaXml";
import { cargarCertificadoP12 } from "../utils/certificado";
import { firmarXadesBes } from "../utils/firmarXadesBes";
import { enviarComprobanteRecepcion } from "../utils/sriRecepcion";
import { consultarAutorizacion } from "../utils/sriAutorizacion";
import { generarRidePdf } from "../utils/generarRide";
import { generarReciboTermicoPdf } from "../utils/generarReciboTermico";
import { requirePermiso } from "../middleware/auth";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerRangoFechas } from "../utils/rangoFechas";
import { enviarComprobantePorCorreo } from "../utils/email";
import { calcularEstadoPago } from "../utils/estadoPago";
import { descontarStockVenta } from "../utils/descontarStockVenta";
import { registrarAuditoria } from "../utils/auditoria";
import { sucursalDelUsuarioActual } from "../utils/sucursales";
import { bodegaValidaEnSucursal } from "../utils/bodegas";
import { cajaAbiertaDelUsuarioActual } from "../utils/cajaSesionActual";
import { precioParaCliente } from "../utils/precios";
import { lineasPorVenta, lineasPorCostoVenta } from "../utils/contabilidad";
import { crearAsiento, revertirAsientoDeOrigen } from "../utils/asientos";
import { crearPagoConAsiento } from "../utils/pagos";
import { validarPlanCuotas, type CuotaInput } from "../utils/cuotas";
import { reconciliarClienteInternet } from "../utils/gestionServicioInternet";

export const facturasRouter = Router();

// Consulta el estado de Autorización de una factura ya enviada, y actualiza
// su estado en la base de datos según la respuesta. Se usa desde 3 lugares:
// el paso 3 de POST /:id/enviar-sri, la ruta manual GET /:id/consultar-autorizacion,
// y el job en segundo plano que reintenta automáticamente las que quedaron
// "EN_PROCESO" (ver backend/src/jobs/reintentoAutorizacionSri.ts).
//
// Devuelve null si la factura no existe o todavía no tiene clave de acceso
// (nada que consultar en ese caso).
export async function verificarYActualizarAutorizacionFactura(facturaId: number) {
  const factura = await prisma.factura.findUnique({
    where: { id: facturaId },
    include: { cliente: true, detalles: { include: { producto: true } } },
  });
  if (!factura || !factura.claveAcceso) return null;

  const urlAutorizacion = obtenerUrlsSri(empresaActiva().ambienteSri).autorizacion;

  const autorizacion = await consultarAutorizacion(factura.claveAcceso, urlAutorizacion);

  if (autorizacion.estado === "AUTORIZADO") {
    await prisma.factura.update({ where: { id: facturaId }, data: { estado: "AUTORIZADA" } });
    if (autorizacion.comprobante) {
      guardarComprobanteAutorizado(factura.claveAcceso, autorizacion.comprobante);
      // El correo es "mejor esfuerzo": si falla, no debe deshacer la
      // autorización que el SRI ya concedió — por eso va en su propio
      // try/catch y solo deja un log, nunca relanza el error.
      await enviarFacturaAutorizadaPorCorreo(factura, autorizacion.comprobante);
    }
  } else if (autorizacion.estado === "NO AUTORIZADO") {
    await prisma.factura.update({ where: { id: facturaId }, data: { estado: "RECHAZADA" } });
  }
  // Si sigue "EN_PROCESO", dejamos el estado en ENVIADA para volver a consultar después.

  return autorizacion;
}

// Le manda al cliente (si tiene correo registrado) el RIDE en PDF y el XML
// autorizado, adjuntos en un solo correo. Se llama justo después de que el
// SRI autoriza la factura — sea que eso pase al toque (5s después de
// enviarla), por una consulta manual, o por el job automático de reintentos.
async function enviarFacturaAutorizadaPorCorreo(factura: any, xmlAutorizado: string) {
  if (!factura.cliente.email) return; // sin correo registrado, no hay a quién mandarle

  const empresa = empresaActiva();

  try {
    const pdfBytes = await generarRidePdf(
      {
        secuencial: factura.secuencial,
        claveAcceso: factura.claveAcceso,
        fechaEmision: factura.fechaEmision,
        subtotal0: factura.subtotal0,
        subtotal12: factura.subtotal12,
        iva: factura.iva,
        total: factura.total,
        estado: "AUTORIZADA",
        cliente: factura.cliente,
        detalles: factura.detalles,
      },
      datosEmisorDeEmpresa(empresa)
    );

    const enviado = await enviarComprobantePorCorreo({
      destinatario: factura.cliente.email,
      asunto: `Factura ${factura.secuencial} - ${empresa.razonSocial}`,
      textoPlano:
        `Hola ${factura.cliente.razonSocial},\n\n` +
        `Adjuntamos tu factura electrónica ${factura.secuencial}, autorizada por el SRI, ` +
        `en PDF (RIDE) y en XML.\n\nGracias por tu compra.`,
      pdfBuffer: Buffer.from(pdfBytes),
      pdfNombreArchivo: `factura-${factura.secuencial}.pdf`,
      xmlContenido: xmlAutorizado,
      xmlNombreArchivo: `factura-${factura.secuencial}.xml`,
    });

    if (enviado) {
      console.log(`[correo] Factura ${factura.secuencial} enviada a ${factura.cliente.email}`);
    }
  } catch (error: any) {
    console.error(`[correo] Error enviando factura ${factura.secuencial} a ${factura.cliente.email}:`, error.message);
  }
}

// Forma de pago REAL a declarar en el XML (ver codigoFormaPagoSri en
// facturaXml.ts) — quien llama la pasa explícita cuando ya la conoce con
// certeza (ver enviarFacturaAlSri más abajo), para no depender de una
// carrera entre el envío al SRI (fire-and-forget apenas se crea la factura)
// y el registro del abono inicial (una llamada HTTP aparte, ver
// PuntoDeVentaPage.tsx) — esa carrera es real y no determinística.
interface FormaPagoParaXml {
  formaPago: string;
  tarjetaTipo?: string | null;
}

// Función reutilizable: dado un registro de factura (con sus relaciones cargadas),
// arma los datos que generarXmlFactura necesita y devuelve el XML sin firmar.
function construirXmlDeFactura(factura: any, formaPagoOverride?: FormaPagoParaXml): string {
  // Sin override explícito: si la factura ya trae pagos cargados (ver el
  // include de quien llama), usamos el más antiguo como mejor estimación.
  // Sin pagos (ej. venta 100% PENDIENTE) generarXmlFactura cae en "01" sola.
  const formaPago = formaPagoOverride ?? factura.pagos?.[0];
  return generarXmlFactura(
    {
      claveAcceso: factura.claveAcceso,
      secuencial: factura.secuencial,
      fechaEmision: factura.fechaEmision,
      subtotal0: factura.subtotal0,
      subtotal12: factura.subtotal12,
      iva: factura.iva,
      total: factura.total,
      cliente: factura.cliente,
      detalles: factura.detalles,
      formaPago: formaPago?.formaPago,
      tarjetaTipo: formaPago?.tarjetaTipo,
    },
    datosEmisorDeEmpresa(empresaActiva())
  );
}

// Tipo del carrito que esperamos recibir del frontend (o de Thunder Client, por ahora)
interface ItemCarrito {
  productoId: number;
  cantidad: number;
  descuento?: number; // valor absoluto de descuento por línea, opcional
}

interface CrearFacturaBody {
  clienteId: number;
  bodegaId: number;
  items: ItemCarrito[];
  fechaVencimiento?: string; // opcional: solo tiene sentido si la venta queda con saldo pendiente
  // OJO: el plan de cuotas NO se crea acá aunque la venta lo pida — se crea
  // en registrarPagoDeFactura, junto con el abono inicial (ver DatosPago).
  // Si se creara acá, el abono inicial (que llega en una llamada aparte,
  // justo después) chocaría con la cuota 1 ya pendiente y la validación
  // estricta de cobro en orden lo rechazaría por no coincidir el monto.
}

// Núcleo de "crear una factura" (validar stock/precio, sacar secuencial,
// generar clave de acceso, crear el registro + asiento contable), extraído
// de POST / para que routes/facturasInternet.ts (facturación de internet,
// un solo ítem de servicio por vez) pueda reusarlo tal cual en vez de
// reimplementar secuencial/clave de acceso/contabilidad aparte — la ÚNICA
// diferencia entre una venta normal y una factura de internet es qué items
// se le pasan; todo lo demás (numeración legal, envío al SRI) es idéntico.
//
// Los productos con esServicio=true (ver Producto en schema.prisma) no
// pasan por ninguna validación ni descuento de stock — no son bienes
// físicos que salgan de una bodega.
export async function crearFacturaConItems(
  usuarioId: number,
  { clienteId, bodegaId, items, fechaVencimiento }: CrearFacturaBody
) {
  const sucursal = await sucursalDelUsuarioActual(usuarioId);
  await bodegaValidaEnSucursal(bodegaId, sucursal.id);
  const cajaAbierta = await cajaAbiertaDelUsuarioActual(usuarioId);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

      if (!producto.esServicio) {
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
      }

      const descuento = new Prisma.Decimal(item.descuento ?? 0);
      const precioUnitario = precioParaCliente(producto, cliente);
      if (precioUnitario === null) {
        throw new Error(`SIN_COSTO_PRODUCTO:${producto.nombre}`);
      }
      const bruto = precioUnitario.mul(item.cantidad).sub(descuento);
      const ivaPorcentaje = producto.ivaPorcentaje; // ej. 15.00
      const ivaValor = ivaPorcentaje.gt(0)
        ? bruto.mul(ivaPorcentaje).div(100)
        : new Prisma.Decimal(0);

      if (ivaPorcentaje.gt(0)) {
        subtotal12 = subtotal12.add(bruto);
      } else {
        subtotal0 = subtotal0.add(bruto);
      }
      ivaTotal = ivaTotal.add(ivaValor);
      // Un servicio no tiene costo de compra: no aporta costo de venta al
      // asiento contable (costoPromedioActual queda null para siempre en un
      // producto esServicio=true).
      if (!producto.esServicio) {
        costoVentaTotal = costoVentaTotal.add(producto.costoPromedioActual!.mul(item.cantidad));
      }

      detallesData.push({
        productoId: producto.id,
        cantidad: item.cantidad,
        precioUnitario,
        descuento,
        subtotal: bruto,
        ivaValor,
      });

      if (!producto.esServicio) {
        // Descontamos el stock y dejamos rastro en el kardex, igual que en /movimientos
        // (respetando FEFO si el producto maneja lotes por caducidad)
        await descontarStockVenta(tx, producto, item.cantidad, "Venta - factura", sucursal.id, bodegaId);
      }
    }

    const total = subtotal0.add(subtotal12).add(ivaTotal);

    // --- Obtener el siguiente secuencial de forma ATÓMICA ---
    //
    // Si dos ventas llegaran al mismo tiempo, ambas no pueden recibir el
    // mismo número de factura. "upsert" + incremento dentro de la misma
    // transacción evita ese choque: Postgres bloquea la fila mientras
    // la transacción no termine.
    const secuencial = await tx.secuencial.upsert({
      where: {
        puntoVenta_establecimiento_tipoComprobante: {
          puntoVenta: "001",
          establecimiento: "001",
          tipoComprobante: "01",
        },
      },
      create: { puntoVenta: "001", establecimiento: "001", tipoComprobante: "01", ultimoNumero: 1 },
      update: { ultimoNumero: { increment: 1 } },
    });

    const numeroFormateado = String(secuencial.ultimoNumero).padStart(9, "0");
    const secuencialTexto = `001-001-${numeroFormateado}`;

    // --- Calcular la clave de acceso de 49 dígitos ---
    // (los datos del emisor vienen de la config de la empresa activa —
    // ver utils/empresas.ts — deben ser el RUC y ambiente reales del negocio)
    const empresa = empresaActiva();
    const claveAcceso = generarClaveAcceso({
      fechaEmision: new Date(),
      ruc: empresa.ruc,
      ambiente: empresa.ambienteSri,
      establecimiento: empresa.establecimiento,
      puntoEmision: empresa.puntoEmision,
      secuencial: secuencial.ultimoNumero,
    });

    // --- Crear la factura con sus detalles ---
    const facturaCreada = await tx.factura.create({
      data: {
        secuencial: secuencialTexto,
        claveAcceso,
        clienteId,
        sucursalId: sucursal.id,
        bodegaId,
        puntoVentaId: cajaAbierta?.puntoVentaId ?? null,
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
      origen: "FACTURA",
      origenId: facturaCreada.id,
      descripcion: `Factura ${secuencialTexto}`,
      lineas: [...lineasPorVenta({ subtotal0, subtotal12, iva: ivaTotal, total }), ...lineasPorCostoVenta(costoVentaTotal)],
      usuarioId,
    });

    return facturaCreada;
  });
}

// GET /facturas
// La lista NO trae "detalles" (las líneas de producto): esta vista solo
// muestra secuencial/cliente/total/estado, y traer las líneas de CADA
// factura del historial completo sería carísimo sin necesidad. El detalle
// completo se pide aparte en GET /facturas/:id cuando hace falta.
//
// Sin "?page=" trae TODAS (lo necesita el desplegable de "facturas
// autorizadas" al crear una nota de crédito). Con "?page=" pagina (lo usa
// la tabla de administración de Facturas).
facturasRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.FacturaWhereInput = rango ? { fechaEmision: rango } : {};
    const opciones = {
      where,
      include: {
        cliente: true,
        retencionRecibida: { select: { id: true, numeroComprobante: true, total: true } },
      },
      orderBy: { fechaEmision: "desc" as const },
    };

    if (!paginacion.aplica) {
      const facturas = await prisma.factura.findMany(opciones);
      return res.json(facturas);
    }

    const [facturas, total] = await Promise.all([
      prisma.factura.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.factura.count({ where }),
    ]);
    res.json(respuestaPaginada(facturas, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar facturas" });
  }
});

// GET /facturas/:id
facturasRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const factura = await prisma.factura.findUnique({
      where: { id },
      include: {
        cliente: true,
        detalles: { include: { producto: true } },
        pagos: { orderBy: { fecha: "desc" }, include: { cuentaBancaria: true, bancoOrigen: true, cuota: { select: { numero: true } } } },
        cuotas: { orderBy: { numero: "asc" } },
        retencionRecibida: { select: { id: true, numeroComprobante: true, total: true } },
      },
    });
    if (!factura) return res.status(404).json({ error: "Factura no encontrada" });
    res.json(factura);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar la factura" });
  }
});

// POST /facturas/:id/pagos
// Registra un abono (total o parcial) contra esta factura — es cómo se
// contesta "¿ya me pagó este cliente?", algo que el estado fiscal (CREADA/
// AUTORIZADA/etc.) nunca respondió: una factura autorizada por el SRI puede
// seguir sin cobrarse durante meses.
interface DatosPago {
  monto: number;
  formaPago: string;
  referencia?: string;
  cuentaBancariaId?: number;
  bancoOrigenId?: number;
  numeroCuentaOrigen?: string;
  tarjetaUltimosDigitos?: string;
  tarjetaTipo?: string;
  tarjetaReferencia?: string;
  tarjetaLote?: string;
  chequeNumero?: string;
  chequeFechaCobro?: string;
  // Plan de cuotas del SALDO que queda después de este pago (ver modelo
  // Cuota) — solo tiene sentido en el primer abono de una venta recién
  // creada (ver PuntoDeVentaPage.tsx). Se crea DESPUÉS de aplicar este pago
  // (nunca antes): si existiera ya al momento de registrar el abono, la
  // validación de "cobro estricto en orden" lo confundiría con el pago de
  // la cuota 1 y lo rechazaría por no coincidir el monto exacto.
  cuotas?: CuotaInput[];
}

// Validación compartida por registrarPagoDeFactura (pago contra una factura
// que ya existe) y registrarCobroSinFactura (cobro adelantado de internet,
// ver ahí) — monto/forma de pago/cuenta bancaria se validan exactamente
// igual en los dos casos, lo único que cambia es CONTRA QUÉ se aplica el
// pago. Lanza Error("CODIGO") en vez de responder HTTP directamente.
async function validarDatosPago(datos: DatosPago): Promise<{ montoDecimal: Prisma.Decimal; exigeCuentaBancaria: boolean }> {
  const { monto, formaPago, cuentaBancariaId } = datos;

  if (typeof monto !== "number" || Number.isNaN(monto) || monto <= 0) {
    throw new Error("MONTO_INVALIDO");
  }
  if (!formaPago) {
    throw new Error("FORMA_PAGO_OBLIGATORIA");
  }
  const exigeCuentaBancaria = ["TRANSFERENCIA", "TARJETA", "CHEQUE"].includes(formaPago);
  if (exigeCuentaBancaria) {
    if (!cuentaBancariaId) throw new Error("CUENTA_BANCARIA_OBLIGATORIA");
    const cuenta = await prisma.cuentaBancaria.findUnique({ where: { id: cuentaBancariaId } });
    if (!cuenta || !cuenta.activa) throw new Error("CUENTA_BANCARIA_INVALIDA");
  }

  return { montoDecimal: new Prisma.Decimal(monto), exigeCuentaBancaria };
}

// Núcleo de "registrar un pago contra una Factura" (validar monto/forma de
// pago/cuenta bancaria, crear el Pago + su asiento, recalcular montoPagado/
// estadoPago, y reconciliar el servicio de internet si aplica) — extraído
// para que routes/facturasInternet.ts (ventana de pago dedicada para
// clientes de internet, con captura de comprobante) lo reuse tal cual en
// vez de reimplementar toda esta validación aparte. Lanza Error("CODIGO")
// en vez de responder HTTP directamente — cada llamador decide qué hacer
// con eso (ver responderErrorRegistrarPago).
export async function registrarPagoDeFactura(facturaId: number, datos: DatosPago, usuarioId: number) {
  const {
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
  } = datos;
  const { montoDecimal, exigeCuentaBancaria } = await validarDatosPago(datos);
  if (cuotas && cuotas.length > 0) validarPlanCuotas(cuotas);

  const factura = await prisma.factura.findUnique({ where: { id: facturaId } });
  if (!factura) throw new Error("FACTURA_NO_ENCONTRADA");
  if (factura.estado === "ANULADA") throw new Error("FACTURA_ANULADA");

  const saldoPendiente = factura.total.sub(factura.montoPagado);
  if (montoDecimal.gt(saldoPendiente)) {
    throw new Error(`MONTO_SUPERA_SALDO:${saldoPendiente.toFixed(2)}`);
  }

  // Si esta factura tiene un plan de Cuotas, el cobro es ESTRICTO: solo se
  // puede pagar la próxima cuota pendiente (en orden), y por su monto EXACTO
  // — no se acepta un abono libre mientras haya cuotas sin liquidar.
  const proximaCuota = await prisma.cuota.findFirst({
    where: { facturaId, estado: "PENDIENTE" },
    orderBy: { numero: "asc" },
  });
  if (proximaCuota && !montoDecimal.equals(proximaCuota.monto)) {
    throw new Error(`MONTO_DEBE_COINCIDIR_CUOTA:${proximaCuota.numero}:${proximaCuota.monto.toFixed(2)}`);
  }

  const { facturaActualizada, pagoId } = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const pago = await crearPagoConAsiento(tx, {
      facturaId,
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
      descripcion: `Cobro factura ${factura.secuencial}`,
      usuarioId,
    });
    if (proximaCuota) {
      await tx.cuota.update({ where: { id: proximaCuota.id }, data: { estado: "PAGADA" } });
    }
    // El plan de cuotas del SALDO RESTANTE se crea acá, DESPUÉS de aplicar
    // este pago — nunca antes (ver el comentario en DatosPago.cuotas).
    if (cuotas && cuotas.length > 0) {
      await tx.cuota.createMany({
        data: cuotas.map((c) => ({
          facturaId,
          numero: c.numero,
          monto: c.monto,
          fechaVencimiento: new Date(c.fechaVencimiento),
        })),
      });
    }
    const nuevoMontoPagado = factura.montoPagado.add(montoDecimal);
    const actualizada = await tx.factura.update({
      where: { id: facturaId },
      data: { montoPagado: nuevoMontoPagado, estadoPago: calcularEstadoPago(nuevoMontoPagado, factura.total) },
      include: {
        pagos: { orderBy: { fecha: "desc" }, include: { cuentaBancaria: true, bancoOrigen: true, cuota: { select: { numero: true } } } },
        cuotas: { orderBy: { numero: "asc" } },
      },
    });
    return { facturaActualizada: actualizada, pagoId: pago.id };
  });

  // Si este pago dejó PAGADA una factura de internet (una sola línea con
  // el Producto espejo del plan del cliente, ver utils/planProducto.ts),
  // reactiva el servicio solo — best-effort, nunca bloquea el cobro que ya
  // se registró arriba (ver utils/gestionServicioInternet.ts).
  let avisoInternet: string | undefined;
  if (facturaActualizada.estadoPago === "PAGADA") {
    const cliente = await prisma.cliente.findUnique({
      where: { id: facturaActualizada.clienteId },
      select: {
        id: true,
        razonSocial: true,
        nodoId: true,
        direccionIp: true,
        planInternet: { select: { productoId: true } },
        prorrogaHasta: true,
        fechaContrato: true,
        createdAt: true,
      },
    });
    if (cliente?.planInternet?.productoId) {
      const esFacturaDeEsePlan = await prisma.facturaDetalle.findFirst({
        where: { facturaId, productoId: cliente.planInternet.productoId },
        select: { id: true },
      });
      if (esFacturaDeEsePlan) {
        const resultado = await reconciliarClienteInternet(cliente);
        if (resultado.accion === "REACTIVADO") {
          avisoInternet = "Servicio de internet reactivado en el Mikrotik.";
        } else if (resultado.error) {
          avisoInternet = `No se pudo reactivar el servicio de internet en el Mikrotik: ${resultado.error}`;
        }
      }
    }
  }

  return { factura: facturaActualizada, pagoId, avisoInternet };
}

// Cobro de internet registrado ANTES de que exista la factura del mes (ver
// routes/facturasInternet.ts — con miles de clientes pagando entre el 01 y
// el 05, no da tiempo a facturar a cada uno antes de poder cobrarle). Crea
// el Pago con clienteId puesto y facturaId null: la factura se genera y
// ADOPTA este mismo Pago después, en lote ("Facturar a todos los
// pagados"), no en este momento. Misma validación de monto/forma de pago/
// cuenta bancaria que registrarPagoDeFactura, pero sin nada contra qué
// comparar el saldo (no hay factura todavía) — cualquier monto positivo
// vale, es el admin quien decide cuánto se cobró.
export async function registrarCobroSinFactura(clienteId: number, datos: DatosPago, usuarioId: number) {
  const {
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
  } = datos;
  const { montoDecimal, exigeCuentaBancaria } = await validarDatosPago(datos);

  const cliente = await prisma.cliente.findUnique({
    where: { id: clienteId },
    select: {
      id: true,
      razonSocial: true,
      nodoId: true,
      direccionIp: true,
      planInternet: { select: { productoId: true } },
      prorrogaHasta: true,
      fechaContrato: true,
      createdAt: true,
    },
  });
  if (!cliente) throw new Error("CLIENTE_NO_ENCONTRADO");
  if (!cliente.planInternet) throw new Error("SIN_PLAN_INTERNET");

  const pago = await prisma.$transaction((tx: Prisma.TransactionClient) =>
    crearPagoConAsiento(tx, {
      clienteId,
      monto: montoDecimal,
      formaPago,
      referencia,
      cuentaBancariaId: exigeCuentaBancaria ? cuentaBancariaId : undefined,
      bancoOrigenId,
      numeroCuentaOrigen,
      tarjetaUltimosDigitos,
      tarjetaTipo,
      tarjetaReferencia,
      tarjetaLote,
      chequeNumero,
      chequeFechaCobro,
      descripcion: `Cobro anticipado de internet — ${cliente.razonSocial} (pendiente de facturar)`,
      usuarioId,
    })
  );

  // El servicio se reactiva con el COBRO, no hace falta esperar a que
  // alguien pase por "Facturar a todos los pagados" — ver
  // utils/gestionServicioInternet.ts (pagoDeEstePlanEsteMes ya considera
  // este Pago sin facturar como "pagó este mes").
  let avisoInternet: string | undefined;
  const resultado = await reconciliarClienteInternet(cliente);
  if (resultado.accion === "REACTIVADO") {
    avisoInternet = "Servicio de internet reactivado en el Mikrotik.";
  } else if (resultado.error) {
    avisoInternet = `No se pudo reactivar el servicio de internet en el Mikrotik: ${resultado.error}`;
  }

  return { pago, avisoInternet };
}

export function responderErrorRegistrarPago(error: any, res: Response) {
  if (error.message === "MONTO_INVALIDO") return res.status(400).json({ error: "monto debe ser un número mayor a 0" });
  if (error.message === "FORMA_PAGO_OBLIGATORIA") return res.status(400).json({ error: "formaPago es obligatorio" });
  if (error.message === "CUENTA_BANCARIA_OBLIGATORIA") {
    return res.status(400).json({ error: "cuentaBancariaId es obligatorio para esta forma de pago" });
  }
  if (error.message === "CUENTA_BANCARIA_INVALIDA") {
    return res.status(400).json({ error: "La cuenta bancaria indicada no existe o está inactiva" });
  }
  if (error.message === "FACTURA_NO_ENCONTRADA") return res.status(404).json({ error: "Factura no encontrada" });
  if (error.message === "FACTURA_ANULADA") {
    return res.status(409).json({ error: "No se puede registrar un pago sobre una factura anulada" });
  }
  if (error.message === "CLIENTE_NO_ENCONTRADO") return res.status(404).json({ error: "Cliente no encontrado" });
  if (error.message === "SIN_PLAN_INTERNET") {
    return res.status(400).json({ error: "Este cliente no tiene un plan de internet asignado" });
  }
  if (typeof error.message === "string" && error.message.startsWith("MONTO_SUPERA_SALDO")) {
    return res.status(400).json({ error: `El monto supera el saldo pendiente ($${error.message.split(":")[1]})` });
  }
  if (typeof error.message === "string" && error.message.startsWith("MONTO_DEBE_COINCIDIR_CUOTA")) {
    const [, numero, monto] = error.message.split(":");
    return res.status(400).json({ error: `Este documento tiene un plan de cuotas: hay que pagar la cuota ${numero} por $${monto} exacto, en orden` });
  }
  if (error.message === "CUOTAS_VACIAS") return res.status(400).json({ error: "El plan de cuotas no puede estar vacío" });
  if (error.message === "CUOTAS_NUMERO_INVALIDO") {
    return res.status(400).json({ error: "Las cuotas deben numerarse 1, 2, 3... sin saltos ni repetidos" });
  }
  if (error.message === "CUOTAS_MONTO_INVALIDO") return res.status(400).json({ error: "El monto de cada cuota debe ser mayor a 0" });
  if (error.message === "CUOTAS_FECHA_INVALIDA") return res.status(400).json({ error: "Cada cuota necesita una fecha de vencimiento válida" });
  console.error(error);
  return res.status(500).json({ error: "Error al registrar el pago" });
}

facturasRouter.post("/:id/pagos", requirePermiso("ventas"), async (req: Request, res: Response) => {
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
    const resultado = await registrarPagoDeFactura(
      id,
      {
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
      },
      req.usuario!.usuarioId
    );
    res.status(201).json({ ...resultado.factura, avisoInternet: resultado.avisoInternet });
  } catch (error: any) {
    responderErrorRegistrarPago(error, res);
  }
});

// DELETE /facturas/:id/pagos/:pagoId
// Corrige un pago mal registrado (ej. un abono parcial que por error quedó
// registrado por el monto total) — lo borra y recalcula montoPagado/estadoPago.
facturasRouter.delete("/:id/pagos/:pagoId", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const pagoId = Number(req.params.pagoId);

    const factura = await prisma.factura.findUnique({ where: { id } });
    if (!factura) return res.status(404).json({ error: "Factura no encontrada" });

    const pago = await prisma.pago.findUnique({ where: { id: pagoId } });
    if (!pago || pago.facturaId !== id) {
      return res.status(404).json({ error: "Pago no encontrado" });
    }

    const facturaActualizada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.pago.delete({ where: { id: pagoId } });
      // Si este pago había liquidado una Cuota, la reabrimos — si no, el
      // plan quedaría con esa cuota marcada PAGADA sin ningún Pago real que
      // lo respalde, y ROTA la regla de "se cobra en orden" para siempre.
      if (pago.cuotaId) {
        await tx.cuota.update({ where: { id: pago.cuotaId }, data: { estado: "PENDIENTE" } });
      }
      await revertirAsientoDeOrigen(tx, "PAGO", pagoId, req.usuario!.usuarioId);
      const nuevoMontoPagado = factura.montoPagado.sub(pago.monto);
      const actualizada = await tx.factura.update({
        where: { id },
        data: { montoPagado: nuevoMontoPagado, estadoPago: calcularEstadoPago(nuevoMontoPagado, factura.total) },
        include: {
          pagos: { orderBy: { fecha: "desc" }, include: { cuentaBancaria: true, bancoOrigen: true, cuota: { select: { numero: true } } } },
          cuotas: { orderBy: { numero: "asc" } },
        },
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "ELIMINAR_PAGO",
        entidad: "Factura",
        entidadId: id,
        detalle: `Factura ${factura.secuencial}: pago de $${pago.monto.toFixed(2)} (${pago.formaPago})`,
      });

      return actualizada;
    });

    res.json(facturaActualizada);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al eliminar el pago" });
  }
});

// GET /facturas/:id/xml
// Genera y devuelve el XML SIN FIRMAR de una factura ya existente.
// Útil para revisar visualmente la estructura antes de pasar a la firma.
facturasRouter.get("/:id/xml", requirePermiso("facturas_sri"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const factura = await prisma.factura.findUnique({
      where: { id },
      include: { cliente: true, detalles: { include: { producto: true } }, pagos: { orderBy: { fecha: "asc" }, take: 1 } },
    });

    if (!factura) return res.status(404).json({ error: "Factura no encontrada" });
    if (!factura.claveAcceso) {
      return res.status(400).json({ error: "Esta factura no tiene clave de acceso generada" });
    }

    const xml = construirXmlDeFactura(factura);

    res.set("Content-Type", "application/xml");
    res.send(xml);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el XML" });
  }
});

// GET /facturas/:id/xml-firmado
// Genera el XML y lo firma con XAdES-BES usando el certificado configurado en .env
facturasRouter.get("/:id/xml-firmado", requirePermiso("facturas_sri"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const factura = await prisma.factura.findUnique({
      where: { id },
      include: { cliente: true, detalles: { include: { producto: true } }, pagos: { orderBy: { fecha: "asc" }, take: 1 } },
    });

    if (!factura) return res.status(404).json({ error: "Factura no encontrada" });
    if (!factura.claveAcceso) {
      return res.status(400).json({ error: "Esta factura no tiene clave de acceso generada" });
    }

    const empresa = empresaActiva();
    if (!empresa.certificadoP12Password) {
      return res.status(400).json({
        error: "Esta empresa todavía no tiene un certificado .p12 configurado (ver Ajustes) para poder firmar",
      });
    }

    const xmlSinFirmar = construirXmlDeFactura(factura);
    const credenciales = cargarCertificadoP12(rutaAbsoluta(empresa.certificadoP12Path), empresa.certificadoP12Password);
    const xmlFirmado = firmarXadesBes(xmlSinFirmar, credenciales);

    res.set("Content-Type", "application/xml");
    res.send(xmlFirmado);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al firmar el XML: " + error.message });
  }
});

// GET /facturas/:id/ride
// Genera y descarga el RIDE (PDF) de una factura.
facturasRouter.get("/:id/ride", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const factura = await prisma.factura.findUnique({
      where: { id },
      include: { cliente: true, detalles: { include: { producto: true } } },
    });

    if (!factura) return res.status(404).json({ error: "Factura no encontrada" });
    if (!factura.claveAcceso) {
      return res.status(400).json({ error: "Esta factura no tiene clave de acceso generada" });
    }

    const pdfBytes = await generarRidePdf(
      {
        secuencial: factura.secuencial,
        claveAcceso: factura.claveAcceso,
        fechaEmision: factura.fechaEmision,
        subtotal0: factura.subtotal0,
        subtotal12: factura.subtotal12,
        iva: factura.iva,
        total: factura.total,
        estado: factura.estado,
        cliente: factura.cliente,
        detalles: factura.detalles,
      },
      datosEmisorDeEmpresa(empresaActiva())
    );

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="factura-${factura.secuencial}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el RIDE: " + error.message });
  }
});

// GET /facturas/:id/recibo-termico
// Igual que el RIDE, pero en un PDF angosto (80mm) para imprimir en una
// impresora térmica de punto de venta, en vez de una hoja A4 completa.
facturasRouter.get("/:id/recibo-termico", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const factura = await prisma.factura.findUnique({
      where: { id },
      include: { cliente: true, detalles: { include: { producto: true } } },
    });

    if (!factura) return res.status(404).json({ error: "Factura no encontrada" });
    if (!factura.claveAcceso) {
      return res.status(400).json({ error: "Esta factura no tiene clave de acceso generada" });
    }

    const empresa = empresaActiva();
    const pdfBytes = await generarReciboTermicoPdf(
      {
        tipoDocumento: "FACTURA",
        secuencial: factura.secuencial,
        claveAcceso: factura.claveAcceso,
        fechaEmision: factura.fechaEmision,
        estado: factura.estado,
        cliente: factura.cliente,
        detalles: factura.detalles.map((d: (typeof factura.detalles)[number]) => ({
          nombre: d.producto.nombre,
          cantidad: d.cantidad,
          precioUnitario: d.precioUnitario,
          subtotal: d.subtotal,
        })),
        subtotal0: factura.subtotal0,
        subtotal12: factura.subtotal12,
        iva: factura.iva,
        total: factura.total,
        notaPie: "Representación impresa de un comprobante electrónico autorizado por el SRI.",
      },
      { ruc: empresa.ruc, razonSocial: empresa.razonSocial, dirMatriz: empresa.direccionMatriz }
    );

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="factura-${factura.secuencial}-termico.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el recibo térmico: " + error.message });
  }
});

// Firma el XML de una factura, lo envía a Recepción, y si fue recibido,
// espera unos segundos y consulta Autorización. Reusada por la ruta manual
// (POST /:id/enviar-sri), por el disparo automático al final de POST /
// (fire-and-forget, ver ahí), y por el job en segundo plano que reintenta
// las que quedaron CREADA sin enviarse (jobs/reintentoAutorizacionSri.ts).
// Lanza FACTURA_NO_ENCONTRADA / SIN_CLAVE_ACCESO / SIN_CERTIFICADO en vez de
// responder HTTP directamente — cada llamador decide qué hacer con eso.
//
// formaPagoOverride: la forma de pago REAL a declarar en el XML (ver
// construirXmlDeFactura) — la pasa explícita POST / (que la recibe del
// frontend en el mismo instante en que se confirma la venta, ver
// PuntoDeVentaPage.tsx) para no depender de si el abono inicial ya se
// alcanzó a registrar cuando este envío fire-and-forget arranca. El job de
// reintentos y el botón manual "Enviar al SRI" no la tienen a mano — para
// esos, construirXmlDeFactura cae sola al Pago más antiguo ya registrado
// (fetched acá abajo), o a "01" si todavía no hay ninguno.
export async function enviarFacturaAlSri(facturaId: number, formaPagoOverride?: FormaPagoParaXml) {
  const factura = await prisma.factura.findUnique({
    where: { id: facturaId },
    include: {
      cliente: true,
      detalles: { include: { producto: true } },
      pagos: { orderBy: { fecha: "asc" }, take: 1 },
    },
  });

  if (!factura) throw new Error("FACTURA_NO_ENCONTRADA");
  if (!factura.claveAcceso) throw new Error("SIN_CLAVE_ACCESO");

  const empresa = empresaActiva();
  if (!empresa.certificadoP12Password) throw new Error("SIN_CERTIFICADO");

  const urlRecepcion = obtenerUrlsSri(empresa.ambienteSri).recepcion;

  // --- Paso 1: firmar ---
  const xmlSinFirmar = construirXmlDeFactura(factura, formaPagoOverride);
  const credenciales = cargarCertificadoP12(rutaAbsoluta(empresa.certificadoP12Path), empresa.certificadoP12Password);
  const xmlFirmado = firmarXadesBes(xmlSinFirmar, credenciales);

  // --- Paso 2: enviar a Recepción ---
  const recepcion = await enviarComprobanteRecepcion(xmlFirmado, urlRecepcion);

  if (recepcion.estado !== "RECIBIDA") {
    await prisma.factura.update({ where: { id: facturaId }, data: { estado: "RECHAZADA" } });
    return { paso: "recepcion" as const, recepcion };
  }

  await prisma.factura.update({ where: { id: facturaId }, data: { estado: "ENVIADA" } });

  // --- Paso 3: esperar unos segundos y consultar Autorización ---
  // El SRI necesita un momento para procesar internamente antes de tener una respuesta.
  // Si aquí queda "EN_PROCESO", no hace falta volver manualmente: el job en
  // segundo plano (ver jobs/reintentoAutorizacionSri.ts) la vuelve a consultar solo.
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const autorizacion = await verificarYActualizarAutorizacionFactura(facturaId);

  return { paso: "autorizacion" as const, recepcion, autorizacion };
}

// POST /facturas/:id/enviar-sri
// Firma el XML, lo envía a Recepción, y si fue recibido, consulta Autorización.
// Sirve como respaldo manual: normalmente ya no hace falta, porque toda
// factura nueva se envía sola al crearse (ver el fire-and-forget al final de
// POST /) y lo que falle se reintenta solo (ver jobs/reintentoAutorizacionSri.ts).
facturasRouter.post("/:id/enviar-sri", requirePermiso("facturas_sri"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const resultado = await enviarFacturaAlSri(id);

    if (resultado.paso === "recepcion") {
      return res.status(422).json({ paso: "recepcion", resultado: resultado.recepcion });
    }
    res.json(resultado);
  } catch (error: any) {
    if (error.message === "FACTURA_NO_ENCONTRADA") return res.status(404).json({ error: "Factura no encontrada" });
    if (error.message === "SIN_CLAVE_ACCESO") {
      return res.status(400).json({ error: "Esta factura no tiene clave de acceso generada" });
    }
    if (error.message === "SIN_CERTIFICADO") {
      return res.status(400).json({ error: "Esta empresa todavía no tiene un certificado .p12 configurado (ver Ajustes)" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al enviar al SRI: " + error.message });
  }
});

// GET /facturas/:id/consultar-autorizacion
// Vuelve a preguntar el estado, sin reenviar (útil si quedó "EN_PROCESO").
// Esto ahora es solo un atajo manual — el job en segundo plano ya hace esta
// misma consulta automáticamente cada cierto tiempo para todo lo pendiente.
facturasRouter.get("/:id/consultar-autorizacion", requirePermiso("facturas_sri"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const autorizacion = await verificarYActualizarAutorizacionFactura(id);
    if (!autorizacion) {
      return res.status(404).json({ error: "Factura no encontrada o sin clave de acceso" });
    }
    res.json(autorizacion);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al consultar autorización: " + error.message });
  }
});

// PATCH /facturas/:id/anular
// Anula una factura y devuelve el stock de todos sus productos.
//
// IMPORTANTE (regla de negocio real): esto SOLO aplica a facturas que aún
// no se enviaron al SRI (estado "CREADA"). Una factura ya autorizada por
// el SRI es un documento legal que no se puede simplemente "deshacer" —
// para corregir una venta ya autorizada se necesita una Nota de Crédito,
// que es un comprobante electrónico distinto (lo veremos en otra lección).
facturasRouter.patch("/:id/anular", requirePermiso("facturas_anular"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    const factura = await prisma.factura.findUnique({
      where: { id },
      include: { detalles: { include: { producto: true } } },
    });

    if (!factura) return res.status(404).json({ error: "Factura no encontrada" });

    if (factura.estado !== "CREADA") {
      return res.status(409).json({
        error: `No se puede anular: esta factura ya está en estado "${factura.estado}". ` +
          `Las facturas ya enviadas al SRI requieren una Nota de Crédito para corregirse, no una anulación directa.`,
      });
    }

    // Todo pasa en una sola transacción: o se devuelve el stock de TODOS
    // los productos y se anula la factura, o no pasa nada de nada.
    const facturaAnulada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const detalle of factura.detalles) {
        await tx.producto.update({
          where: { id: detalle.productoId },
          data: { stockActual: { increment: detalle.cantidad } },
        });
        // Los productos sin lote también devuelven el stock a la sucursal y
        // bodega donde se hizo esta venta (los de lote siguen siendo globales).
        if (!detalle.producto.manejaLotes) {
          await tx.stockSucursal.update({
            where: { productoId_sucursalId: { productoId: detalle.productoId, sucursalId: factura.sucursalId } },
            data: { cantidad: { increment: detalle.cantidad } },
          });
          await tx.stockBodega.update({
            where: { productoId_bodegaId: { productoId: detalle.productoId, bodegaId: factura.bodegaId } },
            data: { cantidad: { increment: detalle.cantidad } },
          });
        }
        await tx.movimientoInventario.create({
          data: {
            productoId: detalle.productoId,
            tipo: "ENTRADA",
            cantidad: detalle.cantidad,
            motivo: `Anulación de factura ${factura.secuencial}`,
            sucursalId: detalle.producto.manejaLotes ? null : factura.sucursalId,
            bodegaId: detalle.producto.manejaLotes ? null : factura.bodegaId,
          },
        });
      }

      const anulada = await tx.factura.update({ where: { id }, data: { estado: "ANULADA" } });

      await revertirAsientoDeOrigen(tx, "FACTURA", id, req.usuario!.usuarioId);

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "ANULAR_FACTURA",
        entidad: "Factura",
        entidadId: id,
        detalle: `Factura ${factura.secuencial}`,
      });

      return anulada;
    });

    res.json({ mensaje: "Factura anulada y stock devuelto", factura: facturaAnulada });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al anular la factura" });
  }
});

// Traduce los Error("CODIGO:detalle") que puede lanzar crearFacturaConItems
// (y todo lo que valida antes de llamarla: sucursal/bodega) a una respuesta
// HTTP legible — compartido entre POST / acá y routes/facturasInternet.ts,
// para no duplicar este mismo mapeo en los dos lugares.
export function responderErrorCrearFactura(error: any, res: Response) {
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
  return res.status(500).json({ error: "Error al crear la factura" });
}

// POST /facturas
// Body esperado: { clienteId: number, items: [{ productoId, cantidad, descuento? }] }
facturasRouter.post("/", requirePermiso("ventas"), async (req: Request, res: Response) => {
  const { clienteId, bodegaId, items, fechaVencimiento } = req.body as CrearFacturaBody;
  // Forma de pago que el cajero eligió en pantalla AL MOMENTO de confirmar
  // la venta (ver PuntoDeVentaPage.tsx) — opcional (una venta que queda
  // 100% PENDIENTE no tiene ninguna elegida), y a propósito NO crea ningún
  // Pago acá: eso lo sigue haciendo la llamada aparte a POST /:id/pagos.
  // Solo sirve para que el XML que se manda al SRI (ver más abajo) declare
  // la forma de pago real, sin depender de si ese otro POST ya se alcanzó a
  // procesar cuando arranca el envío automático.
  const { formaPago, tarjetaTipo } = req.body as { formaPago?: string; tarjetaTipo?: string };

  if (!clienteId || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "clienteId e items (con al menos 1 producto) son obligatorios" });
  }

  try {
    const factura = await crearFacturaConItems(req.usuario!.usuarioId, { clienteId, bodegaId, items, fechaVencimiento });

    res.status(201).json(factura);

    // Envío automático al SRI, EN SEGUNDO PLANO: la venta ya se confirmó al
    // cajero arriba, así que esto no debe hacerlo esperar los ~5-10s que
    // tarda firmar+enviar+consultar Autorización. Si falla por lo que sea
    // (sin certificado, sin internet, el SRI caído), la factura simplemente
    // se queda en CREADA — nunca se revierte la venta ya guardada — y el job
    // en segundo plano (jobs/reintentoAutorizacionSri.ts) la reintenta sola
    // un par de minutos después.
    enviarFacturaAlSri(factura.id, formaPago ? { formaPago, tarjetaTipo } : undefined).catch((error: any) => {
      console.error(`[auto-envio-sri] Factura ${factura.secuencial} quedó CREADA sin poder enviarse: ${error.message}`);
    });
  } catch (error: any) {
    responderErrorCrearFactura(error, res);
  }
});
