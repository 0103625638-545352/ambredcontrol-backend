// Genera el PDF de una PROFORMA: mismo formato visual que el RIDE de
// factura (logo, recuadro de encabezado, tabla, caja de totales), pero SIN
// clave de acceso ni QR (no es un comprobante electrónico) y con un aviso
// bien visible de que es solo una cotización — no reserva stock ni
// reemplaza la factura/nota de venta real que se emite cuando el cliente
// confirma la compra.

import { PDFDocument, StandardFonts, rgb, PDFFont } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { leerLogoEmpresa } from "./logoEmpresa";
import { empresaActiva } from "../db";
import { rutaAbsoluta } from "./empresas";

interface DetalleParaProforma {
  producto: { codigo: string; nombre: string };
  cantidad: number;
  precioUnitario: Prisma.Decimal;
  subtotal: Prisma.Decimal;
}

interface ProformaParaPdf {
  secuencial: string;
  fechaEmision: Date;
  validaHasta: Date | null;
  subtotal0: Prisma.Decimal;
  subtotal12: Prisma.Decimal;
  iva: Prisma.Decimal;
  total: Prisma.Decimal;
  estado: string;
  cliente: { tipoIdentificacion: string; identificacion: string; razonSocial: string };
  detalles: DetalleParaProforma[];
}

interface DatosEmisorPdf {
  ruc: string;
  razonSocial: string;
  dirMatriz: string;
}

export async function generarRideProformaPdf(
  proforma: ProformaParaPdf,
  emisor: DatosEmisorPdf
): Promise<Uint8Array> {
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

  // --- Logo de la empresa (opcional), igual que en el RIDE ---
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

  // --- Recuadro derecho: No. de proforma, estado y validez ---
  const recuadroX = 340;
  const recuadroY = height - 90;
  page.drawRectangle({
    x: recuadroX,
    y: recuadroY,
    width: margenDerecho - recuadroX,
    height: 70,
    borderColor: negro,
    borderWidth: 1,
  });
  escribir("PROFORMA", recuadroX + 10, recuadroY + 52, { size: 12, font: fontBold });
  escribir(`No. ${proforma.secuencial}`, recuadroX + 10, recuadroY + 36, { size: 10 });
  escribir(`Estado: ${proforma.estado}`, recuadroX + 10, recuadroY + 22, { size: 8, color: grisTexto });
  escribir(
    proforma.validaHasta ? `Válida hasta: ${formatearFecha(proforma.validaHasta)}` : "Sin fecha de vigencia",
    recuadroX + 10,
    recuadroY + 10,
    { size: 8, color: grisTexto }
  );

  y = height - 130;

  // --- Datos del cliente ---
  escribir("Razón Social / Nombres:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(proforma.cliente.razonSocial, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Identificación:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(proforma.cliente.identificacion, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Fecha de emisión:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(formatearFecha(proforma.fechaEmision), margenIzquierdo + 130, y, { size: 8 });

  y -= 25;

  // --- Tabla de productos: encabezado ---
  const columnas = {
    codigo: margenIzquierdo,
    descripcion: margenIzquierdo + 70,
    cantidad: margenIzquierdo + 300,
    precio: margenIzquierdo + 360,
    total: margenIzquierdo + 450,
  };

  page.drawRectangle({ x: margenIzquierdo, y: y - 4, width: margenDerecho - margenIzquierdo, height: 16, color: grisClaro });
  escribir("Cód.", columnas.codigo + 2, y, { size: 8, font: fontBold });
  escribir("Descripción", columnas.descripcion, y, { size: 8, font: fontBold });
  escribir("Cant.", columnas.cantidad, y, { size: 8, font: fontBold });
  escribir("P. Unit.", columnas.precio, y, { size: 8, font: fontBold });
  escribir("Total", columnas.total, y, { size: 8, font: fontBold });
  y -= 18;

  // --- Filas de productos ---
  for (const item of proforma.detalles) {
    if (y < 150) {
      page = pdfDoc.addPage([595.28, 841.89]);
      y = height - 50;
    }
    escribir(item.producto.codigo, columnas.codigo + 2, y, { size: 8 });
    escribir(truncar(item.producto.nombre, 34), columnas.descripcion, y, { size: 8 });
    escribir(item.cantidad.toString(), columnas.cantidad, y, { size: 8 });
    escribir(item.precioUnitario.toFixed(2), columnas.precio, y, { size: 8 });
    escribir(item.subtotal.toFixed(2), columnas.total, y, { size: 8 });
    y -= 14;
  }

  y -= 15;
  page.drawLine({ start: { x: margenIzquierdo, y }, end: { x: margenDerecho, y }, thickness: 0.5, color: grisTexto });
  y -= 18;

  // --- Totales: misma caja con bordes que el RIDE de factura ---
  const totalesX = margenDerecho - 180;
  const filaAlto = 15;
  const filasTotales = [
    { etiqueta: "Subtotal 0%:", valor: proforma.subtotal0.toFixed(2) },
    { etiqueta: "Subtotal con IVA:", valor: proforma.subtotal12.toFixed(2) },
    { etiqueta: "IVA:", valor: proforma.iva.toFixed(2) },
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
  escribir(`$${proforma.total.toFixed(2)}`, margenDerecho - 50, y, { size: 10, font: fontBold });

  // --- Pie de página: aviso — esto es lo que distingue a la proforma de un RIDE real ---
  const pieY = 60;
  page.drawLine({ start: { x: margenIzquierdo, y: pieY }, end: { x: margenDerecho, y: pieY }, thickness: 0.5, color: grisTexto });
  escribir(
    "Este documento es una COTIZACIÓN y no constituye un comprobante electrónico autorizado por el SRI.",
    margenIzquierdo,
    pieY - 14,
    { size: 7, color: grisTexto, font: fontBold }
  );
  escribir(
    "No reserva stock ni es válido para sustentar crédito tributario. Precios sujetos a cambio sin previo aviso.",
    margenIzquierdo,
    pieY - 24,
    { size: 7, color: grisTexto, font: fontBold }
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
