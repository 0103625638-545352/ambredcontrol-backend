// Facturación del servicio de internet — pantalla SEPARADA de Facturas a
// propósito (ver conversación que llevó a esto): la venta de equipos/visitas
// técnicas sigue por POST /facturas eligiendo productos a mano; esto es un
// atajo de UN clic por cliente para la facturación mensual recurrente, sin
// mezclar los dos flujos en la misma pantalla. Sigue siendo manual (nunca
// automático/programado) — el admin decide cuándo factura a cada cliente.
//
// Reusa TODO el motor legal de routes/facturas.ts (secuencial, clave de
// acceso, envío al SRI): la única diferencia es que el "carrito" siempre
// trae un solo ítem, el Producto espejo del PlanInternet del cliente (ver
// utils/planProducto.ts) — por eso un cliente de internet, para el SRI y la
// contabilidad, es una Factura común y corriente.
import { Router, Request, Response, NextFunction } from "express";
import * as fs from "fs";
import * as path from "path";
import multer from "multer";
import { Prisma } from "@prisma/client";
import { prisma, empresaActiva, empresaActivaId, ejecutarConEmpresa } from "../db";
import { rutaAbsoluta } from "../utils/empresas";
import { sucursalDelUsuarioActual } from "../utils/sucursales";
import { sincronizarProductoDePlan } from "../utils/planProducto";
import { calcularEstadoPago } from "../utils/estadoPago";
import {
  crearFacturaConItems,
  enviarFacturaAlSri,
  responderErrorCrearFactura,
  registrarPagoDeFactura,
  registrarCobroSinFactura,
  responderErrorRegistrarPago,
} from "./facturas";

export const facturasInternetRouter = Router();

// multer procesa el archivo con busboy, en callbacks que corren mientras el
// body todavía se está leyendo del socket — bajo carga real de un navegador
// (a diferencia de un POST chico armado a mano, ej. con curl), ese
// procesamiento puede terminar corriendo FUERA del AsyncLocalStorage de la
// empresa activa (ver ejecutarConEmpresa en db.ts), y empresaActiva()/
// prisma explotarían con "No hay una empresa activa en este contexto"
// justo ahí. Por eso el empresaId se lee ACÁ (un middleware común y
// corriente, sincrónico, todavía dentro del contexto de requireAuth) y
// tanto el storage de multer como el handler final vuelven a entrar al
// contexto ellos mismos con este valor, en vez de confiar en que
// sobrevive intacto a través de todo el procesamiento del archivo.
function capturarEmpresaAntesDeMulter(req: Request, _res: Response, next: NextFunction) {
  (req as any).empresaIdParaUpload = empresaActivaId();
  (req as any).carpetaUploadsParaUpload = empresaActiva().carpetaUploads;
  next();
}

// --- Subida de la captura del comprobante de pago (transferencia/depósito) ---
// Mismo criterio que la foto de Producto (ver routes/productos.ts): se
// guarda en disco, la base solo guarda la ruta relativa (Pago.comprobanteUrl).
function carpetaComprobantesPagoActiva(req: Request): string {
  const carpeta = path.join(rutaAbsoluta((req as any).carpetaUploadsParaUpload), "pagos-internet");
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
  }
  return carpeta;
}

const TIPOS_IMAGEN_PERMITIDOS = ["image/jpeg", "image/png", "image/webp"];
const TAMANO_MAXIMO_IMAGEN = 5 * 1024 * 1024; // 5MB

const almacenamientoComprobante = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, carpetaComprobantesPagoActiva(req)),
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `pago-internet-${req.params.clienteId}-${Date.now()}${extension}`);
  },
});

const subirComprobante = multer({
  storage: almacenamientoComprobante,
  limits: { fileSize: TAMANO_MAXIMO_IMAGEN },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_IMAGEN_PERMITIDOS.includes(file.mimetype)) {
      return cb(new Error("Solo se permiten imágenes JPG, PNG o WEBP"));
    }
    cb(null, true);
  },
});

// multer reporta sus propios errores (tipo/tamaño inválido) llamando a
// next(error) — sin este wrapper, Express los mostraría como una página de
// error genérica en vez de un JSON consistente con el resto de la API. El
// comprobante es OPCIONAL, así que .single() nunca rechaza por "no vino
// archivo" — eso lo valida el handler solo si hace falta.
function subirComprobanteMiddleware(req: Request, res: Response, next: NextFunction) {
  subirComprobante.single("comprobante")(req, res, (error: any) => {
    if (error?.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "La imagen no puede pesar más de 5MB" });
    }
    if (error) {
      return res.status(400).json({ error: error.message || "Error al subir el comprobante" });
    }
    next();
  });
}

