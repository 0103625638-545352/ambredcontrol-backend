// Genera el PDF de una NOTA DE VENTA: un recibo simple, interno, para clientes
// que no necesitan una factura formal. A diferencia del RIDE de factura/nota
// de crédito, este documento NO tiene clave de acceso ni ambiente SRI —
// porque la nota de venta nunca se envía al SRI. Por eso el pie de página deja
// bien claro que este NO es un comprobante electrónico autorizado.

import { PDFDocument, StandardFonts, rgb, PDFFont } from "pdf-lib";
import { Prisma } from "@prisma/client";

interface DetalleParaRecibo {
  producto: { codigo: string; nombre: string };
  cantidad: number;
  precioUnitario: Prisma.Decimal;
  descuento: Prisma.Decimal;
  subtotal: Prisma.Decimal;
}

interface NotaVentaParaRecibo {
  secuencial: string;
  fechaEmision: Date;
  aplicaIva: boolean;
  subtotal0: Prisma.Decimal;
  subtotal12: Prisma.Decimal;
  iva: Prisma.Decimal;
  total: Prisma.Decimal;
  estado: string;
  cliente: { tipoIdentificacion: string; identificacion: string; razonSocial: string };
  detalles: DetalleParaRecibo[];
}

interface DatosEmisorRecibo {
  ruc: string;
  razonSocial: string;
  dirMatriz: string;
}

export async function generarReciboNotaVentaPdf(
  notaVenta: NotaVentaParaRecibo,
  emisor: DatosEmisorRecibo
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

  // --- Encabezado: datos del emisor ---
  escribir(emisor.razonSocial, margenIzquierdo, y, { size: 14, font: fontBold });
  y -= 16;
  escribir(`RUC: ${emisor.ruc}`, margenIzquierdo, y, { size: 9, color: grisTexto });
  y -= 12;
  escribir(emisor.dirMatriz, margenIzquierdo, y, { size: 9, color: grisTexto });

  // --- Recuadro derecho: No. de nota de venta y estado ---
  const recuadroX = 350;
  const recuadroY = height - 80;
  page.drawRectangle({
    x: recuadroX,
    y: recuadroY,
    width: margenDerecho - recuadroX,
    height: 60,
    borderColor: negro,
    borderWidth: 1,
  });
  escribir("NOTA DE VENTA", recuadroX + 10, recuadroY + 42, { size: 12, font: fontBold });
  escribir(`No. ${notaVenta.secuencial}`, recuadroX + 10, recuadroY + 26, { size: 10 });
  escribir(`Estado: ${notaVenta.estado}`, recuadroX + 10, recuadroY + 12, { size: 8, color: grisTexto });

  y = height - 115;

  // --- Datos del cliente ---
  escribir("Razón Social / Nombres:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(notaVenta.cliente.razonSocial, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Identificación:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(notaVenta.cliente.identificacion, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Fecha de emisión:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(formatearFecha(notaVenta.fechaEmision), margenIzquierdo + 130, y, { size: 8 });

  y -= 25;

  // --- Tabla de productos: encabezado ---
  const columnas = {
    codigo: margenIzquierdo,
    descripcion: margenIzquierdo + 60,
    cantidad: margenIzquierdo + 280,
    precio: margenIzquierdo + 330,
    descuento: margenIzquierdo + 390,
    total: margenIzquierdo + 450,
  };

  page.drawRectangle({ x: margenIzquierdo, y: y - 4, width: margenDerecho - margenIzquierdo, height: 16, color: grisClaro });
  escribir("Cód.", columnas.codigo + 2, y, { size: 8, font: fontBold });
  escribir("Descripción", columnas.descripcion, y, { size: 8, font: fontBold });
  escribir("Cant.", columnas.cantidad, y, { size: 8, font: fontBold });
  escribir("P. Unit.", columnas.precio, y, { size: 8, font: fontBold });
  escribir("Desc.", columnas.descuento, y, { size: 8, font: fontBold });
  escribir("Total", columnas.total, y, { size: 8, font: fontBold });
  y -= 18;

  // --- Filas de productos ---
  for (const item of notaVenta.detalles) {
    if (y < 150) {
      page = pdfDoc.addPage([595.28, 841.89]);
      y = height - 50;
    }
    escribir(item.producto.codigo, columnas.codigo + 2, y, { size: 8 });
    escribir(truncar(item.producto.nombre, 38), columnas.descripcion, y, { size: 8 });
    escribir(item.cantidad.toString(), columnas.cantidad, y, { size: 8 });
    escribir(item.precioUnitario.toFixed(2), columnas.precio, y, { size: 8 });
    escribir(item.descuento.toFixed(2), columnas.descuento, y, { size: 8 });
    escribir(item.subtotal.toFixed(2), columnas.total, y, { size: 8 });
    y -= 14;
  }

  y -= 15;
  page.drawLine({ start: { x: margenIzquierdo, y }, end: { x: margenDerecho, y }, thickness: 0.5, color: grisTexto });
  y -= 18;

  // --- Totales ---
  // Si esta nota de venta no aplica IVA, no tiene sentido mostrar el desglose
  // "Subtotal 0% / Subtotal con IVA / IVA" (sería confuso: ¿0% porque no
  // aplica, o porque los productos son exentos?) — mostramos solo "Subtotal"
  // y dejamos explícito "IVA: No aplica".
  const totalesX = margenDerecho - 180;
  if (notaVenta.aplicaIva) {
    escribir("Subtotal 0%:", totalesX, y, { size: 9 });
    escribir(notaVenta.subtotal0.toFixed(2), margenDerecho - 40, y, { size: 9 });
    y -= 14;
    escribir("Subtotal con IVA:", totalesX, y, { size: 9 });
    escribir(notaVenta.subtotal12.toFixed(2), margenDerecho - 40, y, { size: 9 });
    y -= 14;
    escribir("IVA:", totalesX, y, { size: 9 });
    escribir(notaVenta.iva.toFixed(2), margenDerecho - 40, y, { size: 9 });
    y -= 16;
  } else {
    escribir("Subtotal:", totalesX, y, { size: 9 });
    escribir(notaVenta.subtotal0.toFixed(2), margenDerecho - 40, y, { size: 9 });
    y -= 14;
    escribir("IVA:", totalesX, y, { size: 9, color: grisTexto });
    escribir("No aplica", margenDerecho - 60, y, { size: 9, color: grisTexto });
    y -= 16;
  }
  page.drawRectangle({ x: totalesX - 5, y: y - 4, width: margenDerecho - totalesX + 5, height: 16, color: grisClaro });
  escribir("TOTAL:", totalesX, y, { size: 10, font: fontBold });
  escribir(`$${notaVenta.total.toFixed(2)}`, margenDerecho - 50, y, { size: 10, font: fontBold });

  // --- Pie de página: aviso legal, MUY distinto del de factura/nota de crédito ---
  const pieY = 60;
  page.drawLine({ start: { x: margenIzquierdo, y: pieY }, end: { x: margenDerecho, y: pieY }, thickness: 0.5, color: grisTexto });
  escribir(
    "Este documento es un comprobante de venta INTERNO y NO constituye un comprobante electrónico",
    margenIzquierdo,
    pieY - 14,
    { size: 7, color: grisTexto, font: fontBold }
  );
  escribir(
    "autorizado por el SRI. No es válido para sustentar crédito tributario.",
    margenIzquierdo,
    pieY - 24,
    { size: 7, color: grisTexto, font: fontBold }
  );

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
