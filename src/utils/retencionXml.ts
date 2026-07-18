// Genera el XML del COMPROBANTE DE RETENCIÓN según el esquema del SRI
// (Ecuador), tipoComprobante "07". Todavía sin firmar — eso lo hace
// firmarXadesBes.ts, igual que con factura/nota de crédito.
//
// A diferencia de Factura/NotaCredito, no hay "detalles" de productos: acá
// las líneas son impuestos retenidos (IVA y/o Renta) sobre el documento de
// compra que sirve de sustento.
//
// IMPORTANTE — igual que se dejó anotado en el plan de este módulo: los
// nombres exactos de tags, la versión del esquema y los códigos de catálogo
// (codSustento, codDocSustento, codigo 1=RENTA/2=IVA) están marcados con
// "VERIFICAR" abajo — hay que confirmarlos contra la Ficha Técnica / XSD
// oficial vigente del SRI antes del primer envío real. Si algo queda mal acá,
// el SRI simplemente rechaza el comprobante en Recepción (visible, no un
// fallo silencioso) — mismo comportamiento que ya maneja el resto del
// pipeline (ver routes/retenciones.ts).

import { create } from "xmlbuilder2";
import { Prisma } from "@prisma/client";

interface LineaRetencionParaXml {
  tipoImpuesto: "IVA" | "RENTA";
  codigoRetencion: string;
  baseImponible: Prisma.Decimal;
  porcentaje: Prisma.Decimal;
  valorRetenido: Prisma.Decimal;
}

interface RetencionParaXml {
  claveAcceso: string;
  secuencial: string; // "001-001-000000001"
  fechaEmision: Date;
  periodoFiscal: string; // "MM/AAAA"
  total: Prisma.Decimal;
  proveedor: { tipoIdentificacion: string; identificacion: string; razonSocial: string };
  compra: { numeroFactura: string; fechaEmision: Date };
  detalles: LineaRetencionParaXml[];
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

// Mismo mapeo que facturaXml.ts/notaCreditoXml.ts — se duplica a propósito
// (convención ya establecida en este repo: cada *Xml.ts es autocontenido).
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

// VERIFICAR: tabla oficial del SRI para "codigo" dentro de <impuestoRetenido>.
// 1 = Renta, 2 = IVA es lo documentado habitualmente en la Ficha Técnica.
function codigoImpuestoRetenido(tipoImpuesto: "IVA" | "RENTA"): string {
  return tipoImpuesto === "RENTA" ? "1" : "2";
}

export function generarXmlRetencion(retencion: RetencionParaXml, emisor: DatosEmisor): string {
  const [estab, ptoEmi, secuencialNum] = retencion.secuencial.split("-");

  let doc = create({ version: "1.0", encoding: "UTF-8" })
    // VERIFICAR: versión de esquema vigente ("1.0.0" vs "2.0.0" — el SRI
    // introdujo 2.0.0 con campos adicionales como reembolsos, no usados acá).
    .ele("comprobanteRetencion", { id: "comprobante", version: "1.0.0" })
    .ele("infoTributaria")
      .ele("ambiente").txt(emisor.ambiente).up()
      .ele("tipoEmision").txt("1").up()
      .ele("razonSocial").txt(emisor.razonSocial).up()
      .ele("nombreComercial").txt(emisor.nombreComercial ?? emisor.razonSocial).up()
      .ele("ruc").txt(emisor.ruc).up()
      .ele("claveAcceso").txt(retencion.claveAcceso).up()
      .ele("codDoc").txt("07").up() // 07 = comprobante de retención
      .ele("estab").txt(estab).up()
      .ele("ptoEmi").txt(ptoEmi).up()
      .ele("secuencial").txt(secuencialNum).up()
      .ele("dirMatriz").txt(emisor.dirMatriz).up()
    .up() // cierra infoTributaria

    // VERIFICAR: nombre exacto del tag ("infoCompRetencion" es el más
    // documentado; alguna versión de la Ficha Técnica lo llama distinto).
    .ele("infoCompRetencion")
      .ele("fechaEmision").txt(formatearFechaSri(retencion.fechaEmision)).up()
      .ele("dirEstablecimiento").txt(emisor.dirEstablecimiento ?? emisor.dirMatriz).up()
      .ele("obligadoContabilidad").txt(emisor.obligadoContabilidad ? "SI" : "NO").up()
      .ele("tipoIdentificacionSujetoRetenido").txt(codigoTipoIdentificacion(retencion.proveedor.tipoIdentificacion)).up()
      .ele("razonSocialSujetoRetenido").txt(retencion.proveedor.razonSocial).up()
      .ele("identificacionSujetoRetenido").txt(retencion.proveedor.identificacion).up()
      .ele("periodoFiscal").txt(retencion.periodoFiscal).up()
    .up() // cierra infoCompRetencion

    .ele("docsSustento")
      .ele("docSustento")
        // VERIFICAR catálogo: "01" = documento sustento nacional (compra) es
        // lo habitual, pero confirmar contra la tabla vigente.
        .ele("codSustento").txt("01").up()
        // VERIFICAR catálogo: "01" = factura del proveedor.
        .ele("codDocSustento").txt("01").up()
        .ele("numDocSustento").txt(retencion.compra.numeroFactura).up()
        .ele("fechaEmisionDocSustento").txt(formatearFechaSri(retencion.compra.fechaEmision)).up();

  for (const linea of retencion.detalles) {
    doc = doc
      // VERIFICAR: nombre del tag repetible — "impuestoRetenido" es lo más
      // documentado para la versión 1.0.0.
      .ele("impuestoRetenido")
        .ele("codigo").txt(codigoImpuestoRetenido(linea.tipoImpuesto)).up()
        .ele("codigoRetencion").txt(linea.codigoRetencion).up()
        .ele("baseImponible").txt(linea.baseImponible.toFixed(2)).up()
        .ele("porcentajeRetener").txt(linea.porcentaje.toFixed(2)).up()
        .ele("valorRetenido").txt(linea.valorRetenido.toFixed(2)).up()
      .up();
  }

  const docFinal = doc
        .ele("totalComprobantesRetencion").txt(retencion.total.toFixed(2)).up()
      .up() // cierra docSustento
    .up(); // cierra docsSustento

  return docFinal.end({ prettyPrint: true });
}
