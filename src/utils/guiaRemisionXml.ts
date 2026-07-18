// Genera el XML de la GUÍA DE REMISIÓN según el esquema del SRI (Ecuador),
// tipoComprobante "06". Todavía sin firmar — eso lo hace firmarXadesBes.ts,
// igual que con factura/nota de crédito/retención.
//
// A diferencia de Factura/NotaCredito, no hay montos ni impuestos: acá el
// bloque propio es "infoGuiaRemision" (transportista, vehículo, fechas del
// traslado) y un único "destinatario" (ver decisión de alcance: un solo
// destinatario por guía) con su lista de bienes transportados.
//
// IMPORTANTE — igual criterio que retencionXml.ts: los nombres exactos de
// tags y la versión del esquema están marcados con "VERIFICAR" donde no se
// pudo confirmar al 100% contra la Ficha Técnica oficial (el PDF vigente del
// SRI es un escaneo, no tiene texto extraíble). La estructura base sí se
// confirmó contra una implementación real en producción. Si algo queda mal
// acá, el SRI simplemente rechaza el comprobante en Recepción (visible, no
// un fallo silencioso) — mismo comportamiento que ya maneja el resto del
// pipeline.

import { create } from "xmlbuilder2";

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

// Mismo mapeo que facturaXml.ts/notaCreditoXml.ts/retencionXml.ts — se
// duplica a propósito (convención ya establecida: cada *Xml.ts es
// autocontenido).
function codigoTipoIdentificacion(tipo: string): string {
  const mapa: Record<string, string> = { RUC: "04", CEDULA: "05", PASAPORTE: "06", CONSUMIDOR_FINAL: "07" };
  return mapa[tipo] ?? "05";
}

function formatearFechaSri(fecha: Date): string {
  const dd = String(fecha.getDate()).padStart(2, "0");
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const aaaa = fecha.getFullYear().toString();
  return `${dd}/${mm}/${aaaa}`;
}

// VERIFICAR: catálogo oficial del SRI para "motivoTraslado" — este es un
// subconjunto corto y estable (a diferencia de codigoRetencion, no cambia
// periódicamente), pero confirmar la redacción exacta esperada contra la
// Ficha Técnica vigente antes del primer envío real.
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
    // VERIFICAR: versión de esquema vigente ("1.0.0" vs "1.1.0").
    .ele("guiaRemision", { id: "comprobante", version: "1.1.0" })
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
      // VERIFICAR: el tag oficial se llama "rucTransportista" incluso cuando
      // la identificación es cédula/pasaporte (confirmado contra una
      // implementación real en producción).
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

  doc = doc.ele("detalles");

  for (const linea of guia.detalles) {
    doc = doc
      .ele("detalle")
        .ele("codigoInterno").txt(linea.producto.codigo).up()
        .ele("descripcion").txt(linea.descripcion).up()
        .ele("cantidad").txt(String(linea.cantidad)).up()
      .up();
  }

  const docFinal = doc
      .up() // cierra detalles
      .up() // cierra destinatario
    .up(); // cierra destinatarios

  return docFinal.end({ prettyPrint: true });
}
