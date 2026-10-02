// Portal del cliente — páginas PÚBLICAS (sin cuenta de usuario del sistema)
// donde el cliente de internet consulta su plan y si está al día, descarga
// sus facturas, sube el comprobante de una transferencia y reporta una falla.
// Lo que el cliente manda entra como ticket de soporte (ver routes/tickets.ts):
// el personal lo atiende desde la bandeja de siempre.
//
// Seguridad:
//  - El cliente se identifica con su cédula/RUC + los últimos 4 dígitos del
//    teléfono registrado. Es la verificación habitual de un ISP por teléfono;
//    se limitan los intentos fallidos por IP para que no se pueda adivinar.
//  - El token del portal se firma con un secreto DISTINTO al del personal
//    (JWT_SECRET + sufijo), así requireAuth lo rechaza en todo el sistema
//    interno sin tener que tocarlo, y viceversa.
//  - Cada consulta filtra por el clienteId del token: un cliente nunca ve
//    datos de otro.
import { Router, Request, Response, NextFunction } from "express";
import * as fs from "fs";
import * as path from "path";
import jwt from "jsonwebtoken";
import multer from "multer";
import { Prisma } from "@prisma/client";
import { prisma, ejecutarConEmpresa, empresaActiva } from "../db";
import { obtenerEmpresa, rutaAbsoluta, datosEmisorDeEmpresa } from "../utils/empresas";
import { normalizarTelefonoEcuador } from "../utils/whatsapp";
import { ventanaCicloActual, enPrimerCiclo, fechaLimitePago } from "../utils/gestionServicioInternet";
import { generarRidePdf } from "../utils/generarRide";
import { alertaCorteDelCliente } from "../utils/tickets";
import { promocionesVigentesHoy, descuentoParaCliente } from "./facturasInternet";

export const portalRouter = Router();

const SECRETO_PORTAL = `${process.env.JWT_SECRET || "cambia-esto-en-produccion"}::portal-cliente`;
const DURACION_SESION = "2h";

interface SesionPortal {
  tipo: "portal";
  clienteId: number;
  empresaId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      portal?: SesionPortal;
    }
  }
}

// --- Límite de intentos fallidos (en memoria) ---
// Por cédula: 5 intentos cada 15 min — es lo que impide adivinar los 4
// dígitos de un cliente puntual. Por IP: un tope más alto (30), porque detrás
// de Nginx todas las peticiones pueden llegar con la misma IP y un tope bajo
// bloquearía a todos los clientes a la vez.
const MAX_FALLOS_CEDULA = 5;
const MAX_FALLOS_IP = 30;
const VENTANA_FALLOS_MS = 15 * 60_000;
const fallos = new Map<string, { cantidad: number; desde: number }>();

function bloqueado(clave: string, maximo: number): boolean {
  const f = fallos.get(clave);
  if (!f) return false;
  if (Date.now() - f.desde > VENTANA_FALLOS_MS) {
    fallos.delete(clave);
    return false;
  }
  return f.cantidad >= maximo;
}
function registrarFallo(clave: string) {
  const f = fallos.get(clave);
  if (!f || Date.now() - f.desde > VENTANA_FALLOS_MS) fallos.set(clave, { cantidad: 1, desde: Date.now() });
  else f.cantidad++;
}

function requirePortal(req: Request, res: Response, next: NextFunction) {
  const cabecera = req.headers.authorization;
  if (!cabecera?.startsWith("Bearer ")) return res.status(401).json({ error: "Ingresa con tu cédula para continuar." });
  try {
    const sesion = jwt.verify(cabecera.slice(7), SECRETO_PORTAL) as SesionPortal;
    if (sesion.tipo !== "portal" || !sesion.clienteId || !obtenerEmpresa(sesion.empresaId)) throw new Error();
    req.portal = sesion;
    ejecutarConEmpresa(sesion.empresaId, () => next());
  } catch {
    res.status(401).json({ error: "Tu sesión expiró. Vuelve a ingresar." });
  }
}

// GET /portal/:empresaId/empresa — nombre para la pantalla de ingreso.
portalRouter.get("/:empresaId/empresa", (req: Request, res: Response) => {
  const empresa = obtenerEmpresa(String(req.params.empresaId));
  if (!empresa) return res.status(404).json({ error: "Empresa no encontrada" });
  res.json({ id: empresa.id, nombre: empresa.nombre });
});

