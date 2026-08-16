// Genera el XML de la GUÍA DE REMISIÓN según el esquema del SRI (Ecuador),
// tipoComprobante "06". Todavía sin firmar — eso lo hace firmarXadesBes.ts,
// igual que con factura/nota de crédito/retención.
//
// A diferencia de Factura/NotaCredito, no hay montos ni impuestos: acá el
// bloque propio es "infoGuiaRemision" (transportista, vehículo, fechas del
// traslado) y un único "destinatario" (ver decisión de alcance: un solo
// destinatario por guía) con su lista de bienes transportados.
//
// Estructura revisada dos veces:
//   1) Contra una plantilla de referencia con comentarios explicativos (no
//      un comprobante real autorizado por el SRI) — reveló que faltaba el
//      bloque de "documento de sustento" (la Factura que la guía
//      transporta) dentro de cada destinatario:
//      codDocSustento/numDocSustento/numAutDocSustento/fechaEmisionDocSustento.
//   2) Contra los XML de ejemplo OFICIALES que genera el propio esquema
//      XSD del SRI (uno por versión: 1.0.0 y 1.1.0 — se nota por
//      xsi:noNamespaceSchemaLocation apuntando al .xsd correspondiente).
//      Esta fuente es más confiable que una plantilla suelta porque sale
//      directo del esquema, aunque tampoco es un comprobante real
//      autorizado (los valores son placeholders tipo "razonSocial0"), así
//      que no confirma cardinalidad (qué es opcional vs obligatorio), solo
//      nombres y orden de los tags. Confirmó dos cosas:
//        a) Los tags de fecha en el XML real del esquema son
//           "fechaIniTransporte"/"fechaFinTransporte", NO
//           "fechaIniTraslado"/"fechaFinTraslado" como se había puesto en
//           la revisión (1) — esa renombrada estaba mal, se revierte acá.
//        b) Cada <detalle> trae un contenedor <detallesAdicionales>,
//           vacío si no hay campos adicionales que declarar.
//      Ambos ejemplos oficiales también muestran <rise>, <contribuyenteEspecial>,
//      <docAduaneroUnico>, <codEstabDestino>, <codigoAdicional> y un bloque
//      <maquinaFiscal> — se dejan fuera a propósito: son opcionales y
//      atados a escenarios que este negocio no usa (aduana/exportación,
//      traslado entre establecimientos, régimen RISE, contribuyente
//      especial, impresora fiscal), y omitir un elemento opcional es
//      válido contra el XSD. Si alguna vez aparece una guía real ya
//      autorizada por el SRI para comparar, vale la pena revisar esto con
//      la misma confianza que se logró con retencionXml.ts.
import { create } from "xmlbuilder2";
import { codigoTipoIdentificacion } from "./codigosSri";

interface DetalleParaXml {
  producto: { codigo: string };
  cantidad: number;
  descripcion: string;
}

interface GuiaRemisionParaXml {
  claveAcceso: string;
  secuencial: string; // "001-001-000000001"
  fechaEmision: Date;
  destinatarioTipoIdentificacion: string;
  destinatarioIdentificacion: string;
  destinatarioRazonSocial: string;
  destinatarioDireccion: string;
  motivoTraslado: string;
  ruta?: string | null;
  dirPartida: string;
  transportistaTipoIdentificacion: string;
  transportistaIdentificacion: string;
  transportistaRazonSocial: string;
  placa: string;
  fechaIniTransporte: Date;
  fechaFinTransporte: Date;
  detalles: DetalleParaXml[];
  // La Factura que esta guía transporta — el "documento de sustento" que
  // exige el SRI dentro de cada destinatario (ver el comentario de arriba).
  factura: { secuencial: string; fechaEmision: Date; claveAcceso: string | null };
}

interface DatosEmisor {
  ruc: string;
  razonSocial: string;
  nombreComercial?: string;
  dirMatriz: string;
  dirEstablecimiento?: string;
  ambiente: "1" | "2";
  obligadoContabilidad: boolean;
}

function formatearFechaSri(fecha: Date): string {
  const dd = String(fecha.getDate()).padStart(2, "0");
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const aaaa = fecha.getFullYear().toString();
  return `${dd}/${mm}/${aaaa}`;
}

