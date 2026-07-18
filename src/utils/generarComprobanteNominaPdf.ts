// PDF genérico para comprobantes internos simples de nómina (décimo
// tercero, décimo cuarto, pago de vacaciones): título + datos del empleado
// + lista de conceptos/valores + total. A diferencia de los RIDE (donde
// cada comprobante SRI tiene su propio archivo autocontenido porque el
// esquema fiscal difiere y puede evolucionar distinto por tipo), estos tres
// documentos son puramente internos y comparten EXACTAMENTE la misma
// forma — compartir un solo generador acá no repite la duplicación
// deliberada de los RIDE, evita 3 archivos casi idénticos sin necesidad.

import { PDFDocument, StandardFonts, rgb, PDFFont } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { leerLogoEmpresa } from "./logoEmpresa";
import { empresaActiva } from "../db";
import { rutaAbsoluta } from "./empresas";

interface DatosEmisorComprobante {
  ruc: string;
  razonSocial: string;
  dirMatriz: string;
}

interface EmpleadoParaComprobante {
  cedula: string;
  nombres: string;
  apellidos: string;
  cargo: string;
}

export async function generarComprobanteNominaPdf(
  titulo: string,
  subtitulo: string,
  empleado: EmpleadoParaComprobante,
  filas: [string, Prisma.Decimal][],
  total: Prisma.Decimal,
  etiquetaTotal: string,
  emisor: DatosEmisorComprobante
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
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

  y -= 30;
  escribir(titulo, margenIzquierdo, y, { size: 13, font: fontBold });
  y -= 15;
  escribir(subtitulo, margenIzquierdo, y, { size: 9, color: grisTexto });

  y -= 25;
  escribir("Empleado:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(`${empleado.nombres} ${empleado.apellidos}`, margenIzquierdo + 140, y, { size: 8 });
  y -= 13;
  escribir("Cédula:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(empleado.cedula, margenIzquierdo + 140, y, { size: 8 });
  y -= 13;
  escribir("Cargo:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(empleado.cargo, margenIzquierdo + 140, y, { size: 8 });

  y -= 25;
  page.drawRectangle({ x: margenIzquierdo, y: y - 4, width: margenDerecho - margenIzquierdo, height: 16, color: grisClaro });
  escribir("CONCEPTO", margenIzquierdo + 2, y, { size: 8, font: fontBold });
  escribir("Valor", margenDerecho - 60, y, { size: 8, font: fontBold });
  y -= 18;

  for (const [etiqueta, valor] of filas) {
    escribir(etiqueta, margenIzquierdo + 2, y, { size: 8 });
    escribir(valor.toFixed(2), margenDerecho - 60, y, { size: 8 });
    y -= 14;
  }

  y -= 10;
  page.drawRectangle({ x: margenIzquierdo, y: y - 4, width: margenDerecho - margenIzquierdo, height: 20, color: grisClaro });
  escribir(`${etiquetaTotal}:`, margenIzquierdo + 2, y + 1, { size: 11, font: fontBold });
  escribir(`$${total.toFixed(2)}`, margenDerecho - 80, y + 1, { size: 11, font: fontBold });

  const pieY = 60;
  page.drawLine({ start: { x: margenIzquierdo, y: pieY }, end: { x: margenDerecho, y: pieY }, thickness: 0.5, color: grisTexto });
  escribir(
    "Este documento es un comprobante interno de nómina — no es un comprobante electrónico SRI.",
    margenIzquierdo,
    pieY - 14,
    { size: 7, color: grisTexto }
  );
  const marcaSistema = "Generado con AmbrossISP PYMES";
  const anchoMarca = fontRegular.widthOfTextAtSize(marcaSistema, 7);
  escribir(marcaSistema, (width - anchoMarca) / 2, pieY - 32, { size: 7, color: grisTexto });

  return pdfDoc.save();
}
