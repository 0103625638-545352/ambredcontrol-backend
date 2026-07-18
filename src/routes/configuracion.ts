// Configuración general de la empresa (por ahora, solo el logotipo que se
// muestra en los PDF de factura/nota de crédito). Separado de /productos y
// /clientes porque no es un recurso de negocio con muchos registros — es un
// único archivo global para todo el sistema.
//
// Multiempresa: TODO acá (carpeta de uploads, carpeta de comprobantes,
// backup) se resuelve contra la empresa del usuario logueado — nunca una
// carpeta fija, para que dos empresas nunca compartan un logo ni un backup.
import { Router, Request, Response, NextFunction } from "express";
import * as fs from "fs";
import * as path from "path";
import multer from "multer";
import { requirePermiso } from "../middleware/auth";
import {
  EXTENSIONES_LOGO_PERMITIDAS,
  borrarLogoAnterior,
  leerLogoEmpresa,
  rutaLogo,
  type ExtensionLogo,
} from "../utils/logoEmpresa";
import { rutaComprobantesAutorizados } from "../utils/comprobantesAutorizados";
import { prisma, empresaActiva, empresaActivaId } from "../db";
import { rutaAbsoluta, actualizarEmpresa, actualizarCertificadoEmpresa, cicloCorteInternet, type DatosEditablesEmpresa } from "../utils/empresas";
import { registrarAuditoria } from "../utils/auditoria";
import { invalidarCacheExpiracionCertificado } from "../utils/certificado";
import { ejecutarBackupDeEmpresa, estadoBackup, backupAtrasado } from "../utils/backupBaseDatos";

export const configuracionRouter = Router();

function carpetaUploadsActiva(): string {
  const carpeta = rutaAbsoluta(empresaActiva().carpetaUploads);
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
  }
  return carpeta;
}

const TIPOS_MIME_A_EXTENSION: Record<string, ExtensionLogo> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};
const TAMANO_MAXIMO_LOGO = 2 * 1024 * 1024; // 2MB, de sobra para un logotipo

const almacenamientoLogo = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, carpetaUploadsActiva()),
  filename: (_req, file, cb) => cb(null, `logo-empresa.${TIPOS_MIME_A_EXTENSION[file.mimetype]}`),
});

const subirLogo = multer({
  storage: almacenamientoLogo,
  limits: { fileSize: TAMANO_MAXIMO_LOGO },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_MIME_A_EXTENSION[file.mimetype]) {
      return cb(new Error("El logo debe ser una imagen PNG o JPG"));
    }
    cb(null, true);
  },
});

function subirLogoMiddleware(req: Request, res: Response, next: NextFunction) {
  subirLogo.single("logo")(req, res, (error: any) => {
    if (error?.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "El logo no puede pesar más de 2MB" });
    }
    if (error) {
      return res.status(400).json({ error: error.message || "Error al subir el logo" });
    }
    next();
  });
}

// GET /configuracion/logo
// Informa si ya hay un logo configurado (y su URL pública) para poder
// previsualizarlo en la pantalla de Ajustes.
configuracionRouter.get("/logo", (_req: Request, res: Response) => {
  const logo = leerLogoEmpresa(carpetaUploadsActiva());
  res.json({ logoUrl: logo ? `/uploads/${empresaActivaId()}/logo-empresa.${logo.extension}` : null });
});

