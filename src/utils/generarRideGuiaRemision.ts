// Genera el RIDE (Representación Impresa del Comprobante Electrónico) de la
// Guía de Remisión, en PDF. Mismo criterio que generarRide.ts/
// generarRideRetencion.ts: el documento con validez legal real es el XML
// autorizado por el SRI, esto es solo la "hoja" que se entrega al
// transportista para el control en carretera — sin montos, con los datos de
// transportista/vehículo/traslado y el detalle de bienes.

import { PDFDocument, StandardFonts, rgb, PDFFont } from "pdf-lib";
import { generarQrClaveAcceso } from "./generarQrClaveAcceso";
import { leerLogoEmpresa } from "./logoEmpresa";
import { empresaActiva } from "../db";
import { rutaAbsoluta } from "./empresas";
import { textoMotivoTraslado } from "./guiaRemisionXml";

interface DetalleParaRide {
  producto: { codigo: string };
  cantidad: number;
  descripcion: string;
}

interface GuiaRemisionParaRide {
  secuencial: string;
  claveAcceso: string;
  fechaEmision: Date;
  estado: string;
  destinatarioIdentificacion: string;
  destinatarioRazonSocial: string;
  destinatarioDireccion: string;
  motivoTraslado: string;
  ruta?: string | null;
  dirPartida: string;
  transportistaIdentificacion: string;
  transportistaRazonSocial: string;
  placa: string;
  fechaIniTransporte: Date;
  fechaFinTransporte: Date;
  factura: { secuencial: string };
  detalles: DetalleParaRide[];
}

interface DatosEmisorRide {
  ruc: string;
  razonSocial: string;
  dirMatriz: string;
  ambiente: "1" | "2";
}

export async function generarRideGuiaRemisionPdf(guia: GuiaRemisionParaRide, emisor: DatosEmisorRide): Promise<Uint8Array> {
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

  // --- Encabezado: datos del emisor ---
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
  escribir("GUÍA DE REMISIÓN", recuadroX + 10, recuadroY + 52, { size: 10, font: fontBold });
  escribir(`No. ${guia.secuencial}`, recuadroX + 10, recuadroY + 36, { size: 10 });
  escribir(
    `Ambiente: ${emisor.ambiente === "2" ? "PRODUCCIÓN" : "PRUEBAS"}`,
    recuadroX + 10,
    recuadroY + 22,
    { size: 8, color: grisTexto }
  );
  escribir(`Estado: ${guia.estado}`, recuadroX + 10, recuadroY + 10, { size: 8, color: grisTexto });

  // --- Código QR con la clave de acceso ---
  const qrBuffer = await generarQrClaveAcceso(guia.claveAcceso);
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
  escribir(guia.claveAcceso, margenIzquierdo, y, { size: 7, color: grisTexto });

  y -= 25;
  page.drawLine({ start: { x: margenIzquierdo, y }, end: { x: margenDerecho, y }, thickness: 0.5, color: grisTexto });
  y -= 18;

  // --- Destinatario ---
  escribir("Destinatario:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(guia.destinatarioRazonSocial, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Identificación:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(guia.destinatarioIdentificacion, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Dirección de entrega:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(guia.destinatarioDireccion, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Motivo del traslado:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(textoMotivoTraslado(guia.motivoTraslado), margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Documento sustento:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(`Fact. ${guia.factura.secuencial}`, margenIzquierdo + 130, y, { size: 8 });
  if (guia.ruta) {
    y -= 13;
    escribir("Ruta:", margenIzquierdo, y, { size: 8, font: fontBold });
    escribir(guia.ruta, margenIzquierdo + 130, y, { size: 8 });
  }

  y -= 22;
  page.drawLine({ start: { x: margenIzquierdo, y }, end: { x: margenDerecho, y }, thickness: 0.5, color: grisTexto });
  y -= 18;

  // --- Transportista y traslado ---
  escribir("Transportista:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(guia.transportistaRazonSocial, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Identificación:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(guia.transportistaIdentificacion, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Placa:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(guia.placa, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Dirección de partida:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(guia.dirPartida, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Fecha inicio traslado:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(formatearFecha(guia.fechaIniTransporte), margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Fecha fin traslado:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(formatearFecha(guia.fechaFinTransporte), margenIzquierdo + 130, y, { size: 8 });

  y -= 25;

  // --- Tabla de bienes transportados: encabezado ---
  const columnas = {
    codigo: margenIzquierdo,
    descripcion: margenIzquierdo + 80,
    cantidad: margenDerecho - 60,
  };

  page.drawRectangle({ x: margenIzquierdo, y: y - 4, width: margenDerecho - margenIzquierdo, height: 16, color: grisClaro });
  escribir("Código", columnas.codigo + 2, y, { size: 8, font: fontBold });
  escribir("Descripción", columnas.descripcion, y, { size: 8, font: fontBold });
  escribir("Cantidad", columnas.cantidad, y, { size: 8, font: fontBold });
  y -= 18;

  // --- Filas de bienes ---
  for (const linea of guia.detalles) {
    if (y < 150) {
      page = pdfDoc.addPage([595.28, 841.89]);
      y = height - 50;
    }
    escribir(linea.producto.codigo, columnas.codigo + 2, y, { size: 8 });
    escribir(linea.descripcion, columnas.descripcion, y, { size: 8 });
    escribir(String(linea.cantidad), columnas.cantidad, y, { size: 8 });
    y -= 14;
  }

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