// POST /portal/:empresaId/ingresar  Body: { identificacion, ultimos4 }
portalRouter.post("/:empresaId/ingresar", async (req: Request, res: Response) => {
  const empresaId = String(req.params.empresaId);
  if (!obtenerEmpresa(empresaId)) return res.status(404).json({ error: "Empresa no encontrada" });

  const identificacion = String(req.body?.identificacion ?? "").replace(/\D/g, "");
  const ultimos4 = String(req.body?.ultimos4 ?? "").replace(/\D/g, "");
  if (identificacion.length < 10 || ultimos4.length !== 4) {
    return res.status(400).json({ error: "Escribe tu cédula o RUC y los últimos 4 dígitos de tu teléfono." });
  }

  const claveCedula = `${empresaId}|ced|${identificacion}`;
  const claveIp = `${empresaId}|ip|${req.ip}`;
  if (bloqueado(claveCedula, MAX_FALLOS_CEDULA) || bloqueado(claveIp, MAX_FALLOS_IP)) {
    return res.status(429).json({ error: "Demasiados intentos. Espera 15 minutos o comunícate con nosotros." });
  }

  try {
    await ejecutarConEmpresa(empresaId, async () => {
      const cliente = await prisma.cliente.findUnique({ where: { identificacion }, select: { id: true, activo: true, telefono: true, razonSocial: true } });
      const telefono = cliente?.telefono ? normalizarTelefonoEcuador(cliente.telefono) ?? cliente.telefono.replace(/\D/g, "") : "";
      // Mismo mensaje para "no existe" y "teléfono no coincide": no revelar
      // a un tercero si una cédula es cliente o no.
      if (!cliente || !cliente.activo || !telefono || !telefono.endsWith(ultimos4)) {
        registrarFallo(claveCedula);
        registrarFallo(claveIp);
        return res.status(401).json({ error: "Los datos no coinciden con ningún cliente activo. Revisa tu cédula y los 4 últimos dígitos del teléfono que nos diste." });
      }
      fallos.delete(claveCedula);
      const token = jwt.sign({ tipo: "portal", clienteId: cliente.id, empresaId } satisfies SesionPortal, SECRETO_PORTAL, { expiresIn: DURACION_SESION });
      res.json({ token, nombre: cliente.razonSocial });
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No pudimos verificar tus datos. Intenta de nuevo." });
  }
});

// GET /portal/yo — plan, estado de pago del mes, facturas y tickets.
portalRouter.get("/yo", requirePortal, async (req: Request, res: Response) => {
  try {
    const cliente = await prisma.cliente.findUnique({
      where: { id: req.portal!.clienteId },
      select: {
        id: true,
        razonSocial: true,
        identificacion: true,
        direccion: true,
        telefono: true,
        email: true,
        fechaContrato: true,
        createdAt: true,
        prorrogaHasta: true,
        planInternet: { select: { id: true, nombre: true, precio: true, velocidadBajada: true, velocidadSubida: true, productoId: true } },
      },
    });
    if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });

    const hoy = new Date();
    let pago: { estado: "AL_DIA" | "PENDIENTE" | "VENCIDO" | "SIN_PLAN"; fechaLimite: Date | null; monto: string | null } = { estado: "SIN_PLAN", fechaLimite: null, monto: null };
    if (cliente.planInternet) {
      const promos = await promocionesVigentesHoy(hoy);
      const { descuento } = descuentoParaCliente(promos, cliente, cliente.planInternet, hoy);
      const monto = cliente.planInternet.precio.sub(descuento ?? 0);
      const { inicio, fin } = ventanaCicloActual(cliente);
      const productoId = cliente.planInternet.productoId;
      const pagado =
        (productoId &&
          (await prisma.factura.findFirst({ where: { clienteId: cliente.id, estadoPago: "PAGADA", fechaEmision: { gte: inicio, lt: fin }, detalles: { some: { productoId } } }, select: { id: true } }))) ||
        (await prisma.pago.findFirst({ where: { clienteId: cliente.id, facturaId: null, fecha: { gte: inicio, lt: fin } }, select: { id: true } }));
      const limite = fechaLimitePago(cliente);
      limite.setHours(23, 59, 59, 999);
      pago = {
        estado: pagado || enPrimerCiclo(cliente) ? "AL_DIA" : limite >= hoy || (cliente.prorrogaHasta && cliente.prorrogaHasta >= hoy) ? "PENDIENTE" : "VENCIDO",
        fechaLimite: cliente.prorrogaHasta && cliente.prorrogaHasta > limite ? cliente.prorrogaHasta : limite,
        monto: monto.toFixed(2),
      };
    }

    const [facturas, tickets] = await Promise.all([
      prisma.factura.findMany({
        where: { clienteId: cliente.id, estado: { not: "ANULADA" } },
        orderBy: { fechaEmision: "desc" },
        take: 12,
        select: { id: true, secuencial: true, fechaEmision: true, total: true, montoPagado: true, estadoPago: true, estado: true, claveAcceso: true },
      }),
      prisma.ticketSoporte.findMany({
        where: { clienteId: cliente.id, createdAt: { gte: new Date(hoy.getTime() - 60 * 24 * 3600_000) } },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, asunto: true, estado: true, createdAt: true, fechaResolucion: true, solucion: true },
      }),
    ]);

    res.json({
      nombre: cliente.razonSocial,
      identificacion: cliente.identificacion,
      direccion: cliente.direccion,
      empresa: empresaActiva().nombre,
      plan: cliente.planInternet
        ? { nombre: cliente.planInternet.nombre, bajada: cliente.planInternet.velocidadBajada, subida: cliente.planInternet.velocidadSubida, precio: cliente.planInternet.precio.toFixed(2) }
        : null,
      pago,
      facturas: facturas.map((f) => ({
        id: f.id,
        numero: f.secuencial,
        fecha: f.fechaEmision,
        total: f.total.toFixed(2),
        saldo: f.total.sub(f.montoPagado).toFixed(2),
        estadoPago: f.estadoPago,
        tienePdf: !!f.claveAcceso,
      })),
      tickets,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No pudimos cargar tu información." });
  }
});

// GET /portal/facturas/:id/pdf — solo facturas del propio cliente.
portalRouter.get("/facturas/:id/pdf", requirePortal, async (req: Request, res: Response) => {
  try {
    const factura = await prisma.factura.findFirst({
      where: { id: Number(req.params.id), clienteId: req.portal!.clienteId },
      include: { cliente: true, detalles: { include: { producto: true } } },
    });
    if (!factura || !factura.claveAcceso) return res.status(404).json({ error: "Factura no encontrada" });
    const pdf = await generarRidePdf(
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
    res.set("Content-Disposition", `attachment; filename="factura-${factura.secuencial}.pdf"`);
    res.send(Buffer.from(pdf));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No pudimos generar la factura." });
  }
});

// --- Comprobante de transferencia (imagen o PDF) ---
const TIPOS_COMPROBANTE = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

function capturarEmpresa(req: Request, _res: Response, next: NextFunction) {
  (req as any).carpetaPortal = path.join(rutaAbsoluta(empresaActiva().carpetaUploads), "portal-comprobantes");
  (req as any).empresaIdPortal = req.portal!.empresaId;
  next();
}

const subirComprobante = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const carpeta = (req as any).carpetaPortal as string;
      if (!fs.existsSync(carpeta)) fs.mkdirSync(carpeta, { recursive: true });
      cb(null, carpeta);
    },
    filename: (req, file, cb) => cb(null, `cliente-${req.portal!.clienteId}-${Date.now()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => (TIPOS_COMPROBANTE.includes(file.mimetype) ? cb(null, true) : cb(new Error("Solo se aceptan fotos (JPG, PNG) o PDF"))),
}).single("comprobante");

// POST /portal/comprobante  multipart: comprobante (archivo), monto, referencia?, banco?
portalRouter.post("/comprobante", requirePortal, capturarEmpresa, (req: Request, res: Response) => {
  subirComprobante(req, res, async (error: any) => {
    if (error) return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "El archivo puede pesar como máximo 5 MB" : error.message });
    const archivo = req.file;
    const empresaId = (req as any).empresaIdPortal as string;
    try {
      await ejecutarConEmpresa(empresaId, async () => {
        const monto = Number(String(req.body.monto ?? "").replace(",", "."));
        if (!archivo) return res.status(400).json({ error: "Adjunta la foto o el PDF del comprobante" });
        if (!(monto > 0)) {
          fs.unlinkSync(archivo.path);
          return res.status(400).json({ error: "Escribe el monto que transferiste" });
        }
        const cliente = await prisma.cliente.findUnique({ where: { id: req.portal!.clienteId }, select: { id: true, razonSocial: true, telefono: true } });
        const url = `/uploads/${empresaId}/portal-comprobantes/${archivo.filename}`;
        const referencia = String(req.body.referencia ?? "").slice(0, 80).trim();
        const banco = String(req.body.banco ?? "").slice(0, 60).trim();
        const ticket = await prisma.ticketSoporte.create({
          data: {
            clienteId: cliente!.id,
            nombreContacto: cliente!.razonSocial,
            telefono: cliente!.telefono ? normalizarTelefonoEcuador(cliente!.telefono) : null,
            canal: "PORTAL",
            categoria: "FACTURACION",
            prioridad: "MEDIA",
            asunto: `Comprobante de pago enviado desde el portal: $${new Prisma.Decimal(monto).toFixed(2)}`,
            mensajes: {
              create: {
                autor: "CLIENTE",
                texto: [`Transferencia por $${monto.toFixed(2)}`, banco && `Banco: ${banco}`, referencia && `Referencia: ${referencia}`, `Comprobante: ${url}`]
                  .filter(Boolean)
                  .join("\n"),
              },
            },
          },
        });
        res.status(201).json({ ticketId: ticket.id, mensaje: "Recibimos tu comprobante. Lo verificaremos y registraremos tu pago." });
      });
    } catch (e) {
      if (archivo) fs.unlink(archivo.path, () => {});
      console.error(e);
      res.status(500).json({ error: "No pudimos recibir tu comprobante. Intenta de nuevo." });
    }
  });
});

// POST /portal/falla  Body: { categoria, descripcion }
const CATEGORIAS_FALLA: Record<string, { categoria: string; prioridad: string; asunto: string }> = {
  SIN_SERVICIO: { categoria: "SIN_SERVICIO", prioridad: "ALTA", asunto: "No tengo internet" },
  LENTITUD: { categoria: "LENTITUD", prioridad: "MEDIA", asunto: "El internet está lento" },
  INTERMITENCIA: { categoria: "INTERMITENCIA", prioridad: "MEDIA", asunto: "El internet se corta a ratos" },
  OTRO: { categoria: "OTRO", prioridad: "MEDIA", asunto: "Otro problema" },
};

portalRouter.post("/falla", requirePortal, async (req: Request, res: Response) => {
  try {
    const tipo = CATEGORIAS_FALLA[String(req.body?.categoria)] ?? CATEGORIAS_FALLA.OTRO;
    const descripcion = String(req.body?.descripcion ?? "").trim().slice(0, 1000);
    const clienteId = req.portal!.clienteId;

    const abierto = await prisma.ticketSoporte.findFirst({
      where: { clienteId, estado: { in: ["ABIERTO", "EN_PROCESO"] }, categoria: { in: ["SIN_SERVICIO", "LENTITUD", "INTERMITENCIA", "OTRO"] } },
      orderBy: { createdAt: "desc" },
    });
    if (abierto) {
      await prisma.mensajeTicket.create({ data: { ticketId: abierto.id, autor: "CLIENTE", texto: `(desde el portal) ${tipo.asunto}${descripcion ? `: ${descripcion}` : ""}` } });
      return res.json({ ticketId: abierto.id, mensaje: `Ya tienes un reporte abierto (#${abierto.id}). Agregamos tu mensaje y lo estamos atendiendo.` });
    }

    const cliente = await prisma.cliente.findUnique({ where: { id: clienteId }, select: { razonSocial: true, telefono: true } });
    const alertaRedId = tipo.categoria === "SIN_SERVICIO" ? await alertaCorteDelCliente(clienteId) : null;
    const ticket = await prisma.ticketSoporte.create({
      data: {
        clienteId,
        nombreContacto: cliente!.razonSocial,
        telefono: cliente!.telefono ? normalizarTelefonoEcuador(cliente!.telefono) : null,
        canal: "PORTAL",
        categoria: tipo.categoria,
        prioridad: tipo.prioridad,
        asunto: tipo.asunto,
        alertaRedId,
        mensajes: {
          create: [
            ...(descripcion ? [{ autor: "CLIENTE", texto: descripcion }] : []),
            ...(alertaRedId ? [{ autor: "SISTEMA", texto: "Este cliente está en un sector con una falla de red ya detectada." }] : []),
          ],
        },
      },
    });
    res.status(201).json({
      ticketId: ticket.id,
      mensaje: alertaRedId
        ? `Recibimos tu reporte (#${ticket.id}). Ya detectamos una falla en tu sector y nuestro equipo técnico está trabajando en ella.`
        : `Recibimos tu reporte (#${ticket.id}). Te contactaremos pronto.`,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No pudimos registrar tu reporte. Intenta de nuevo." });
  }
});
