// Contrato de servicio firmado en el celular del técnico al terminar una
// instalación (ver utils/contratoServicio.ts). Montado con requireAuth en
// index.ts, sin permiso extra a nivel de router: quien puede firmar es el
// mismo que puede llenar el acta de esa visita (el técnico dueño de la ruta,
// o un administrador) — ver puedeTocarVisita en routes/visitas.ts.
import { Router, Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma, empresaActiva, empresaActivaId } from "../db";
import { rutaAbsoluta, cicloCorteInternet } from "../utils/empresas";
import { leerLogoEmpresa } from "../utils/logoEmpresa";
import { registrarAuditoria } from "../utils/auditoria";
import { puedeTocarVisita } from "./visitas";
import { generarContratoPdf, rellenarPlantilla, TEXTO_CONTRATO_POR_DEFECTO, type DatosContrato } from "../utils/contratoServicio";

export const contratosRouter = Router();

const TAMANO_MAXIMO_FIRMA = 1024 * 1024; // 1 MB de PNG alcanza de sobra para un trazo

function fechaLarga(fecha: Date): string {
  return fecha.toLocaleDateString("es-EC", { day: "numeric", month: "long", year: "numeric" });
}

// GET /contratos/plantilla — el texto vigente (para mostrarlo en la
// pantalla de firma antes de firmar).
contratosRouter.get("/plantilla", (_req: Request, res: Response) => {
  const empresa = empresaActiva();
  res.json({ texto: empresa.textoContratoInternet || TEXTO_CONTRATO_POR_DEFECTO, personalizado: !!empresa.textoContratoInternet });
});

// GET /contratos/visita/:visitaId/vista-previa — el texto ya rellenado con
// los datos de ESTE cliente, para que lo lea antes de firmar.
contratosRouter.get("/visita/:visitaId/vista-previa", async (req: Request, res: Response) => {
  try {
    const visitaId = Number(req.params.visitaId);
    const { ok, visita } = await puedeTocarVisita(req, visitaId);
    if (!visita) return res.status(404).json({ error: "Visita no encontrada" });
    if (!ok) return res.status(403).json({ error: "Esta visita no pertenece a tu ruta" });
    const datos = await datosDelContrato(visitaId);
    if ("error" in datos) return res.status(400).json({ error: datos.error });
    const empresa = empresaActiva();
    res.json({ datos: datos.datos, texto: rellenarPlantilla(empresa.textoContratoInternet || TEXTO_CONTRATO_POR_DEFECTO, datos.datos), equipos: datos.equipos });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al preparar el contrato" });
  }
});

async function datosDelContrato(visitaId: number) {
  const visita = await prisma.visitaTecnica.findUnique({
    where: { id: visitaId },
    include: {
      cliente: { include: { planInternet: true } },
      equiposDejados: { where: { asignacionMetrajeId: null }, select: { tipo: true, modelo: true, serial: true } },
      rutaVisita: { select: { empleado: { select: { nombres: true, apellidos: true } } } },
    },
  });
  if (!visita) return { error: "Visita no encontrada" } as const;
  const cliente = visita.cliente;
  if (!cliente) return { error: "Esta visita no está vinculada a un cliente registrado — regístralo primero en Clientes." } as const;
  if (!cliente.planInternet) return { error: "El cliente todavía no tiene un plan de internet asignado." } as const;

  const empresa = empresaActiva();
  const plan = cliente.planInternet;
  const datos: DatosContrato = {
    empresa: empresa.razonSocial || empresa.nombre,
    rucEmpresa: empresa.ruc,
    direccionEmpresa: empresa.direccionMatriz || "",
    cliente: cliente.razonSocial,
    cedula: cliente.identificacion,
    direccion: [cliente.direccion, cliente.ciudad].filter(Boolean).join(", ") || visita.direccion || "",
    telefono: cliente.telefono || "",
    plan: plan.nombre,
    bajada: plan.velocidadBajada,
    subida: plan.velocidadSubida,
    precio: plan.precio.toFixed(2),
    diaCorte: String(cliente.fechaContrato ? cliente.fechaContrato.getDate() : cicloCorteInternet(empresa).fin),
    fechaInicio: fechaLarga(cliente.fechaInicioServicio ?? visita.fechaLlegadaReal ?? new Date()),
    vigenciaMeses: cliente.vigenciaContratoMeses,
    ciudad: cliente.ciudad || "",
  };
  const tecnico = `${visita.rutaVisita.empleado.nombres.trim()} ${visita.rutaVisita.empleado.apellidos.trim()}`;
  return { datos, equipos: visita.equiposDejados, visita, cliente, plan, tecnico } as const;
}

