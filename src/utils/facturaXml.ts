// Genera el XML de una FACTURA electrónica según la estructura exigida
// por el SRI (Ecuador). Este XML todavía NO está firmado — eso lo vemos
// en la siguiente lección con XAdES-BES.
//
// La estructura tiene 3 bloques principales:
//   <infoTributaria>  - quién emite, con qué clave de acceso, qué establecimiento
//   <infoFactura>     - a quién se le vende, totales, impuestos, forma de pago
//   <detalles>        - cada línea de producto vendido

import { create } from "xmlbuilder2";
import { Prisma } from "@prisma/client";
import { codigoTipoIdentificacion, codigoPorcentajeIva, codigoFormaPagoSri } from "./codigosSri";

// Tipos mínimos que necesitamos del resultado de Prisma (factura con relaciones)
interface DetalleParaXml {
  producto: { codigo: string; nombre: string; ivaPorcentaje: Prisma.Decimal };
  cantidad: number;
  precioUnitario: Prisma.Decimal;
  descuento: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  ivaValor: Prisma.Decimal;
}

interface FacturaParaXml {
  claveAcceso: string;
  secuencial: string; // formato "001-001-000000001"
  fechaEmision: Date;
  subtotal0: Prisma.Decimal;
  subtotal12: Prisma.Decimal;
  iva: Prisma.Decimal;
  total: Prisma.Decimal;
  cliente: {
    tipoIdentificacion: string;
    identificacion: string;
    razonSocial: string;
    direccion?: string | null;
  };
  detalles: DetalleParaXml[];
  // Forma de pago REAL de esta venta (valores internos: EFECTIVO,
  // TRANSFERENCIA, TARJETA, CHEQUE, OTRO — ver Pago.formaPago en
  // schema.prisma) y, si es TARJETA, si fue débito o crédito. Opcional:
  // cuando todavía no se conoce (ej. venta que queda 100% PENDIENTE, sin
  // ningún pago asociado), se manda como "01" (efectivo) por default — ver
  // codigoFormaPagoSri().
  formaPago?: string;
  tarjetaTipo?: string | null;
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
  tarifa: number; // el % real (15, 12, 0...) — confirmado que <totalImpuesto> también lo pide, no solo el <impuesto> de cada detalle
  baseImponible: Prisma.Decimal;
  valor: Prisma.Decimal;
}

// El SRI exige un <totalImpuesto> por cada tarifa de IVA distinta presente en
// la factura (ej. si mezclas productos con 0% y con 15%, van DOS bloques).
// Antes esto estaba hardcodeado a un solo bloque con la tarifa vigente, lo que
// hacía que totalSinImpuestos no cuadrara con la suma de bases imponibles en
// cuanto había un producto exento de IVA en la misma venta.
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

