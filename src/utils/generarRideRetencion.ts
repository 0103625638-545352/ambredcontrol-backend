// Genera el RIDE (Representación Impresa del Comprobante Electrónico) del
// Comprobante de Retención, en PDF. Mismo criterio que generarRide.ts: el
// documento con validez legal real es el XML autorizado por el SRI, esto es
// solo la "hoja bonita" para archivar/entregar al proveedor.

import { PDFDocument, StandardFonts, rgb, PDFFont } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { generarQrClaveAcceso } from "./generarQrClaveAcceso";
import { leerLogoEmpresa } from "./logoEmpresa";
import { empresaActiva } from "../db";
import { rutaAbsoluta } from "./empresas";

interface LineaParaRide {
  tipoImpuesto: "IVA" | "RENTA";
  clasificacion: "BIEN" | "SERVICIO";
  codigoRetencion: string;
  baseImponible: Prisma.Decimal;
  porcentaje: Prisma.Decimal;
  valorRetenido: Prisma.Decimal;
}

interface RetencionParaRide {
  secuencial: string;
  claveAcceso: string;
  fechaEmision: Date;
  periodoFiscal: string;
  estado: string;
  totalIva: Prisma.Decimal;
  totalRenta: Prisma.Decimal;
  total: Prisma.Decimal;
  proveedor: { tipoIdentificacion: string; identificacion: string; razonSocial: string };
  compra: { numeroFactura: string; fechaEmision: Date };
  detalles: LineaParaRide[];
}

interface DatosEmisorRide {
  ruc: string;
  razonSocial: string;
  dirMatriz: string;
  ambiente: "1" | "2";
}

