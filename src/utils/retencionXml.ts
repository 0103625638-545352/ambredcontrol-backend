// Genera el XML del COMPROBANTE DE RETENCIÓN según el esquema del SRI
// (Ecuador), tipoComprobante "07". Todavía sin firmar — eso lo hace
// firmarXadesBes.ts, igual que con factura/nota de crédito.
//
// A diferencia de Factura/NotaCredito, no hay "detalles" de productos: acá
// las líneas son impuestos retenidos (IVA y/o Renta) sobre el documento de
// compra que sirve de sustento.
//
// Estructura y nombres de tag CONFIRMADOS contra un comprobante real,
// autorizado por el SRI en ambiente de PRODUCCIÓN (diciembre 2023) — ya no
// son una suposición de la Ficha Técnica. Dos cosas que se creían correctas
// y NO lo eran (corregidas acá):
//   1. No existe ningún bloque "docsSustento"/"docSustento" con un
//      "codSustento" — codDocSustento/numDocSustento/fechaEmisionDocSustento
//      van DENTRO de cada línea de impuesto, repetidos, no una vez al
//      principio del comprobante.
//   2. Las líneas van envueltas en "<impuestos><impuesto>...</impuesto>
//      </impuestos>", no como "<impuestoRetenido>" repetido suelto.
// Tampoco existe "totalComprobantesRetencion" en ningún lugar del
// comprobante real — se quitó.
import { create } from "xmlbuilder2";
import { Prisma } from "@prisma/client";
import { codigoTipoIdentificacion } from "./codigosSri";

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

function formatearFechaSri(fecha: Date): string {
  const dd = String(fecha.getDate()).padStart(2, "0");
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const aaaa = fecha.getFullYear().toString();
  return `${dd}/${mm}/${aaaa}`;
}

// Confirmado contra el comprobante real: código 1 = Renta, código 2 = IVA.
function codigoImpuestoRetenido(tipoImpuesto: "IVA" | "RENTA"): string {
  return tipoImpuesto === "RENTA" ? "1" : "2";
}

export function generarXmlRetencion(retencion: RetencionParaXml, emisor: DatosEmisor): string {
  const [estab, ptoEmi, secuencialNum] = retencion.secuencial.split("-");
  const fechaDocSustento = formatearFechaSri(retencion.compra.fechaEmision);

  let doc = create({ version: "1.0", encoding: "UTF-8" })
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

    .ele("infoCompRetencion")
      .ele("fechaEmision").txt(formatearFechaSri(retencion.fechaEmision)).up()
      .ele("dirEstablecimiento").txt(emisor.dirEstablecimiento ?? emisor.dirMatriz).up()
      .ele("obligadoContabilidad").txt(emisor.obligadoContabilidad ? "SI" : "NO").up()
      .ele("tipoIdentificacionSujetoRetenido").txt(codigoTipoIdentificacion(retencion.proveedor.tipoIdentificacion)).up()
      .ele("razonSocialSujetoRetenido").txt(retencion.proveedor.razonSocial).up()
      .ele("identificacionSujetoRetenido").txt(retencion.proveedor.identificacion).up()
      .ele("periodoFiscal").txt(retencion.periodoFiscal).up()
    .up() // cierra infoCompRetencion

    .ele("impuestos");

  for (const linea of retencion.detalles) {
    doc = doc
      .ele("impuesto")
        .ele("codigo").txt(codigoImpuestoRetenido(linea.tipoImpuesto)).up()
        .ele("codigoRetencion").txt(linea.codigoRetencion).up()
        .ele("baseImponible").txt(linea.baseImponible.toFixed(2)).up()
        .ele("porcentajeRetener").txt(linea.porcentaje.toFixed(2)).up()
        .ele("valorRetenido").txt(linea.valorRetenido.toFixed(2)).up()
        // El documento de sustento (la Compra) va REPETIDO en cada línea de
        // impuesto, no una vez sola al principio del comprobante — así lo
        // trae el comprobante real que confirmó esta estructura.
        .ele("codDocSustento").txt("01").up() // 01 = factura del proveedor
        .ele("numDocSustento").txt(retencion.compra.numeroFactura).up()
        .ele("fechaEmisionDocSustento").txt(fechaDocSustento).up()
      .up();
  }

  const docFinal = doc.up(); // cierra impuestos

  return docFinal.end({ prettyPrint: true });
}