// POST /configuracion/logo
// Sube (o reemplaza) el logo de la empresa. Se guarda siempre con el mismo
// nombre base ("logo-empresa.<ext>"), así generarRide.ts no necesita saber
// la URL — solo busca el archivo en disco.
configuracionRouter.post("/logo", requirePermiso("configuracion"), subirLogoMiddleware, (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: "No se envió ningún archivo" });
  }

  // Si el logo nuevo tiene otra extensión que el anterior (ej. reemplazar un
  // .png por un .jpg), borramos el archivo viejo para no dejarlo huérfano.
  const extensionNueva = TIPOS_MIME_A_EXTENSION[req.file.mimetype];
  const carpeta = carpetaUploadsActiva();
  for (const extension of EXTENSIONES_LOGO_PERMITIDAS) {
    if (extension !== extensionNueva) {
      const ruta = rutaLogo(carpeta, extension);
      if (fs.existsSync(ruta)) fs.unlinkSync(ruta);
    }
  }

  res.json({ logoUrl: `/uploads/${empresaActivaId()}/logo-empresa.${extensionNueva}` });
});

// DELETE /configuracion/logo
// Quita el logo configurado (vuelve el RIDE a su formato sin logo).
configuracionRouter.delete("/logo", requirePermiso("configuracion"), (_req: Request, res: Response) => {
  borrarLogoAnterior(carpetaUploadsActiva());
  res.json({ mensaje: "Logo eliminado" });
});

// GET /configuracion/backup-comprobantes
// Informa si hay una ruta de respaldo configurada (BACKUP_COMPROBANTES_PATH)
// y cuántos XML autorizados hay en cada lado, para detectar de un vistazo si
// el respaldo quedó desactualizado (ej. la ruta estuvo desconectada un tiempo).
// Cada empresa respalda en su propia subcarpeta dentro de esa raíz.
configuracionRouter.get("/backup-comprobantes", requirePermiso("configuracion"), (_req: Request, res: Response) => {
  const carpetaPrincipal = rutaComprobantesAutorizados();
  const raizBackup = process.env.BACKUP_COMPROBANTES_PATH || null;
  const carpetaBackup = raizBackup ? path.join(raizBackup, empresaActivaId()) : null;

  const contarXml = (carpeta: string | null) => {
    if (!carpeta || !fs.existsSync(carpeta)) return 0;
    return fs.readdirSync(carpeta).filter((archivo) => archivo.endsWith(".xml")).length;
  };

  res.json({
    configurado: !!carpetaBackup,
    carpetaBackup,
    totalPrincipal: contarXml(carpetaPrincipal),
    totalBackup: contarXml(carpetaBackup),
  });
});

// POST /configuracion/backup-comprobantes/ejecutar
// Copia a la carpeta de respaldo cualquier XML que ya exista en la carpeta
// principal pero todavía no se haya respaldado — cubre los comprobantes
// autorizados ANTES de configurar BACKUP_COMPROBANTES_PATH (de ahí en
// adelante, cada autorización nueva ya se respalda sola).
configuracionRouter.post("/backup-comprobantes/ejecutar", requirePermiso("configuracion"), (_req: Request, res: Response) => {
  const raizBackup = process.env.BACKUP_COMPROBANTES_PATH;
  if (!raizBackup) {
    return res.status(400).json({ error: "No hay una ruta de respaldo configurada (BACKUP_COMPROBANTES_PATH)" });
  }
  const carpetaBackup = path.join(raizBackup, empresaActivaId());

  const carpetaPrincipal = rutaComprobantesAutorizados();
  if (!fs.existsSync(carpetaPrincipal)) {
    return res.json({ mensaje: "Todavía no hay comprobantes autorizados que respaldar", copiados: 0 });
  }
  if (!fs.existsSync(carpetaBackup)) {
    fs.mkdirSync(carpetaBackup, { recursive: true });
  }

  const archivos = fs.readdirSync(carpetaPrincipal).filter((archivo) => archivo.endsWith(".xml"));
  let copiados = 0;
  for (const archivo of archivos) {
    const destino = path.join(carpetaBackup, archivo);
    if (!fs.existsSync(destino)) {
      fs.copyFileSync(path.join(carpetaPrincipal, archivo), destino);
      copiados++;
    }
  }

  res.json({ mensaje: `Respaldo al día: ${copiados} archivo(s) copiado(s)`, copiados, total: archivos.length });
});