export function generarXmlFactura(factura: FacturaParaXml, emisor: DatosEmisor): string {
  const [estab, ptoEmi, secuencialNum] = factura.secuencial.split("-");
  const gruposImpuesto = agruparImpuestosPorTarifa(factura.detalles);

  let doc = create({ version: "1.0", encoding: "UTF-8" })
    .ele("factura", { id: "comprobante", version: "1.1.0" })
    .ele("infoTributaria")
      .ele("ambiente").txt(emisor.ambiente).up()
      .ele("tipoEmision").txt("1").up()
      .ele("razonSocial").txt(emisor.razonSocial).up()
      .ele("nombreComercial").txt(emisor.nombreComercial ?? emisor.razonSocial).up()
      .ele("ruc").txt(emisor.ruc).up()
      .ele("claveAcceso").txt(factura.claveAcceso).up()
      .ele("codDoc").txt("01").up() // 01 = factura
      .ele("estab").txt(estab).up()
      .ele("ptoEmi").txt(ptoEmi).up()
      .ele("secuencial").txt(secuencialNum).up()
      .ele("dirMatriz").txt(emisor.dirMatriz).up()
    .up() // cierra infoTributaria

    .ele("infoFactura")
      .ele("fechaEmision").txt(formatearFechaSri(factura.fechaEmision)).up()
      .ele("dirEstablecimiento").txt(emisor.dirEstablecimiento ?? emisor.dirMatriz).up()
      .ele("obligadoContabilidad").txt(emisor.obligadoContabilidad ? "SI" : "NO").up()
      .ele("tipoIdentificacionComprador").txt(codigoTipoIdentificacion(factura.cliente.tipoIdentificacion)).up()
      .ele("razonSocialComprador").txt(factura.cliente.razonSocial).up()
      .ele("identificacionComprador").txt(factura.cliente.identificacion).up()
      // Confirmado contra una factura real autorizada por el SRI (producción,
      // agosto 2026): el campo va SIEMPRE presente, incluso cuando no se
      // conoce la dirección real (esa factura real traía literalmente "XX").
      .ele("direccionComprador").txt(factura.cliente.direccion?.trim() || "XX").up()
      .ele("totalSinImpuestos").txt(factura.subtotal0.add(factura.subtotal12).toFixed(2)).up()
      .ele("totalDescuento").txt("0.00").up()
      .ele("totalConImpuestos");

  for (const grupo of gruposImpuesto) {
    doc = doc
      .ele("totalImpuesto")
        .ele("codigo").txt("2").up() // 2 = IVA
        .ele("codigoPorcentaje").txt(grupo.codigoPorcentaje).up()
        .ele("tarifa").txt(grupo.tarifa.toFixed(2)).up()
        .ele("baseImponible").txt(grupo.baseImponible.toFixed(2)).up()
        .ele("valor").txt(grupo.valor.toFixed(2)).up()
      .up();
  }

  doc = doc
      .up() // cierra totalConImpuestos
      .ele("propina").txt("0.00").up()
      // Los 3 campos siguientes son para ventas de EXPORTACIÓN — este
      // negocio no exporta, así que siempre van en 0.00, pero el elemento
      // en sí SÍ es obligatorio en el esquema 1.1.0 (confirmado contra una
      // factura real: aparece siempre, aunque sea con ceros).
      .ele("fleteInternacional").txt("0.00").up()
      .ele("seguroInternacional").txt("0.00").up()
      .ele("gastosTransporteOtros").txt("0.00").up()
      .ele("importeTotal").txt(factura.total.toFixed(2)).up()
      .ele("moneda").txt("DOLAR").up()
      .ele("pagos")
        .ele("pago")
          .ele("formaPago").txt(codigoFormaPagoSri(factura.formaPago, factura.tarjetaTipo)).up()
          .ele("total").txt(factura.total.toFixed(2)).up()
          // plazo/unidadTiempo: informativo (plazo de crédito). Se manda
          // fijo en "0"/"dias" — hasta una factura real de venta a crédito
          // (Claro, con "fecha máxima de pago" real en el RIDE) lo manda
          // así, sin calcular los días reales.
          .ele("plazo").txt("0").up()
          .ele("unidadTiempo").txt("dias").up()
        .up()
      .up()
    .up() // cierra infoFactura

    .ele("detalles");

  let docConDetalles = doc;
  for (const item of factura.detalles) {
    docConDetalles = docConDetalles
      .ele("detalle")
        .ele("codigoPrincipal").txt(item.producto.codigo).up()
        .ele("descripcion").txt(item.producto.nombre).up()
        // Confirmado contra una factura real: cantidad/precioUnitario van
        // con 6 decimales, no 2 (a diferencia de los montos en dólares).
        .ele("cantidad").txt(item.cantidad.toFixed(6)).up()
        .ele("precioUnitario").txt(item.precioUnitario.toFixed(6)).up()
        .ele("descuento").txt(item.descuento.toFixed(2)).up()
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

// El SRI exige el formato dd/mm/aaaa (con barras) dentro del XML,
// distinto del formato ddmmaaaa (sin barras) que usamos en la clave de acceso.
function formatearFechaSri(fecha: Date): string {
  const dd = String(fecha.getDate()).padStart(2, "0");
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const aaaa = fecha.getFullYear().toString();
  return `${dd}/${mm}/${aaaa}`;
}