const TEXTO_MOTIVO_TRASLADO: Record<string, string> = {
  VENTA: "VENTA",
  TRANSFERENCIA_ESTABLECIMIENTOS: "TRANSFERENCIA ENTRE ESTABLECIMIENTOS DE LA MISMA EMPRESA",
  CONSIGNACION: "CONSIGNACION",
  DEVOLUCION: "DEVOLUCION",
  IMPORTACION: "IMPORTACION",
  EXPORTACION: "EXPORTACION",
  OTROS: "OTROS",
};

export function textoMotivoTraslado(motivo: string): string {
  return TEXTO_MOTIVO_TRASLADO[motivo] ?? motivo;
}

export function generarXmlGuiaRemision(guia: GuiaRemisionParaXml, emisor: DatosEmisor): string {
  const [estab, ptoEmi, secuencialNum] = guia.secuencial.split("-");

  let doc = create({ version: "1.0", encoding: "UTF-8" })
    .ele("guiaRemision", { id: "comprobante", version: "1.0.0" })
    .ele("infoTributaria")
      .ele("ambiente").txt(emisor.ambiente).up()
      .ele("tipoEmision").txt("1").up()
      .ele("razonSocial").txt(emisor.razonSocial).up()
      .ele("nombreComercial").txt(emisor.nombreComercial ?? emisor.razonSocial).up()
      .ele("ruc").txt(emisor.ruc).up()
      .ele("claveAcceso").txt(guia.claveAcceso).up()
      .ele("codDoc").txt("06").up() // 06 = guía de remisión
      .ele("estab").txt(estab).up()
      .ele("ptoEmi").txt(ptoEmi).up()
      .ele("secuencial").txt(secuencialNum).up()
      .ele("dirMatriz").txt(emisor.dirMatriz).up()
    .up() // cierra infoTributaria

    .ele("infoGuiaRemision")
      .ele("dirEstablecimiento").txt(emisor.dirEstablecimiento ?? emisor.dirMatriz).up()
      .ele("dirPartida").txt(guia.dirPartida).up()
      .ele("razonSocialTransportista").txt(guia.transportistaRazonSocial).up()
      .ele("tipoIdentificacionTransportista").txt(codigoTipoIdentificacion(guia.transportistaTipoIdentificacion)).up()
      // El tag oficial se llama "rucTransportista" incluso cuando la
      // identificación es cédula/pasaporte.
      .ele("rucTransportista").txt(guia.transportistaIdentificacion).up()
      .ele("obligadoContabilidad").txt(emisor.obligadoContabilidad ? "SI" : "NO").up()
      .ele("fechaIniTransporte").txt(formatearFechaSri(guia.fechaIniTransporte)).up()
      .ele("fechaFinTransporte").txt(formatearFechaSri(guia.fechaFinTransporte)).up()
      .ele("placa").txt(guia.placa).up()
    .up() // cierra infoGuiaRemision

    .ele("destinatarios")
      .ele("destinatario")
        .ele("identificacionDestinatario").txt(guia.destinatarioIdentificacion).up()
        .ele("razonSocialDestinatario").txt(guia.destinatarioRazonSocial).up()
        .ele("dirDestinatario").txt(guia.destinatarioDireccion).up()
        .ele("motivoTraslado").txt(textoMotivoTraslado(guia.motivoTraslado)).up();

  if (guia.ruta) {
    doc = doc.ele("ruta").txt(guia.ruta).up();
  }

  doc = doc
        // Documento de sustento: la Factura que esta guía transporta — sin
        // esto, el SRI no puede vincular el traslado a ninguna venta.
        .ele("codDocSustento").txt("01").up() // 01 = factura
        .ele("numDocSustento").txt(guia.factura.secuencial).up()
        .ele("numAutDocSustento").txt(guia.factura.claveAcceso ?? "").up()
        .ele("fechaEmisionDocSustento").txt(formatearFechaSri(guia.factura.fechaEmision)).up();

  doc = doc.ele("detalles");

  for (const linea of guia.detalles) {
    doc = doc
      .ele("detalle")
        .ele("codigoInterno").txt(linea.producto.codigo).up()
        .ele("descripcion").txt(linea.descripcion).up()
        .ele("cantidad").txt(linea.cantidad.toFixed(2)).up()
        // Presente (vacío) en los dos ejemplos oficiales del XSD del SRI —
        // ver comentario de cabecera. Sin campos adicionales que declarar.
        .ele("detallesAdicionales").up()
      .up();
  }

  const docFinal = doc
      .up() // cierra detalles
      .up() // cierra destinatario
    .up(); // cierra destinatarios

  return docFinal.end({ prettyPrint: true });
}