// GET /configuracion/backup-db
// Informa si el respaldo automático de base de datos está configurado
// (BACKUP_DB_PATH) y el estado del último intento para la empresa activa —
// ver jobs/backupDiario.ts, que es el que dispara esto todos los días.
configuracionRouter.get("/backup-db", requirePermiso("configuracion"), (_req: Request, res: Response) => {
  const configurado = !!process.env.BACKUP_DB_PATH;
  const estado = estadoBackup(empresaActivaId());
  res.json({
    configurado,
    ...estado,
    atrasado: configurado ? backupAtrasado(estado) : false,
  });
});

// POST /configuracion/backup-db/ejecutar
// Dispara un respaldo manual "ahora mismo" para la empresa activa — útil
// para probar que BACKUP_DB_PATH/pg_dump están bien configurados sin esperar
// a la hora programada (BACKUP_DB_HORA).
configuracionRouter.post("/backup-db/ejecutar", requirePermiso("configuracion"), async (_req: Request, res: Response) => {
  const empresa = empresaActiva();
  const resultado = await ejecutarBackupDeEmpresa({ id: empresa.id, databaseUrl: empresa.databaseUrl });
  if (!resultado.ok) {
    return res.status(400).json({ error: resultado.error });
  }
  res.json({ mensaje: `Respaldo creado: ${resultado.archivo}`, archivo: resultado.archivo });
});

// GET /configuracion/empresa
// Datos editables de la empresa activa (nunca databaseUrl, certificadoP12Password
// ni las carpetas — eso es infraestructura, no algo que se edite desde acá).
// Cualquier usuario logueado puede VER esto; solo un ADMIN puede guardarlo (abajo).
configuracionRouter.get("/empresa", (_req: Request, res: Response) => {
  const empresa = empresaActiva();
  const ciclo = cicloCorteInternet(empresa);
  res.json({
    nombre: empresa.nombre,
    ruc: empresa.ruc,
    razonSocial: empresa.razonSocial,
    direccionMatriz: empresa.direccionMatriz,
    ambienteSri: empresa.ambienteSri,
    establecimiento: empresa.establecimiento,
    puntoEmision: empresa.puntoEmision,
    obligadoContabilidad: empresa.obligadoContabilidad,
    emailResumenDestinatario: empresa.emailResumenDestinatario || "",
    agenteRetencion: empresa.agenteRetencion || false,
    diaInicioCorte: ciclo.inicio,
    diaFinCorte: ciclo.fin,
    tieneCertificado: !!empresa.certificadoP12Password,
  });
});