// GET /facturas-internet/clientes
// Todo cliente con un plan de internet asignado (con o sin direccionIp/nodo
// — un cliente recién creado puede no tener IP asignada todavía, pero ya se
// le puede cobrar/facturar el plan). Trae la fecha de la última factura de
// ESE plan (para saber si ya se facturó este período) Y si tiene algún
// cobro registrado TODAVÍA SIN FACTURAR (ver POST /:clienteId/pago y
// POST /facturar-pagados) — son las dos cosas que
// FacturacionInternetPage.tsx necesita para decidir qué mostrar/ofrecer por
// cada cliente, sin ir a revisar el historial de cada uno a mano.
facturasInternetRouter.get("/clientes", async (_req: Request, res: Response) => {
  try {
    const clientes = await prisma.cliente.findMany({
      where: { planInternetId: { not: null } },
      include: {
        planInternet: true,
        nodo: { select: { id: true, nombre: true } },
      },
      orderBy: { razonSocial: "asc" },
    });

    const resultado = await Promise.all(
      clientes.map(async (cliente) => {
        const productoId = cliente.planInternet?.productoId ?? null;
        const ultimaFactura = productoId
          ? await prisma.factura.findFirst({
              where: { clienteId: cliente.id, detalles: { some: { productoId } } },
              orderBy: { fechaEmision: "desc" },
              select: { id: true, secuencial: true, fechaEmision: true, estado: true, estadoPago: true, total: true, montoPagado: true },
            })
          : null;

        const cobrosSinFacturar = await prisma.pago.findMany({
          where: { clienteId: cliente.id, facturaId: null },
          orderBy: { fecha: "desc" },
          select: { id: true, monto: true, fecha: true, formaPago: true },
        });
        const cobroPendiente =
          cobrosSinFacturar.length > 0
            ? {
                cantidad: cobrosSinFacturar.length,
                total: cobrosSinFacturar.reduce((acc, p) => acc.add(p.monto), new Prisma.Decimal(0)).toFixed(2),
                ultimaFecha: cobrosSinFacturar[0].fecha,
              }
            : null;

        return { ...cliente, ultimaFacturaInternet: ultimaFactura, cobroPendiente };
      })
    );

    res.json(resultado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los clientes de internet" });
  }
});

// POST /facturas-internet/facturar-pagados
// El paso del "06 en adelante": genera la Factura de TODO cliente que tenga
// algún cobro registrado sin facturar todavía (ver POST /:clienteId/pago),
// y adopta esos mismos Pago (les pone facturaId) en vez de crear otros
// nuevos — así la factura nace YA pagada, sin que el admin tenga que volver
// a registrar el cobro. Sigue siendo una acción manual (un botón, un clic);
// lo único "automático" es no tener que repetir la facturación una por una.
// No reconcilia el Mikrotik acá — el servicio de cada cliente ya se
// reactivó al momento de REGISTRAR su cobro (ver registrarCobroSinFactura),
// no hace falta repetir esa llamada de red por cada uno de miles de
// clientes solo para volver a confirmar lo mismo.
//
// OJO de registro: montada ANTES de POST /:clienteId a propósito — si
// quedara después, Express le pasaría "facturar-pagados" como si fuera un
// :clienteId (matchea igual, un segmento suelto) y esta ruta nunca se
// alcanzaría.
facturasInternetRouter.post("/facturar-pagados", async (req: Request, res: Response) => {
  try {
    const pagosPendientes = await prisma.pago.findMany({
      where: { facturaId: null, clienteId: { not: null } },
      include: { cliente: { include: { planInternet: true } } },
      orderBy: { fecha: "asc" },
    });

    const porCliente = new Map<number, typeof pagosPendientes>();
    for (const pago of pagosPendientes) {
      if (!pago.clienteId) continue;
      const lista = porCliente.get(pago.clienteId) ?? [];
      lista.push(pago);
      porCliente.set(pago.clienteId, lista);
    }

    if (porCliente.size === 0) {
      return res.json({ total: 0, exitosos: 0, fallidos: 0, detalle: [] });
    }

    // La sucursal/bodega de quien factura es la MISMA para todos los
    // clientes de esta tanda — se calcula una sola vez, no por cliente.
    const sucursal = await sucursalDelUsuarioActual(req.usuario!.usuarioId);
    const bodega = await prisma.bodega.findFirst({ where: { sucursalId: sucursal.id, activa: true }, orderBy: { id: "asc" } });

    const detalle: { clienteId: number; razonSocial: string; ok: boolean; secuencial?: string; error?: string }[] = [];

    for (const [clienteId, pagos] of porCliente) {
      const cliente = pagos[0].cliente!;
      try {
        if (!bodega) throw new Error("Tu sucursal no tiene ninguna bodega activa");
        if (!cliente.planInternet) throw new Error("Ya no tiene un plan de internet asignado");
        if (!cliente.planInternet.activo) throw new Error("Su plan de internet está desactivado");

        const productoId = cliente.planInternet.productoId
          ? cliente.planInternet.productoId
          : await prisma.$transaction((tx) => sincronizarProductoDePlan(tx, cliente.planInternet!));

        const factura = await crearFacturaConItems(req.usuario!.usuarioId, {
          clienteId,
          bodegaId: bodega.id,
          items: [{ productoId, cantidad: 1 }],
        });

        // Adopta los Pago que ya existían (les pone el facturaId recién
        // creado) y recalcula montoPagado/estadoPago con lo que ya se
        // había cobrado — nunca crea un Pago nuevo acá.
        const totalCobrado = pagos.reduce((acc, p) => acc.add(p.monto), new Prisma.Decimal(0));
        const facturaActualizada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.pago.updateMany({ where: { id: { in: pagos.map((p) => p.id) } }, data: { facturaId: factura.id } });
          return tx.factura.update({
            where: { id: factura.id },
            data: { montoPagado: totalCobrado, estadoPago: calcularEstadoPago(totalCobrado, factura.total) },
          });
        });

        enviarFacturaAlSri(factura.id).catch((error: any) => {
          console.error(`[auto-envio-sri] Factura de internet ${factura.secuencial} quedó CREADA sin poder enviarse: ${error.message}`);
        });

        detalle.push({ clienteId, razonSocial: cliente.razonSocial, ok: true, secuencial: facturaActualizada.secuencial });
      } catch (error: any) {
        detalle.push({ clienteId, razonSocial: cliente.razonSocial, ok: false, error: error.message });
      }
    }

    res.json({
      total: detalle.length,
      exitosos: detalle.filter((d) => d.ok).length,
      fallidos: detalle.filter((d) => !d.ok).length,
      detalle,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al facturar los pagos pendientes" });
  }
});

// POST /facturas-internet/:clienteId
// Factura de un clic: un solo ítem, el Producto espejo del plan actual del
// cliente. No valida si ya se facturó este período — queda a criterio del
// admin (ver ultimaFacturaInternet arriba), igual que cualquier otra venta
// manual del sistema.
facturasInternetRouter.post("/:clienteId", async (req: Request, res: Response) => {
  try {
    const clienteId = Number(req.params.clienteId);
    const cliente = await prisma.cliente.findUnique({ where: { id: clienteId }, include: { planInternet: true } });
    if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });
    if (!cliente.planInternet) {
      return res.status(400).json({ error: "Este cliente no tiene un plan de internet asignado" });
    }
    if (!cliente.planInternet.activo) {
      return res.status(400).json({ error: "El plan de este cliente está desactivado" });
    }

    // Provisiona el Producto espejo si por lo que sea todavía no existe
    // (planes creados antes de esta función, ver utils/planProducto.ts) —
    // así nunca hace falta ir a "Planes de Internet" solo para destrabar la
    // primera factura.
    const productoId = cliente.planInternet.productoId
      ? cliente.planInternet.productoId
      : await prisma.$transaction((tx) => sincronizarProductoDePlan(tx, cliente.planInternet!));

    // La bodega no tiene ningún efecto real en una factura de puro servicio
    // (esServicio=true nunca descuenta stock, ver crearFacturaConItems) — se
    // completa sola con la primera bodega activa de la sucursal de quien
    // factura, para no pedirle al admin que elija una bodega sin sentido en
    // esta pantalla.
    const sucursal = await sucursalDelUsuarioActual(req.usuario!.usuarioId);
    const bodega = await prisma.bodega.findFirst({ where: { sucursalId: sucursal.id, activa: true }, orderBy: { id: "asc" } });
    if (!bodega) {
      return res.status(400).json({ error: "Tu sucursal no tiene ninguna bodega activa — crea al menos una para poder facturar" });
    }

    const factura = await crearFacturaConItems(req.usuario!.usuarioId, {
      clienteId,
      bodegaId: bodega.id,
      items: [{ productoId, cantidad: 1 }],
    });

    res.status(201).json(factura);

    // Mismo criterio que POST /facturas: el envío al SRI va en segundo
    // plano, para no hacer esperar al admin los ~5-10s de firmar+enviar+
    // consultar Autorización en medio de una tanda de facturación rápida.
    enviarFacturaAlSri(factura.id).catch((error: any) => {
      console.error(`[auto-envio-sri] Factura de internet ${factura.secuencial} quedó CREADA sin poder enviarse: ${error.message}`);
    });
  } catch (error: any) {
    responderErrorCrearFactura(error, res);
  }
});