export async function generarRideRetencionPdf(retencion: RetencionParaRide, emisor: DatosEmisorRide): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage([595.28, 841.89]); // A4 en puntos
  const { width, height } = page.getSize();

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const margenIzquierdo = 40;
  const margenDerecho = width - 40;
  let y = height - 50;

  const grisClaro = rgb(0.93, 0.93, 0.93);
  const grisTexto = rgb(0.3, 0.3, 0.3);
  const negro = rgb(0, 0, 0);

  function escribir(
    texto: string,
    x: number,
    yPos: number,
    opciones: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb> } = {}
  ) {
    page.drawText(texto, {
      x,
      y: yPos,
      size: opciones.size ?? 9,
      font: opciones.font ?? fontRegular,
      color: opciones.color ?? negro,
    });
  }

  // --- Logo de la empresa (opcional) ---
  let xTextoEmisor = margenIzquierdo;
  const logo = leerLogoEmpresa(rutaAbsoluta(empresaActiva().carpetaUploads));
  if (logo) {
    const imagenLogo = logo.extension === "png" ? await pdfDoc.embedPng(logo.bytes) : await pdfDoc.embedJpg(logo.bytes);
    const altoMaximo = 46;
    const anchoMaximo = 90;
    const escala = Math.min(anchoMaximo / imagenLogo.width, altoMaximo / imagenLogo.height, 1);
    const anchoLogo = imagenLogo.width * escala;
    const altoLogo = imagenLogo.height * escala;
    page.drawImage(imagenLogo, { x: margenIzquierdo, y: y - altoLogo + 12, width: anchoLogo, height: altoLogo });
    xTextoEmisor = margenIzquierdo + anchoLogo + 12;
  }

  // --- Encabezado: datos del emisor (agente de retención) ---
  escribir(emisor.razonSocial, xTextoEmisor, y, { size: 14, font: fontBold });
  y -= 16;
  escribir(`RUC: ${emisor.ruc}`, xTextoEmisor, y, { size: 9, color: grisTexto });
  y -= 12;
  escribir(emisor.dirMatriz, xTextoEmisor, y, { size: 9, color: grisTexto });

  // --- Recuadro derecho: No. de comprobante y ambiente ---
  const recuadroX = 320;
  const recuadroY = height - 90;
  page.drawRectangle({
    x: recuadroX,
    y: recuadroY,
    width: margenDerecho - recuadroX,
    height: 70,
    borderColor: negro,
    borderWidth: 1,
  });
  escribir("COMPROBANTE DE RETENCIÓN", recuadroX + 10, recuadroY + 52, { size: 10, font: fontBold });
  escribir(`No. ${retencion.secuencial}`, recuadroX + 10, recuadroY + 36, { size: 10 });
  escribir(
    `Ambiente: ${emisor.ambiente === "2" ? "PRODUCCIÓN" : "PRUEBAS"}`,
    recuadroX + 10,
    recuadroY + 22,
    { size: 8, color: grisTexto }
  );
  escribir(`Estado: ${retencion.estado}`, recuadroX + 10, recuadroY + 10, { size: 8, color: grisTexto });

  // --- Código QR con la clave de acceso ---
  const qrBuffer = await generarQrClaveAcceso(retencion.claveAcceso);
  const qrImagen = await pdfDoc.embedPng(qrBuffer);
  const qrTamano = 70;
  escribir("Verifica con este código:", margenDerecho - qrTamano, recuadroY - 8, { size: 6, color: grisTexto });
  page.drawImage(qrImagen, {
    x: margenDerecho - qrTamano,
    y: recuadroY - 8 - qrTamano,
    width: qrTamano,
    height: qrTamano,
  });

  y = height - 130;

  // --- Clave de acceso ---
  escribir("Clave de acceso:", margenIzquierdo, y, { size: 8, font: fontBold });
  y -= 11;
  escribir(retencion.claveAcceso, margenIzquierdo, y, { size: 7, color: grisTexto });

  y -= 25;
  page.drawLine({ start: { x: margenIzquierdo, y }, end: { x: margenDerecho, y }, thickness: 0.5, color: grisTexto });
  y -= 18;

  // --- Datos del sujeto retenido (el proveedor) ---
  escribir("Sujeto retenido:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(retencion.proveedor.razonSocial, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Identificación:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(retencion.proveedor.identificacion, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Documento sustento:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(`Fact. ${retencion.compra.numeroFactura} (${formatearFecha(retencion.compra.fechaEmision)})`, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Fecha de emisión:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(formatearFecha(retencion.fechaEmision), margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Periodo fiscal:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(retencion.periodoFiscal, margenIzquierdo + 130, y, { size: 8 });

  y -= 25;

  // --- Tabla de impuestos retenidos: encabezado ---
  const columnas = {
    tipo: margenIzquierdo,
    clasificacion: margenIzquierdo + 55,
    codigo: margenIzquierdo + 130,
    base: margenIzquierdo + 210,
    porcentaje: margenIzquierdo + 300,
    valor: margenIzquierdo + 370,
  };

  page.drawRectangle({ x: margenIzquierdo, y: y - 4, width: margenDerecho - margenIzquierdo, height: 16, color: grisClaro });
  escribir("Impuesto", columnas.tipo + 2, y, { size: 8, font: fontBold });
  escribir("Clasif.", columnas.clasificacion, y, { size: 8, font: fontBold });
  escribir("Código", columnas.codigo, y, { size: 8, font: fontBold });
  escribir("Base imp.", columnas.base, y, { size: 8, font: fontBold });
  escribir("%", columnas.porcentaje, y, { size: 8, font: fontBold });
  escribir("Valor ret.", columnas.valor, y, { size: 8, font: fontBold });
  y -= 18;

  // --- Filas de impuestos retenidos ---
  for (const linea of retencion.detalles) {
    if (y < 150) {
      page = pdfDoc.addPage([595.28, 841.89]);
      y = height - 50;
    }
    escribir(linea.tipoImpuesto === "IVA" ? "IVA" : "Renta", columnas.tipo + 2, y, { size: 8 });
    escribir(linea.clasificacion === "BIEN" ? "Bien" : "Servicio", columnas.clasificacion, y, { size: 8 });
    escribir(linea.codigoRetencion, columnas.codigo, y, { size: 8 });
    escribir(linea.baseImponible.toFixed(2), columnas.base, y, { size: 8 });
    escribir(`${linea.porcentaje.toFixed(2)}%`, columnas.porcentaje, y, { size: 8 });
    escribir(linea.valorRetenido.toFixed(2), columnas.valor, y, { size: 8 });
    y -= 14;
  }

  y -= 15;
  page.drawLine({ start: { x: margenIzquierdo, y }, end: { x: margenDerecho, y }, thickness: 0.5, color: grisTexto });
  y -= 18;

  // --- Totales: caja con bordes ---
  const totalesX = margenDerecho - 180;
  const filaAlto = 15;
  const filasTotales = [
    { etiqueta: "Total IVA retenido:", valor: retencion.totalIva.toFixed(2) },
    { etiqueta: "Total Renta retenida:", valor: retencion.totalRenta.toFixed(2) },
  ];
  const cajaAlto = filaAlto * filasTotales.length + filaAlto + 4;
  const cajaY = y - cajaAlto + filaAlto;
  page.drawRectangle({
    x: totalesX - 8,
    y: cajaY,
    width: margenDerecho - totalesX + 8,
    height: cajaAlto,
    borderColor: grisTexto,
    borderWidth: 0.75,
  });
  for (const fila of filasTotales) {
    escribir(fila.etiqueta, totalesX, y, { size: 9 });
    escribir(fila.valor, margenDerecho - 40, y, { size: 9 });
    y -= filaAlto;
    page.drawLine({
      start: { x: totalesX - 8, y: y + 4 },
      end: { x: margenDerecho, y: y + 4 },
      thickness: 0.5,
      color: grisClaro,
    });
  }
  page.drawRectangle({ x: totalesX - 8, y: y - 4, width: margenDerecho - totalesX + 8, height: filaAlto + 4, color: grisClaro });
  escribir("TOTAL RETENIDO:", totalesX, y, { size: 10, font: fontBold });
  escribir(`$${retencion.total.toFixed(2)}`, margenDerecho - 50, y, { size: 10, font: fontBold });

  // --- Pie de página ---
  const pieY = 60;
  page.drawLine({ start: { x: margenIzquierdo, y: pieY }, end: { x: margenDerecho, y: pieY }, thickness: 0.5, color: grisTexto });
  escribir(
    "Este documento es una representación impresa de un comprobante electrónico. El documento con validez",
    margenIzquierdo,
    pieY - 14,
    { size: 7, color: grisTexto }
  );
  escribir(
    "legal es el archivo XML autorizado por el Servicio de Rentas Internas (SRI).",
    margenIzquierdo,
    pieY - 24,
    { size: 7, color: grisTexto }
  );
  const marcaSistema = "Generado con AmbrossISP PYMES";
  const anchoMarca = fontRegular.widthOfTextAtSize(marcaSistema, 7);
  escribir(marcaSistema, (width - anchoMarca) / 2, pieY - 42, { size: 7, color: grisTexto });

  return pdfDoc.save();
}

function formatearFecha(fecha: Date): string {
  const dd = String(fecha.getDate()).padStart(2, "0");
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const aaaa = fecha.getFullYear().toString();
  return `${dd}/${mm}/${aaaa}`;
}