// PUT /configuracion/empresa
// Edita los datos de la empresa activa — RUC, razón social, y crucialmente
// "ambienteSri": pasar de pruebas a producción se hace acá (además de subir
// un certificado real, ver POST /certificado — el SRI rechaza documentos
// firmados con el certificado autofirmado de pruebas).
configuracionRouter.put("/empresa", requirePermiso("configuracion"), (req: Request, res: Response) => {
  const { nombre, ruc, razonSocial, direccionMatriz, ambienteSri, establecimiento, puntoEmision, obligadoContabilidad, emailResumenDestinatario, agenteRetencion, diaInicioCorte, diaFinCorte } = req.body;

  if (!nombre || !ruc || !razonSocial) {
    return res.status(400).json({ error: "nombre, ruc y razonSocial son obligatorios" });
  }
  if (ambienteSri !== "1" && ambienteSri !== "2") {
    return res.status(400).json({ error: 'ambienteSri debe ser "1" (pruebas) o "2" (producción)' });
  }

  const inicioCorte = Number(diaInicioCorte);
  const finCorte = Number(diaFinCorte);
  // Tope en 28 a propósito: cualquier día del ciclo tiene que existir en
  // TODOS los meses, incluido febrero — un "día 30" se saltaría de largo en
  // febrero y correría el corte antes de tiempo ese mes.
  if (!Number.isInteger(inicioCorte) || !Number.isInteger(finCorte) || inicioCorte < 1 || finCorte > 28 || inicioCorte > finCorte) {
    return res.status(400).json({ error: "El ciclo de corte debe ser un rango de días válido (entre 1 y 28), con el día de inicio antes o igual al de fin" });
  }

  const cambios: DatosEditablesEmpresa = {
    nombre,
    ruc,
    razonSocial,
    direccionMatriz: direccionMatriz || "",
    ambienteSri,
    establecimiento: establecimiento || "001",
    puntoEmision: puntoEmision || "001",
    obligadoContabilidad: obligadoContabilidad === true,
    emailResumenDestinatario: typeof emailResumenDestinatario === "string" ? emailResumenDestinatario.trim() : "",
    agenteRetencion: agenteRetencion === true,
    diaInicioCorte: inicioCorte,
    diaFinCorte: finCorte,
  };

  const actualizada = actualizarEmpresa(empresaActivaId(), cambios);

  registrarAuditoria(prisma, {
    usuarioId: req.usuario!.usuarioId,
    accion: "EDITAR_EMPRESA",
    entidad: "Empresa",
    detalle: `${actualizada.nombre}: ambiente ${actualizada.ambienteSri === "2" ? "PRODUCCIÓN" : "PRUEBAS"}, ciclo de corte día ${inicioCorte} al ${finCorte}`,
  }).catch((error) => console.error("No se pudo registrar la auditoría de EDITAR_EMPRESA:", error));

  res.json({
    nombre: actualizada.nombre,
    ruc: actualizada.ruc,
    razonSocial: actualizada.razonSocial,
    direccionMatriz: actualizada.direccionMatriz,
    ambienteSri: actualizada.ambienteSri,
    establecimiento: actualizada.establecimiento,
    puntoEmision: actualizada.puntoEmision,
    obligadoContabilidad: actualizada.obligadoContabilidad,
    emailResumenDestinatario: actualizada.emailResumenDestinatario || "",
    agenteRetencion: actualizada.agenteRetencion || false,
    diaInicioCorte: actualizada.diaInicioCorte,
    diaFinCorte: actualizada.diaFinCorte,
  });
});

const subirCertificado = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const destino = path.dirname(rutaAbsoluta(empresaActiva().certificadoP12Path));
      if (!fs.existsSync(destino)) fs.mkdirSync(destino, { recursive: true });
      cb(null, destino);
    },
    filename: (_req, _file, cb) => cb(null, path.basename(empresaActiva().certificadoP12Path)),
  }),
  limits: { fileSize: 1 * 1024 * 1024 }, // 1MB, de sobra para un .p12
  fileFilter: (_req, file, cb) => {
    if (!/\.(p12|pfx)$/i.test(file.originalname)) {
      return cb(new Error("El certificado debe ser un archivo .p12 o .pfx"));
    }
    cb(null, true);
  },
});

function subirCertificadoMiddleware(req: Request, res: Response, next: NextFunction) {
  subirCertificado.single("certificado")(req, res, (error: any) => {
    if (error?.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "El certificado no puede pesar más de 1MB" });
    }
    if (error) {
      return res.status(400).json({ error: error.message || "Error al subir el certificado" });
    }
    next();
  });
}

// POST /configuracion/certificado
// Sube (o reemplaza) el certificado .p12 de la empresa activa. Body multipart:
// { certificado: <archivo>, password: string }.
configuracionRouter.post("/certificado", requirePermiso("configuracion"), subirCertificadoMiddleware, (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: "No se envió ningún archivo" });
  }
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: "password es obligatorio (la contraseña del .p12)" });
  }

  actualizarCertificadoEmpresa(empresaActivaId(), password);
  invalidarCacheExpiracionCertificado(empresaActivaId());
  res.json({ mensaje: "Certificado actualizado" });
});
