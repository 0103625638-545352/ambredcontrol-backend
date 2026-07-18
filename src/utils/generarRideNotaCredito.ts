// Genera el RIDE de una nota de crédito. Es casi idéntico al de factura,
// con dos diferencias visibles: el título dice "NOTA DE CRÉDITO" y se
// muestra a qué factura corrige.

import { PDFDocument, StandardFonts, rgb, PDFFont } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { generarQrClaveAcceso } from "./generarQrClaveAcceso";
import { leerLogoEmpresa } from "./logoEmpresa";
import { empresaActiva } from "../db";
import { rutaAbsoluta } from "./empresas";

interface DetalleParaRide {
  producto: { codigo: string; nombre: string };
  cantidad: number;
  precioUnitario: Prisma.Decimal;
  subtotal: Prisma.Decimal;
}

interface NotaCreditoParaRide {
  secuencial: string;
  claveAcceso: string;
  fechaEmision: Date;
  motivo: string;
  subtotal0: Prisma.Decimal;
  subtotal12: Prisma.Decimal;
  iva: Prisma.Decimal;
  total: Prisma.Decimal;
  estado: string;
  cliente: { tipoIdentificacion: string; identificacion: string; razonSocial: string };
  detalles: DetalleParaRide[];
  facturaModificada: { secuencial: string };
}

interface DatosEmisorRide {
  ruc: string;
  razonSocial: string;
  dirMatriz: string;
  ambiente: "1" | "2";
}

export async function generarRideNotaCreditoPdf(
  nc: NotaCreditoParaRide,
  emisor: DatosEmisorRide
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage([595.28, 841.89]);
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

  escribir(emisor.razonSocial, xTextoEmisor, y, { size: 14, font: fontBold });
  y -= 16;
  escribir(`RUC: ${emisor.ruc}`, xTextoEmisor, y, { size: 9, color: grisTexto });
  y -= 12;
  escribir(emisor.dirMatriz, xTextoEmisor, y, { size: 9, color: grisTexto });

  const recuadroX = 340;
  const recuadroY = height - 100;
  page.drawRectangle({
    x: recuadroX,
    y: recuadroY,
    width: margenDerecho - recuadroX,
    height: 80,
    borderColor: negro,
    borderWidth: 1,
  });
  escribir("NOTA DE CRÉDITO", recuadroX + 10, recuadroY + 62, { size: 11, font: fontBold });
  escribir(`No. ${nc.secuencial}`, recuadroX + 10, recuadroY + 46, { size: 10 });
  escribir(`Corrige factura: ${nc.facturaModificada.secuencial}`, recuadroX + 10, recuadroY + 32, { size: 8, color: grisTexto });
  escribir(
    `Ambiente: ${emisor.ambiente === "2" ? "PRODUCCIÓN" : "PRUEBAS"}`,
    recuadroX + 10,
    recuadroY + 20,
    { size: 8, color: grisTexto }
  );
  escribir(`Estado: ${nc.estado}`, recuadroX + 10, recuadroY + 8, { size: 8, color: grisTexto });

  // --- Código QR con la clave de acceso ---
  // Va debajo del recuadro derecho. Empujamos el inicio del bloque
  // "Clave de acceso" (más abajo, columna izquierda) lo suficiente para
  // garantizar que nunca se solape con el QR, sin importar el largo del
  // motivo o del nombre del cliente.
  const qrBuffer = await generarQrClaveAcceso(nc.claveAcceso);
  const qrImagen = await pdfDoc.embedPng(qrBuffer);
  const qrTamano = 60;
  escribir("Verifica con este código:", margenDerecho - qrTamano, recuadroY - 8, { size: 6, color: grisTexto });
  page.drawImage(qrImagen, {
    x: margenDerecho - qrTamano,
    y: recuadroY - 8 - qrTamano,
    width: qrTamano,
    height: qrTamano,
  });

  y = height - 190;

  escribir("Clave de acceso:", margenIzquierdo, y, { size: 8, font: fontBold });
  y -= 11;
  escribir(nc.claveAcceso, margenIzquierdo, y, { size: 7, color: grisTexto });

  y -= 22;
  escribir("Motivo:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(nc.motivo, margenIzquierdo + 60, y, { size: 8 });

  y -= 20;
  page.drawLine({ start: { x: margenIzquierdo, y }, end: { x: margenDerecho, y }, thickness: 0.5, color: grisTexto });
  y -= 18;

  escribir("Razón Social / Nombres:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(nc.cliente.razonSocial, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Identificación:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(nc.cliente.identificacion, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Fecha de emisión:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(formatearFecha(nc.fechaEmision), margenIzquierdo + 130, y, { size: 8 });

  y -= 25;

  const columnas = {
    codigo: margenIzquierdo,
    descripcion: margenIzquierdo + 60,
    cantidad: margenIzquierdo + 280,
    precio: margenIzquierdo + 330,
    total: margenIzquierdo + 450,
  };

  page.drawRectangle({ x: margenIzquierdo, y: y - 4, width: margenDerecho - margenIzquierdo, height: 16, color: grisClaro });
  escribir("Cód.", columnas.codigo + 2, y, { size: 8, font: fontBold });
  escribir("Descripción", columnas.descripcion, y, { size: 8, font: fontBold });
  escribir("Cant.", columnas.cantidad, y, { size: 8, font: fontBold });
  escribir("P. Unit.", columnas.precio, y, { size: 8, font: fontBold });
  escribir("Total", columnas.total, y, { size: 8, font: fontBold });
  y -= 18;

  for (const item of nc.detalles) {
    if (y < 150) {
      page = pdfDoc.addPage([595.28, 841.89]);
      y = height - 50;
    }
    escribir(item.producto.codigo, columnas.codigo + 2, y, { size: 8 });
    escribir(truncar(item.producto.nombre, 38), columnas.descripcion, y, { size: 8 });
    escribir(item.cantidad.toString(), columnas.cantidad, y, { size: 8 });
    escribir(item.precioUnitario.toFixed(2), columnas.precio, y, { size: 8 });
    escribir(item.subtotal.toFixed(2), columnas.total, y, { size: 8 });
    y -= 14;
  }

  y -= 15;
  page.drawLine({ start: { x: margenIzquierdo, y }, end: { x: margenDerecho, y }, thickness: 0.5, color: grisTexto });
  y -= 18;

  const totalesX = margenDerecho - 180;
  const filaAlto = 15;
  const filasTotales = [
    { etiqueta: "Subtotal 0%:", valor: nc.subtotal0.toFixed(2) },
    { etiqueta: "Subtotal con IVA:", valor: nc.subtotal12.toFixed(2) },
    { etiqueta: "IVA:", valor: nc.iva.toFixed(2) },
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
  escribir("TOTAL:", totalesX, y, { size: 10, font: fontBold });
  escribir(`$${nc.total.toFixed(2)}`, margenDerecho - 50, y, { size: 10, font: fontBold });

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

function truncar(texto: string, maxLargo: number): string {
  return texto.length > maxLargo ? texto.slice(0, maxLargo - 1) + "…" : texto;
}
