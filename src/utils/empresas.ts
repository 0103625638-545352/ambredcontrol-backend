// Registro de EMPRESAS: cada una es un negocio completamente independiente,
// con su propia base de datos (nunca comparten tablas — así es imposible que
// un dato de una empresa se filtre a otra), su propio RUC/certificado SRI y
// sus propias carpetas de archivos (comprobantes autorizados, logo, fotos de
// producto).
//
// Vive en un archivo JSON plano (no en una tabla de alguna de las bases de
// datos de empresa — ese archivo es justamente lo que le dice al backend a
// CUÁL base de datos conectarse, así que no puede vivir dentro de ninguna).
// Nunca se sube a git (ver .gitignore), igual que el .env.
import * as fs from "fs";
import * as path from "path";

const RUTA_REGISTRY = path.join(process.cwd(), "empresas-registry.json");

export interface EmpresaConfig {
  id: string;
  nombre: string;
  databaseUrl: string;
  ruc: string;
  razonSocial: string;
  direccionMatriz: string;
  ambienteSri: "1" | "2";
  establecimiento: string;
  puntoEmision: string;
  obligadoContabilidad: boolean;
  certificadoP12Path: string; // relativa a backend/
  certificadoP12Password: string;
  carpetaUploads: string; // relativa a backend/
  carpetaComprobantes: string; // relativa a backend/
  // Correo(s) al que se manda el resumen diario de esta empresa (cuentas por
  // cobrar, stock bajo, comprobantes atascados, certificado por caducar —
  // ver jobs/resumenDiario.ts). Admite varias direcciones separadas por
  // coma. Vacío = no se envía nada para esta empresa. Opcional en el tipo
  // porque empresas sembradas antes de que existiera este campo no lo tienen
  // todavía en el JSON — se trata como "" en cualquier lugar que lo lea.
  emailResumenDestinatario?: string;
  // Si esta empresa está autorizada por el SRI como agente de retención —
  // no toda empresa puede emitir comprobantes de retención (ver
  // routes/retenciones.ts). Opcional en el tipo por el mismo motivo que
  // emailResumenDestinatario: empresas sembradas antes de este campo no lo
  // tienen todavía en el JSON hasta que se guarde una vez desde Ajustes —
  // se trata como "false" (no autorizada) en cualquier lugar que lo lea.
  agenteRetencion?: boolean;
  // Fecha ("YYYY-MM-DD") hasta la que el período contable está cerrado —
  // ningún asiento (automático o manual) puede postearse en o antes de esta
  // fecha (ver utils/asientos.ts). undefined/vacío = nada cerrado todavía,
  // mismo criterio "opcional, se trata como ausente" que los 2 campos de
  // arriba para empresas sembradas antes de que existiera este campo.
  cierreContableHasta?: string;
  // Ventana de gracia del ciclo de cobro de internet, editable desde Ajustes
  // (ver PUT /configuracion/empresa) — reemplaza lo que antes era un único
  // ISP_DIA_LIMITE_PAGO fijo en .env, porque cada empresa puede querer una
  // regla distinta y el negocio puede necesitar cambiarla de un mes a otro
  // sin tocar el servidor. diaInicioCorte es solo informativo (para mostrar
  // "del día X al día Y" en Facturación de Internet); lo único que decide el
  // corte automático (ver utils/gestionServicioInternet.ts) es
  // diaFinCorte: pasado ese día sin pagar, se suspende — el día siguiente
  // (diaFinCorte + 1) es, en la práctica, cuando arranca la facturación/corte
  // real. Opcional en el tipo por el mismo motivo que cierreContableHasta:
  // empresas sembradas antes de que existiera este campo no lo tienen
  // todavía en el JSON — se tratan como (1, 5), el default de siempre.
  diaInicioCorte?: number;
  diaFinCorte?: number;
  // Recordatorio de vencimiento de internet por WhatsApp (ver
  // jobs/recordatorioVencimientoInternet.ts) — a propósito NO es una
  // variable global en .env como SMTP: cada empresa manda desde SU PROPIO
  // número de WhatsApp Business, con SU PROPIA cuenta de Meta. Un número
  // compartido entre empresas distintas haría que los clientes de una
  // reciban mensajes "de" otra, rompiendo el mismo aislamiento que ya se
  // cuida con la base de datos y el certificado SRI de cada una. undefined =
  // esta empresa todavía no configuró WhatsApp — el job simplemente la
  // salta, mismo criterio "opcional, se trata como ausente" que el resto de
  // campos agregados después del lanzamiento inicial.
  whatsappAccessToken?: string; // token PERMANENTE de un System User, no el temporal de 24h
  whatsappPhoneNumberId?: string; // Phone Number ID de Meta, no el número de teléfono en sí
  whatsappTemplateRecordatorio?: string; // nombre EXACTO de la plantilla aprobada en SU Meta Business Manager
  // Código de idioma EXACTO con el que se aprobó esa plantilla (ver la
  // columna "Idioma" en WhatsApp Manager > Plantillas de mensajes) — Meta
  // rechaza el envío si no coincide con el idioma exacto de la plantilla
  // aprobada, así que "es" a secas no alcanza si se aprobó como "es_EC" o
  // similar. undefined = usa el default del util (ver utils/whatsapp.ts).
  whatsappTemplateIdioma?: string;
  // Días de anticipación sobre el día de corte propio de esta empresa (ver
  // diaFinCorte/fechaContrato). undefined = usa el default del job (3).
  whatsappRecordatorioDiasAntes?: number;
  // Hora del día (0-23, hora local del servidor) en la que ESTA empresa
  // quiere que se revisen sus recordatorios — a diferencia de
  // WHATSAPP_RECORDATORIO_HORA en .env (que sigue siendo el default para
  // quien no fije el suyo), esto es autoservicio: una empresa nueva puede
  // elegir su propio horario desde Ajustes sin tocar el servidor.
  whatsappRecordatorioHora?: number;
  // Plantilla (aprobada en SU Meta Business Manager, categoría "Utility")
  // para la encuesta de satisfacción después de una visita técnica — ver
  // jobs/encuestaVisitas.ts. Parámetros: {{1}} nombre del cliente, {{2}}
  // nombre del técnico; el texto debe pedir responder con un número del 1 al
  // 5. undefined = no se mandan encuestas (el resto de WhatsApp sigue igual).
  whatsappTemplateEncuesta?: string;
  activa: boolean;
  createdAt: string;
}

