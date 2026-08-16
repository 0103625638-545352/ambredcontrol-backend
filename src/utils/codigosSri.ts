// Códigos de las tablas oficiales del SRI que hacen falta para armar el XML
// de los comprobantes electrónicos (tipo de identificación, porcentaje de
// IVA, forma de pago) — el SRI las actualiza periódicamente (ver el aviso en
// la pantalla ATS). Antes vivían como funciones puras DUPLICADAS en
// facturaXml.ts, notaCreditoXml.ts, guiaRemisionXml.ts y retencionXml.ts —
// una actualización del SRI corría el riesgo de quedar aplicada en un
// archivo y olvidada en otro. Ahora es un solo archivo de datos
// (codigos-sri.json, en la raíz de backend/, igual criterio de ubicación que
// empresas-registry.json), editable desde Ajustes > Códigos SRI sin tocar
// código ni volver a desplegar (ver PUT /configuracion/codigos-sri).
//
// A diferencia de empresas-registry.json, este archivo NO tiene secretos y
// NO es por empresa — los códigos del SRI son los mismos para cualquier
// negocio en Ecuador, por eso se guarda una sola vez, sí se sube a git (con
// los valores vigentes al momento de escribir esto) y cualquier empresa
// activa lee el mismo archivo.
import * as fs from "fs";
import * as path from "path";

const RUTA_ARCHIVO = path.join(process.cwd(), "codigos-sri.json");

export interface CodigosSri {
  tipoIdentificacion: Record<string, string>;
  formaPago: Record<string, string>;
  porcentajeIva: Record<string, string>;
}

// Mismos valores que trae codigos-sri.json de fábrica — red de seguridad
// por si el archivo llegara a faltar o quedar corrupto (nunca deja al
// sistema sin poder generar un XML).
const CODIGOS_POR_DEFECTO: CodigosSri = {
  tipoIdentificacion: { RUC: "04", CEDULA: "05", PASAPORTE: "06", CONSUMIDOR_FINAL: "07" },
  formaPago: { EFECTIVO: "01", TRANSFERENCIA: "20", CHEQUE: "20", OTRO: "20", TARJETA_DEBITO: "16", TARJETA_CREDITO: "19" },
  porcentajeIva: { "0": "0", "12": "2", "15": "4" },
};

export function leerCodigosSri(): CodigosSri {
  try {
    const crudo = JSON.parse(fs.readFileSync(RUTA_ARCHIVO, "utf-8"));
    return {
      tipoIdentificacion: { ...CODIGOS_POR_DEFECTO.tipoIdentificacion, ...crudo.tipoIdentificacion },
      formaPago: { ...CODIGOS_POR_DEFECTO.formaPago, ...crudo.formaPago },
      porcentajeIva: { ...CODIGOS_POR_DEFECTO.porcentajeIva, ...crudo.porcentajeIva },
    };
  } catch {
    return CODIGOS_POR_DEFECTO;
  }
}

export function guardarCodigosSri(codigos: CodigosSri): void {
  fs.writeFileSync(RUTA_ARCHIVO, JSON.stringify(codigos, null, 2), "utf-8");
}

// Tabla oficial: 04 = RUC, 05 = Cédula, 06 = Pasaporte, 07 = Consumidor Final
export function codigoTipoIdentificacion(tipo: string): string {
  return leerCodigosSri().tipoIdentificacion[tipo] ?? "05";
}

// "2" = 12% (histórico), "4" = 15% (vigente en la mayoría de casos), "0" = 0%
export function codigoPorcentajeIva(porcentaje: number): string {
  return leerCodigosSri().porcentajeIva[String(porcentaje)] ?? "4";
}

// formaPago: valores internos EFECTIVO/TRANSFERENCIA/TARJETA/CHEQUE/OTRO
// (ver Pago.formaPago en schema.prisma) — TARJETA se desglosa en
// débito/crédito según tarjetaTipo, el resto mapea directo.
export function codigoFormaPagoSri(formaPago: string | undefined, tarjetaTipo: string | null | undefined): string {
  const codigos = leerCodigosSri();
  if (formaPago === "TARJETA") {
    return tarjetaTipo === "CREDITO" ? codigos.formaPago.TARJETA_CREDITO : codigos.formaPago.TARJETA_DEBITO;
  }
  if (formaPago && codigos.formaPago[formaPago]) return codigos.formaPago[formaPago];
  return codigos.formaPago.EFECTIVO;
}
