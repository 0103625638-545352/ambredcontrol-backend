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
import {
  rutaAbsoluta,
  actualizarEmpresa,
  actualizarCertificadoEmpresa,
  actualizarWhatsappEmpresa,
  whatsappConfigurado,
  cicloCorteInternet,
  type DatosEditablesEmpresa,
  type DatosWhatsappEmpresa,
} from "../utils/empresas";
import { registrarAuditoria } from "../utils/auditoria";
import { invalidarCacheExpiracionCertificado } from "../utils/certificado";
import { ejecutarBackupDeEmpresa, estadoBackup, backupAtrasado } from "../utils/backupBaseDatos";
import { leerCodigosSri, guardarCodigosSri, type CodigosSri } from "../utils/codigosSri";

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

// GET /configuracion/codigos-sri
// A diferencia del resto de este archivo, NO es por empresa — los códigos
// de las tablas oficiales del SRI (tipo de identificación, porcentaje de
// IVA, forma de pago) son los mismos para cualquier negocio en Ecuador, por
// eso viven en un solo archivo global (ver utils/codigosSri.ts) en vez de
// en el registro de la empresa activa.
configuracionRouter.get("/codigos-sri", (_req: Request, res: Response) => {
  res.json(leerCodigosSri());
});

// PUT /configuracion/codigos-sri
// Para cuando el SRI actualiza alguna de estas tablas (ver el aviso en la
// pantalla ATS) — evita tener que editar código y volver a desplegar.
configuracionRouter.put("/codigos-sri", requirePermiso("configuracion"), (req: Request, res: Response) => {
  const { tipoIdentificacion, formaPago, porcentajeIva } = req.body as Partial<CodigosSri>;

  if (!tipoIdentificacion || !formaPago || !porcentajeIva) {
    return res.status(400).json({ error: "tipoIdentificacion, formaPago y porcentajeIva son obligatorios" });
  }
  const CLAVES_TIPO_IDENTIFICACION = ["RUC", "CEDULA", "PASAPORTE", "CONSUMIDOR_FINAL"];
  const CLAVES_FORMA_PAGO = ["EFECTIVO", "TRANSFERENCIA", "CHEQUE", "OTRO", "TARJETA_DEBITO", "TARJETA_CREDITO"];
  for (const clave of CLAVES_TIPO_IDENTIFICACION) {
    if (!tipoIdentificacion[clave]?.trim()) {
      return res.status(400).json({ error: `Falta el código de tipoIdentificacion.${clave}` });
    }
  }
  for (const clave of CLAVES_FORMA_PAGO) {
    if (!formaPago[clave]?.trim()) {
      return res.status(400).json({ error: `Falta el código de formaPago.${clave}` });
    }
  }
  const porcentajes = Object.entries(porcentajeIva);
  if (porcentajes.length === 0 || porcentajes.some(([, codigo]) => !codigo?.trim())) {
    return res.status(400).json({ error: "Cada porcentaje de IVA necesita un código" });
  }

  const codigos: CodigosSri = { tipoIdentificacion, formaPago, porcentajeIva };
  guardarCodigosSri(codigos);

  registrarAuditoria(prisma, {
    usuarioId: req.usuario!.usuarioId,
    accion: "EDITAR_CODIGOS_SRI",
    entidad: "CodigosSri",
    detalle: "Códigos de tipo de identificación / forma de pago / porcentaje de IVA actualizados",
  }).catch((error) => console.error("No se pudo registrar la auditoría de EDITAR_CODIGOS_SRI:", error));

  res.json(codigos);
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

// GET /configuracion/whatsapp
// Nunca devuelve el Access Token real (es un secreto) — solo si ya hay uno
// cargado ("tieneAccessToken"), igual que /empresa nunca devuelve
// certificadoP12Password. El resto de campos no son secretos (Phone Number
// ID, nombre de plantilla) y sí se muestran para poder editarlos.
configuracionRouter.get("/whatsapp", (_req: Request, res: Response) => {
  const empresa = empresaActiva();
  res.json({
    configurado: whatsappConfigurado(empresa),
    tieneAccessToken: !!empresa.whatsappAccessToken,
    whatsappPhoneNumberId: empresa.whatsappPhoneNumberId || "",
    whatsappTemplateRecordatorio: empresa.whatsappTemplateRecordatorio || "",
    whatsappTemplateIdioma: empresa.whatsappTemplateIdioma || "",
    whatsappRecordatorioDiasAntes: empresa.whatsappRecordatorioDiasAntes ?? 3,
    whatsappRecordatorioHora: empresa.whatsappRecordatorioHora ?? null,
    whatsappTemplateEncuesta: empresa.whatsappTemplateEncuesta || "",
  });
});

// PUT /configuracion/whatsapp
// Credenciales de la cuenta de WhatsApp Business API (Meta Cloud API) de
// ESTA empresa — ver el comentario grande en EmpresaConfig.whatsappAccessToken
// (utils/empresas.ts) sobre por qué esto es por empresa y no una variable
// global como SMTP. "accessToken" vacío en el body significa "no lo
// cambies" (para no obligar a repegarlo cada vez que se edita el resto) —
// solo es obligatorio la primera vez, cuando esta empresa todavía no tiene
// ninguno guardado.
configuracionRouter.put("/whatsapp", requirePermiso("configuracion"), (req: Request, res: Response) => {
  const { accessToken, phoneNumberId, plantilla, idioma, diasAntes, hora, plantillaEncuesta } = req.body;

  if (!phoneNumberId || typeof phoneNumberId !== "string") {
    return res.status(400).json({ error: "phoneNumberId es obligatorio" });
  }
  if (!plantilla || typeof plantilla !== "string") {
    return res.status(400).json({ error: "plantilla es obligatorio (nombre exacto de la plantilla aprobada en Meta)" });
  }

  const empresaAntes = empresaActiva();
  const tokenFinal = typeof accessToken === "string" && accessToken.trim() ? accessToken.trim() : empresaAntes.whatsappAccessToken;
  if (!tokenFinal) {
    return res.status(400).json({ error: "accessToken es obligatorio la primera vez que configuras WhatsApp para esta empresa" });
  }

  const diasAntesNum = diasAntes === undefined || diasAntes === "" ? undefined : Number(diasAntes);
  if (diasAntesNum !== undefined && (!Number.isInteger(diasAntesNum) || diasAntesNum < 1)) {
    return res.status(400).json({ error: "diasAntes debe ser un entero mayor o igual a 1" });
  }

  const horaNum = hora === undefined || hora === "" || hora === null ? undefined : Number(hora);
  if (horaNum !== undefined && (!Number.isInteger(horaNum) || horaNum < 0 || horaNum > 23)) {
    return res.status(400).json({ error: "hora debe ser un entero entre 0 y 23" });
  }

  const cambios: DatosWhatsappEmpresa = {
    whatsappAccessToken: tokenFinal,
    whatsappPhoneNumberId: phoneNumberId.trim(),
    whatsappTemplateRecordatorio: plantilla.trim(),
    whatsappTemplateIdioma: typeof idioma === "string" && idioma.trim() ? idioma.trim() : undefined,
    whatsappRecordatorioDiasAntes: diasAntesNum,
    whatsappRecordatorioHora: horaNum,
    whatsappTemplateEncuesta: typeof plantillaEncuesta === "string" && plantillaEncuesta.trim() ? plantillaEncuesta.trim() : undefined,
  };

  const actualizada = actualizarWhatsappEmpresa(empresaActivaId(), cambios);

  registrarAuditoria(prisma, {
    usuarioId: req.usuario!.usuarioId,
    accion: "EDITAR_WHATSAPP_EMPRESA",
    entidad: "Empresa",
    detalle: `WhatsApp Business configurado: plantilla "${cambios.whatsappTemplateRecordatorio}", ${cambios.whatsappRecordatorioDiasAntes ?? 3} día(s) antes del corte`,
  }).catch((error) => console.error("No se pudo registrar la auditoría de EDITAR_WHATSAPP_EMPRESA:", error));

  res.json({
    configurado: whatsappConfigurado(actualizada),
    tieneAccessToken: !!actualizada.whatsappAccessToken,
    whatsappPhoneNumberId: actualizada.whatsappPhoneNumberId || "",
    whatsappTemplateRecordatorio: actualizada.whatsappTemplateRecordatorio || "",
    whatsappTemplateIdioma: actualizada.whatsappTemplateIdioma || "",
    whatsappRecordatorioDiasAntes: actualizada.whatsappRecordatorioDiasAntes ?? 3,
    whatsappRecordatorioHora: actualizada.whatsappRecordatorioHora ?? null,
    whatsappTemplateEncuesta: actualizada.whatsappTemplateEncuesta || "",
  });
});

// Tipos de comprobante cuya numeración puede sembrarse antes de emitir el
// primero en este sistema — ver GET/PUT /configuracion/secuenciales abajo.
// "PRO" (proformas) y "DC" (devoluciones a proveedor) quedan fuera a
// propósito: no son comprobantes con numeración legal que un negocio
// necesite "continuar" al migrarse a este sistema.
const TIPOS_SECUENCIAL_EDITABLES: { codigo: string; etiqueta: string; contar: () => Promise<number> }[] = [
  { codigo: "01", etiqueta: "Facturas", contar: () => prisma.factura.count() },
  { codigo: "04", etiqueta: "Notas de crédito", contar: () => prisma.notaCredito.count() },
  { codigo: "06", etiqueta: "Guías de remisión", contar: () => prisma.guiaRemision.count() },
  { codigo: "07", etiqueta: "Comprobantes de retención", contar: () => prisma.retencion.count() },
  { codigo: "NV", etiqueta: "Notas de venta", contar: () => prisma.notaVenta.count() },
];

// GET /configuracion/secuenciales
// Para la pantalla de "numeración inicial" en Ajustes: por cada tipo de
// comprobante, el último número usado hasta ahora en este sistema y si ya
// hay documentos emitidos (si los hay, el número deja de ser editable — ver
// el PUT de abajo).
configuracionRouter.get("/secuenciales", requirePermiso("configuracion"), async (_req: Request, res: Response) => {
  const resultado = await Promise.all(
    TIPOS_SECUENCIAL_EDITABLES.map(async ({ codigo, etiqueta, contar }) => {
      const [fila, totalDocumentos] = await Promise.all([
        prisma.secuencial.findUnique({
          where: { puntoVenta_establecimiento_tipoComprobante: { puntoVenta: "001", establecimiento: "001", tipoComprobante: codigo } },
        }),
        contar(),
      ]);
      return {
        tipoComprobante: codigo,
        etiqueta,
        ultimoNumero: fila?.ultimoNumero ?? 0,
        totalDocumentos,
        editable: totalDocumentos === 0,
      };
    })
  );
  res.json(resultado);
});

// PUT /configuracion/secuenciales/:tipoComprobante
// Siembra el "último número ya emitido" (fuera de este sistema, ej. en el
// sistema anterior o en facturación física) ANTES de emitir el primer
// comprobante de ese tipo acá — así el próximo que se cree en este sistema
// continúa la numeración que el SRI ya tiene autorizada, en vez de arrancar
// otra vez desde 1. Bloqueado en cuanto exista un solo documento de ese tipo
// en este sistema: cambiar el contador después abre la puerta a repetir un
// número de secuencial ya usado, lo que el SRI rechaza.
configuracionRouter.put("/secuenciales/:tipoComprobante", requirePermiso("configuracion"), async (req: Request, res: Response) => {
  const tipoComprobante = String(req.params.tipoComprobante);
  const tipo = TIPOS_SECUENCIAL_EDITABLES.find((t) => t.codigo === tipoComprobante);
  if (!tipo) {
    return res.status(400).json({ error: "Tipo de comprobante no reconocido" });
  }

  const ultimoNumero = Number(req.body.ultimoNumero);
  if (!Number.isInteger(ultimoNumero) || ultimoNumero < 0) {
    return res.status(400).json({ error: "ultimoNumero debe ser un entero mayor o igual a 0" });
  }

  const totalDocumentos = await tipo.contar();
  if (totalDocumentos > 0) {
    return res.status(409).json({
      error: `Ya existen ${totalDocumentos} comprobante(s) de "${tipo.etiqueta}" emitidos en este sistema — la numeración inicial ya no se puede cambiar.`,
    });
  }

  const fila = await prisma.secuencial.upsert({
    where: { puntoVenta_establecimiento_tipoComprobante: { puntoVenta: "001", establecimiento: "001", tipoComprobante } },
    create: { puntoVenta: "001", establecimiento: "001", tipoComprobante, ultimoNumero },
    update: { ultimoNumero },
  });

  await registrarAuditoria(prisma, {
    usuarioId: req.usuario!.usuarioId,
    accion: "EDITAR_SECUENCIAL_INICIAL",
    entidad: "Secuencial",
    detalle: `${tipo.etiqueta}: numeración inicial sembrada en ${ultimoNumero} — el próximo comprobante será el Nº ${ultimoNumero + 1}`,
  });

  res.json({ tipoComprobante, etiqueta: tipo.etiqueta, ultimoNumero: fila.ultimoNumero });
});