// Default histórico (era el valor fijo de ISP_DIA_LIMITE_PAGO en .env, antes
// de que esto fuera editable por empresa) — se usa mientras una empresa no
// haya guardado su propia regla todavía desde Ajustes.
export const CICLO_CORTE_POR_DEFECTO = { inicio: 1, fin: 5 };

export function cicloCorteInternet(empresa: Pick<EmpresaConfig, "diaInicioCorte" | "diaFinCorte">): { inicio: number; fin: number } {
  return {
    inicio: empresa.diaInicioCorte ?? CICLO_CORTE_POR_DEFECTO.inicio,
    fin: empresa.diaFinCorte ?? CICLO_CORTE_POR_DEFECTO.fin,
  };
}

function leerRegistryCrudo(): EmpresaConfig[] {
  if (!fs.existsSync(RUTA_REGISTRY)) return [];
  return JSON.parse(fs.readFileSync(RUTA_REGISTRY, "utf-8"));
}

function guardarRegistryCrudo(empresas: EmpresaConfig[]): void {
  fs.writeFileSync(RUTA_REGISTRY, JSON.stringify(empresas, null, 2), "utf-8");
}

export function listarEmpresas(): EmpresaConfig[] {
  return leerRegistryCrudo().filter((e) => e.activa);
}

