// Genera el XML de una NOTA DE CRÉDITO según el esquema del SRI (Ecuador).
//
// Es muy parecido al XML de factura que ya construimos, con dos diferencias
// clave:
//   1. <infoTributaria><codDoc> es "04" en vez de "01"
//   2. Tiene un bloque nuevo, "infoNotaCredito", que hace referencia explícita
//      a la factura original que está corrigiendo (codDocModificado,
//      numDocModificado, fechaEmisionDocSustento) — así el SRI sabe qué
//      documento previo se está afectando.

import { create } from "xmlbuilder2";
import { Prisma } from "@prisma/client";
import { codigoTipoIdentificacion, codigoPorcentajeIva } from "./codigosSri";

interface DetalleParaXml {
  producto: { codigo: string; nombre: string; ivaPorcentaje: Prisma.Decimal };
  cantidad: number;
  precioUnitario: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  ivaValor: Prisma.Decimal;
}

interface NotaCreditoParaXml {
  claveAcceso: string;
  secuencial: string; // "001-001-000000001"
  fechaEmision: Date;
  motivo: string;
  subtotal0: Prisma.Decimal;
  subtotal12: Prisma.Decimal;
  iva: Prisma.Decimal;
  total: Prisma.Decimal;
  cliente: { tipoIdentificacion: string; identificacion: string; razonSocial: string };
  detalles: DetalleParaXml[];
  facturaModificada: { secuencial: string; fechaEmision: Date };
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

interface GrupoImpuesto {
  codigoPorcentaje: string;
  tarifa: number; // confirmado contra facturaXml.ts (mismo tipo "totalImpuesto" del esquema SRI): también lleva <tarifa>, no solo <codigoPorcentaje>
  baseImponible: Prisma.Decimal;
  valor: Prisma.Decimal;
}

// Igual que en facturaXml.ts: un <totalImpuesto> por cada tarifa de IVA
// distinta presente en la nota de crédito, no una sola tarifa hardcodeada.
function agruparImpuestosPorTarifa(detalles: DetalleParaXml[]): GrupoImpuesto[] {
  const grupos = new Map<string, GrupoImpuesto>();

  for (const item of detalles) {
    const tarifa = item.producto.ivaPorcentaje.toNumber();
    const codigoPorcentaje = codigoPorcentajeIva(tarifa);
    const grupo = grupos.get(codigoPorcentaje) ?? {
      codigoPorcentaje,
      tarifa,
      baseImponible: new Prisma.Decimal(0),
      valor: new Prisma.Decimal(0),
    };
    grupo.baseImponible = grupo.baseImponible.add(item.subtotal);
    grupo.valor = grupo.valor.add(item.ivaValor);
    grupos.set(codigoPorcentaje, grupo);
  }

  return Array.from(grupos.values());
}

function formatearFechaSri(fecha: Date): string {
  const dd = String(fecha.getDate()).padStart(2, "0");
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const aaaa = fecha.getFullYear().toString();
  return `${dd}/${mm}/${aaaa}`;
}

export function generarXmlNotaCredito(nc: NotaCreditoParaXml, emisor: DatosEmisor): string {
  const [estab, ptoEmi, secuencialNum] = nc.secuencial.split("-");
  const gruposImpuesto = agruparImpuestosPorTarifa(nc.detalles);

  let doc = create({ version: "1.0", encoding: "UTF-8" })
    .ele("notaCredito", { id: "comprobante", version: "1.1.0" })
    .ele("infoTributaria")
      .ele("ambiente").txt(emisor.ambiente).up()
      .ele("tipoEmision").txt("1").up()
      .ele("razonSocial").txt(emisor.razonSocial).up()
      .ele("nombreComercial").txt(emisor.nombreComercial ?? emisor.razonSocial).up()
      .ele("ruc").txt(emisor.ruc).up()
      .ele("claveAcceso").txt(nc.claveAcceso).up()
      .ele("codDoc").txt("04").up() // 04 = nota de crédito
      .ele("estab").txt(estab).up()
      .ele("ptoEmi").txt(ptoEmi).up()
      .ele("secuencial").txt(secuencialNum).up()
      .ele("dirMatriz").txt(emisor.dirMatriz).up()
    .up()

    .ele("infoNotaCredito")
      .ele("fechaEmision").txt(formatearFechaSri(nc.fechaEmision)).up()
      .ele("dirEstablecimiento").txt(emisor.dirEstablecimiento ?? emisor.dirMatriz).up()
      .ele("tipoIdentificacionComprador").txt(codigoTipoIdentificacion(nc.cliente.tipoIdentificacion)).up()
      .ele("razonSocialComprador").txt(nc.cliente.razonSocial).up()
      .ele("identificacionComprador").txt(nc.cliente.identificacion).up()
      .ele("obligadoContabilidad").txt(emisor.obligadoContabilidad ? "SI" : "NO").up()
      .ele("codDocModificado").txt("01").up() // 01 = el documento que se modifica es una factura
      .ele("numDocModificado").txt(nc.facturaModificada.secuencial).up()
      .ele("fechaEmisionDocSustento").txt(formatearFechaSri(nc.facturaModificada.fechaEmision)).up()
      .ele("totalSinImpuestos").txt(nc.subtotal0.add(nc.subtotal12).toFixed(2)).up()
      .ele("valorModificacion").txt(nc.total.toFixed(2)).up()
      .ele("moneda").txt("DOLAR").up()
      .ele("totalConImpuestos");

  for (const grupo of gruposImpuesto) {
    doc = doc
      .ele("totalImpuesto")
        .ele("codigo").txt("2").up()
        .ele("codigoPorcentaje").txt(grupo.codigoPorcentaje).up()
        .ele("tarifa").txt(grupo.tarifa.toFixed(2)).up()
        .ele("baseImponible").txt(grupo.baseImponible.toFixed(2)).up()
        .ele("valor").txt(grupo.valor.toFixed(2)).up()
      .up();
  }

  doc = doc
      .up() // cierra totalConImpuestos
      .ele("motivo").txt(nc.motivo).up()
    .up()

    .ele("detalles");

  let docConDetalles = doc;
  for (const item of nc.detalles) {
    docConDetalles = docConDetalles
      .ele("detalle")
        .ele("codigoInterno").txt(item.producto.codigo).up()
        .ele("descripcion").txt(item.producto.nombre).up()
        // Confirmado contra una factura real (mismo campo, mismo esquema
        // base): 6 decimales, no 2.
        .ele("cantidad").txt(item.cantidad.toFixed(6)).up()
        .ele("precioUnitario").txt(item.precioUnitario.toFixed(6)).up()
        .ele("descuento").txt("0.00").up()
        .ele("precioTotalSinImpuesto").txt(item.subtotal.toFixed(2)).up()
        .ele("impuestos")
          .ele("impuesto")
            .ele("codigo").txt("2").up()
            .ele("codigoPorcentaje").txt(codigoPorcentajeIva(item.producto.ivaPorcentaje.toNumber())).up()
            .ele("tarifa").txt(item.producto.ivaPorcentaje.toFixed(2)).up()
            .ele("baseImponible").txt(item.subtotal.toFixed(2)).up()
            .ele("valor").txt(item.ivaValor.toFixed(2)).up()
          .up()
        .up()
      .up();
  }

  return docConDetalles.end({ prettyPrint: true });
}