// POST /contratos/visita/:visitaId
// Body: { firmaPng: "data:image/png;base64,...", nombreFirmante, cedulaFirmante, latitud?, longitud? }
// Si la visita ya tenía contrato, se reemplaza (ej. se firmó mal y se repite).
contratosRouter.post("/visita/:visitaId", async (req: Request, res: Response) => {
  try {
    const visitaId = Number(req.params.visitaId);
    const { ok, visita: v } = await puedeTocarVisita(req, visitaId);
    if (!v) return res.status(404).json({ error: "Visita no encontrada" });
    if (!ok) return res.status(403).json({ error: "Esta visita no pertenece a tu ruta" });

    const nombreFirmante = String(req.body?.nombreFirmante ?? "").trim().slice(0, 150);
    const cedulaFirmante = String(req.body?.cedulaFirmante ?? "").replace(/\s/g, "").slice(0, 20);
    if (!nombreFirmante || cedulaFirmante.length < 10) return res.status(400).json({ error: "Escribe el nombre y la cédula de quien firma" });

    const coincidencia = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.firmaPng ?? ""));
    if (!coincidencia) return res.status(400).json({ error: "Falta la firma del cliente" });
    const firmaPng = Buffer.from(coincidencia[1], "base64");
    if (firmaPng.length > TAMANO_MAXIMO_FIRMA) return res.status(400).json({ error: "La imagen de la firma es demasiado grande" });

    const datos = await datosDelContrato(visitaId);
    if ("error" in datos) return res.status(400).json({ error: datos.error });

    const empresa = empresaActiva();
    const lat = Number(req.body?.latitud);
    const lng = Number(req.body?.longitud);
    const ubicacion = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? { latitud: lat, longitud: lng } : null;
    const fechaFirma = new Date();

    const pdf = await generarContratoPdf({
      datos: datos.datos,
      plantilla: rellenarPlantilla(empresa.textoContratoInternet || TEXTO_CONTRATO_POR_DEFECTO, datos.datos),
      equipos: datos.equipos,
      firmaPng,
      nombreFirmante,
      cedulaFirmante,
      tecnico: datos.tecnico,
      fechaFirma,
      ubicacion,
      logo: leerLogoEmpresa(rutaAbsoluta(empresa.carpetaUploads)),
    });

    // Nombre con parte aleatoria: la carpeta de uploads se sirve sin sesión
    // (como las fotos de las visitas), así la URL no se puede adivinar.
    const carpeta = path.join(rutaAbsoluta(empresa.carpetaUploads), "contratos");
    if (!fs.existsSync(carpeta)) fs.mkdirSync(carpeta, { recursive: true });
    const archivo = `contrato-${datos.cliente.id}-${visitaId}-${crypto.randomBytes(8).toString("hex")}.pdf`;
    fs.writeFileSync(path.join(carpeta, archivo), pdf);
    const pdfUrl = `/uploads/${empresaActivaId()}/contratos/${archivo}`;

    const anterior = await prisma.contratoServicio.findUnique({ where: { visitaId } });
    const contrato = await prisma.contratoServicio.upsert({
      where: { visitaId },
      create: {
        clienteId: datos.cliente.id,
        visitaId,
        pdfUrl,
        nombreFirmante,
        cedulaFirmante,
        plan: datos.plan.nombre,
        precioMensual: datos.plan.precio,
        vigenciaMeses: datos.cliente.vigenciaContratoMeses,
        latitud: ubicacion ? new Prisma.Decimal(ubicacion.latitud.toFixed(6)) : null,
        longitud: ubicacion ? new Prisma.Decimal(ubicacion.longitud.toFixed(6)) : null,
        registradoPorUsuarioId: req.usuario!.usuarioId,
        fecha: fechaFirma,
      },
      update: {
        pdfUrl,
        nombreFirmante,
        cedulaFirmante,
        plan: datos.plan.nombre,
        precioMensual: datos.plan.precio,
        vigenciaMeses: datos.cliente.vigenciaContratoMeses,
        registradoPorUsuarioId: req.usuario!.usuarioId,
        fecha: fechaFirma,
      },
    });
    if (anterior) {
      const viejo = path.join(carpeta, path.basename(anterior.pdfUrl));
      if (fs.existsSync(viejo)) fs.unlinkSync(viejo);
    }

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: anterior ? "REEMPLAZAR_CONTRATO_SERVICIO" : "FIRMAR_CONTRATO_SERVICIO",
      entidad: "ContratoServicio",
      entidadId: contrato.id,
      detalle: `${datos.cliente.razonSocial} — firmó ${nombreFirmante} (${cedulaFirmante}), plan ${datos.plan.nombre}`,
    });
    res.status(201).json(contrato);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al guardar el contrato" });
  }
});

// GET /contratos/cliente/:clienteId — contratos firmados de un cliente.
contratosRouter.get("/cliente/:clienteId", async (req: Request, res: Response) => {
  try {
    const contratos = await prisma.contratoServicio.findMany({
      where: { clienteId: Number(req.params.clienteId) },
      orderBy: { fecha: "desc" },
    });
    res.json(contratos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los contratos" });
  }
});