// Para el selector del login: nunca exponemos databaseUrl, RUC, certificado, etc.
export function listarEmpresasPublico(): { id: string; nombre: string }[] {
  return listarEmpresas().map((e) => ({ id: e.id, nombre: e.nombre }));
}

export function obtenerEmpresa(id: string): EmpresaConfig | undefined {
  return leerRegistryCrudo().find((e) => e.id === id && e.activa);
}

// "Farmacia XYZ" -> "farmacia-xyz"; si ya existe, le agrega un sufijo numérico.
export function generarIdEmpresa(nombre: string): string {
  const base = nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita las marcas de acento que deja normalize("NFD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const existentes = new Set(leerRegistryCrudo().map((e) => e.id));
  if (!existentes.has(base)) return base;

  let sufijo = 2;
  while (existentes.has(`${base}-${sufijo}`)) sufijo++;
  return `${base}-${sufijo}`;
}

export function agregarEmpresa(empresa: EmpresaConfig): void {
  const empresas = leerRegistryCrudo();
  empresas.push(empresa);
  guardarRegistryCrudo(empresas);
}

export function eliminarEmpresaDelRegistro(id: string): void {
  const empresas = leerRegistryCrudo().filter((e) => e.id !== id);
  guardarRegistryCrudo(empresas);
}

// Campos que tiene sentido editar desde la pantalla de Ajustes — a propósito
// NO incluye "id" (atado al nombre de la base de datos y a las carpetas en
// disco, cambiarlo rompería todo lo ya guardado), ni "databaseUrl" ni las
// carpetas (son infraestructura, no datos del negocio), ni el certificado
// (tiene su propio flujo de subida, ver actualizarCertificadoEmpresa).
export interface DatosEditablesEmpresa {
  nombre: string;
  ruc: string;
  razonSocial: string;
  direccionMatriz: string;
  ambienteSri: "1" | "2";
  establecimiento: string;
  puntoEmision: string;
  obligadoContabilidad: boolean;
  emailResumenDestinatario: string;
  agenteRetencion: boolean;
  diaInicioCorte: number;
  diaFinCorte: number;
}

export function actualizarEmpresa(id: string, cambios: DatosEditablesEmpresa): EmpresaConfig {
  const empresas = leerRegistryCrudo();
  const indice = empresas.findIndex((e) => e.id === id);
  if (indice === -1) throw new Error(`Empresa no encontrada: "${id}"`);

  empresas[indice] = { ...empresas[indice], ...cambios };
  guardarRegistryCrudo(empresas);
  return empresas[indice];
}

export function actualizarCertificadoEmpresa(id: string, certificadoP12Password: string): EmpresaConfig {
  const empresas = leerRegistryCrudo();
  const indice = empresas.findIndex((e) => e.id === id);
  if (indice === -1) throw new Error(`Empresa no encontrada: "${id}"`);

  empresas[indice] = { ...empresas[indice], certificadoP12Password };
  guardarRegistryCrudo(empresas);
  return empresas[indice];
}

// Setter chico y aislado, mismo criterio que actualizarCertificadoEmpresa:
// no tiene sentido obligar a reenviar todo DatosEditablesEmpresa (RUC, razón
// social, etc.) solo para mover la fecha de cierre contable — son cosas que
// se editan en pantallas distintas (Contabilidad vs. Ajustes de empresa).
export function actualizarCierreContable(id: string, cierreContableHasta: string | null): EmpresaConfig {
  const empresas = leerRegistryCrudo();
  const indice = empresas.findIndex((e) => e.id === id);
  if (indice === -1) throw new Error(`Empresa no encontrada: "${id}"`);

  empresas[indice] = { ...empresas[indice], cierreContableHasta: cierreContableHasta ?? undefined };
  guardarRegistryCrudo(empresas);
  return empresas[indice];
}

export interface DatosWhatsappEmpresa {
  whatsappAccessToken: string;
  whatsappPhoneNumberId: string;
  whatsappTemplateRecordatorio: string;
  whatsappTemplateIdioma?: string;
  whatsappRecordatorioDiasAntes?: number;
  whatsappRecordatorioHora?: number;
  whatsappTemplateEncuesta?: string;
}

// Setter propio, mismo criterio que actualizarCertificadoEmpresa: son
// credenciales de una cuenta de Meta, no datos de negocio comunes como los
// que ya cubre DatosEditablesEmpresa.
export function actualizarWhatsappEmpresa(id: string, datos: DatosWhatsappEmpresa): EmpresaConfig {
  const empresas = leerRegistryCrudo();
  const indice = empresas.findIndex((e) => e.id === id);
  if (indice === -1) throw new Error(`Empresa no encontrada: "${id}"`);

  empresas[indice] = { ...empresas[indice], ...datos };
  guardarRegistryCrudo(empresas);
  return empresas[indice];
}

// true si esta empresa ya cargó lo mínimo indispensable para que el job de
// recordatorios le mande algo — ver jobs/recordatorioVencimientoInternet.ts.
export function whatsappConfigurado(empresa: EmpresaConfig): boolean {
  return Boolean(empresa.whatsappAccessToken && empresa.whatsappPhoneNumberId && empresa.whatsappTemplateRecordatorio);
}

export function rutaAbsoluta(rutaRelativa: string): string {
  return path.join(process.cwd(), rutaRelativa);
}

// Forma que ya esperan facturaXml.ts/notaCreditoXml.ts/generarRide*.ts — se
// arma una vez acá para no repetir el mismo mapeo en cada ruta que firma o
// genera un PDF.
export interface DatosEmisor {
  ruc: string;
  razonSocial: string;
  dirMatriz: string;
  ambiente: "1" | "2";
  obligadoContabilidad: boolean;
}

export function datosEmisorDeEmpresa(empresa: EmpresaConfig): DatosEmisor {
  return {
    ruc: empresa.ruc,
    razonSocial: empresa.razonSocial,
    dirMatriz: empresa.direccionMatriz,
    ambiente: empresa.ambienteSri,
    obligadoContabilidad: empresa.obligadoContabilidad,
  };
}

// Siembra el registro con la empresa que ya existía antes de que el sistema
// manejara varias — se llama una sola vez, al arrancar, si el archivo
// todavía no existe. Usa las variables de entorno que YA estaban configuradas,
// para no perder continuidad con los datos reales que ya se habían cargado.
export function sembrarEmpresaPrincipalSiHaceFalta(): void {
  if (fs.existsSync(RUTA_REGISTRY)) return;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return; // sin .env configurado, no hay nada que sembrar todavía

  const principal: EmpresaConfig = {
    id: "principal",
    nombre: process.env.RAZON_SOCIAL || "Empresa principal",
    databaseUrl,
    ruc: process.env.RUC_EMISOR || "",
    razonSocial: process.env.RAZON_SOCIAL || "",
    direccionMatriz: process.env.DIRECCION_MATRIZ || "",
    ambienteSri: (process.env.AMBIENTE_SRI as "1" | "2") || "1",
    establecimiento: process.env.ESTABLECIMIENTO || "001",
    puntoEmision: process.env.PUNTO_EMISION || "001",
    obligadoContabilidad: process.env.OBLIGADO_CONTABILIDAD === "true",
    certificadoP12Path: process.env.CERTIFICADO_P12_PATH || "./certificado.p12",
    certificadoP12Password: process.env.CERTIFICADO_P12_PASSWORD || "",
    // Las carpetas que ya existían en la raíz del backend, ANTES de que
    // existiera el concepto de "varias empresas" — se quedan donde están,
    // no hace falta mover ningún archivo real para migrar.
    carpetaUploads: "uploads",
    carpetaComprobantes: "comprobantes-autorizados",
    emailResumenDestinatario: "",
    agenteRetencion: false,
    activa: true,
    createdAt: new Date().toISOString(),
  };

  guardarRegistryCrudo([principal]);
}