// POST /facturas-internet/:clienteId/pago
// Ventana de pago dedicada para clientes de internet — a diferencia de
// "Registrar pago" en Facturas (que pide el número de factura), acá el
// admin solo elige AL CLIENTE. Dos casos, sin que el admin tenga que saber
// cuál aplica:
//   (a) ya existe una factura del plan sin pagar (el flujo de siempre:
//       Facturar, después Registrar pago) → el pago se aplica a ESA factura.
//   (b) todavía no existe ninguna (el caso normal durante la ventana de
//       cobro, del 01 al 05, con miles de clientes: no da tiempo a facturar
//       antes de poder cobrar) → se guarda como cobro adelantado
//       (Pago.clienteId, sin facturaId) — la factura se genera después, en
//       lote, con POST /facturar-pagados, y ADOPTA este mismo Pago.
// Body multipart/form-data: monto, formaPago, cuentaBancariaId?,
// referencia?, comprobante? (imagen JPG/PNG/WEBP, la captura de pantalla de
// la transferencia/depósito que mandó el cliente).
facturasInternetRouter.post(
  "/:clienteId/pago",
  capturarEmpresaAntesDeMulter,
  subirComprobanteMiddleware,
  async (req: Request, res: Response) => {
    // Vuelve a entrar al contexto de la empresa explícitamente (ver
    // capturarEmpresaAntesDeMulter arriba) — no asume que sobrevivió intacto
    // a través del procesamiento del archivo por multer.
    const empresaId = (req as any).empresaIdParaUpload as string;
    try {
      await ejecutarConEmpresa(empresaId, async () => {
        const clienteId = Number(req.params.clienteId);
        const cliente = await prisma.cliente.findUnique({ where: { id: clienteId }, include: { planInternet: true } });
        if (!cliente) {
          if (req.file) fs.unlinkSync(req.file.path);
          return res.status(404).json({ error: "Cliente no encontrado" });
        }
        if (!cliente.planInternet) {
          if (req.file) fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: "Este cliente no tiene un plan de internet asignado" });
        }

        const facturaPendiente = cliente.planInternet.productoId
          ? await prisma.factura.findFirst({
              where: {
                clienteId,
                detalles: { some: { productoId: cliente.planInternet.productoId } },
                estadoPago: { not: "PAGADA" },
                estado: { not: "ANULADA" },
              },
              orderBy: { fechaEmision: "desc" },
            })
          : null;

        // multipart/form-data manda todo como texto — a diferencia de POST
        // /facturas/:id/pagos (JSON), acá hay que convertir a mano.
        const monto = Number(req.body.monto);
        const formaPago = req.body.formaPago;
        const referencia = req.body.referencia || undefined;
        const cuentaBancariaId = req.body.cuentaBancariaId ? Number(req.body.cuentaBancariaId) : undefined;
        const datosPago = { monto, formaPago, referencia, cuentaBancariaId };

        const resultado = facturaPendiente
          ? await registrarPagoDeFactura(facturaPendiente.id, datosPago, req.usuario!.usuarioId)
          : await registrarCobroSinFactura(clienteId, datosPago, req.usuario!.usuarioId);
        const pagoId = "pagoId" in resultado ? resultado.pagoId : resultado.pago.id;

        let comprobanteUrl: string | undefined;
        if (req.file) {
          comprobanteUrl = `/uploads/${empresaId}/pagos-internet/${req.file.filename}`;
          await prisma.pago.update({ where: { id: pagoId }, data: { comprobanteUrl } });
        }

        res.status(201).json({
          facturado: "factura" in resultado,
          factura: "factura" in resultado ? resultado.factura : undefined,
          avisoInternet: resultado.avisoInternet,
          comprobanteUrl,
        });
      });
    } catch (error: any) {
      if (req.file) fs.unlinkSync(req.file.path); // no dejamos el archivo huérfano en disco si el pago no se pudo registrar
      responderErrorRegistrarPago(error, res);
    }
  }
);
