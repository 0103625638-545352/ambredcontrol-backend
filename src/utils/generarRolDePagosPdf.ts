// Genera el PDF del rol de pagos (comprobante de pago de sueldo) de un
// empleado por un período — documento interno, no un comprobante SRI.
// Mismo patrón pdf-lib que generarReciboCompra.ts.

import { PDFDocument, StandardFonts, rgb, PDFFont } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { leerLogoEmpresa } from "./logoEmpresa";
import { empresaActiva } from "../db";
import { rutaAbsoluta } from "./empresas";

interface RolDePagosParaPdf {
  anio: number;
  mes: number;
  estado: string;
  fechaPago: Date | null;
  empleado: { cedula: string; nombres: string; apellidos: string; cargo: string };
  sueldoBase: Prisma.Decimal;
  horasSuplementarias: number;
  valorHorasSuplementarias: Prisma.Decimal;
  horasExtraordinarias: number;
  valorHorasExtraordinarias: Prisma.Decimal;
  otrosIngresos: Prisma.Decimal;
  fondoReservaValor: Prisma.Decimal;
  totalIngresos: Prisma.Decimal;
  aportePersonalIess: Prisma.Decimal;
  otrosDescuentos: Prisma.Decimal;
  otrosDescuentosDetalle: string | null;
  totalDescuentos: Prisma.Decimal;
  netoAPagar: Prisma.Decimal;
}

interface DatosEmisorRolDePagos {
  ruc: string;
  razonSocial: string;
  dirMatriz: string;
}

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export async function generarRolDePagosPdf(rol: RolDePagosParaPdf, emisor: DatosEmisorRolDePagos): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4 en puntos
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

  // --- Encabezado: empresa ---
  escribir(emisor.razonSocial, xTextoEmisor, y, { size: 14, font: fontBold });
  y -= 16;
  escribir(`RUC: ${emisor.ruc}`, xTextoEmisor, y, { size: 9, color: grisTexto });
  y -= 12;
  escribir(emisor.dirMatriz, xTextoEmisor, y, { size: 9, color: grisTexto });

  // --- Recuadro derecho: período y estado ---
  const recuadroX = 340;
  const recuadroY = height - 80;
  page.drawRectangle({
    x: recuadroX,
    y: recuadroY,
    width: margenDerecho - recuadroX,
    height: 60,
    borderColor: negro,
    borderWidth: 1,
  });
  escribir("ROL DE PAGOS", recuadroX + 10, recuadroY + 42, { size: 11, font: fontBold });
  escribir(`Período: ${MESES[rol.mes - 1]} ${rol.anio}`, recuadroX + 10, recuadroY + 26, { size: 9 });
  escribir(`Estado: ${rol.estado}`, recuadroX + 10, recuadroY + 12, { size: 8, color: grisTexto });

  y = height - 115;

  // --- Datos del empleado ---
  escribir("Empleado:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(`${rol.empleado.nombres} ${rol.empleado.apellidos}`, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Cédula:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(rol.empleado.cedula, margenIzquierdo + 130, y, { size: 8 });
  y -= 13;
  escribir("Cargo:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(rol.empleado.cargo, margenIzquierdo + 130, y, { size: 8 });

  y -= 25;

  // --- Tabla de ingresos ---
  page.drawRectangle({ x: margenIzquierdo, y: y - 4, width: margenDerecho - margenIzquierdo, height: 16, color: grisClaro });
  escribir("INGRESOS", margenIzquierdo + 2, y, { size: 8, font: fontBold });
  escribir("Valor", margenDerecho - 60, y, { size: 8, font: fontBold });
  y -= 18;

  const filasIngresos: [string, Prisma.Decimal][] = [
    ["Sueldo base", rol.sueldoBase],
    [`Horas suplementarias (${rol.horasSuplementarias})`, rol.valorHorasSuplementarias],
    [`Horas extraordinarias (${rol.horasExtraordinarias})`, rol.valorHorasExtraordinarias],
    ["Otros ingresos", rol.otrosIngresos],
    ["Fondo de reserva mensualizado", rol.fondoReservaValor],
  ];
  for (const [etiqueta, valor] of filasIngresos) {
    if (valor.eq(0) && etiqueta !== "Sueldo base") continue;
    escribir(etiqueta, margenIzquierdo + 2, y, { size: 8 });
    escribir(valor.toFixed(2), margenDerecho - 60, y, { size: 8 });
    y -= 14;
  }
  escribir("Total ingresos", margenIzquierdo + 2, y, { size: 8, font: fontBold });
  escribir(rol.totalIngresos.toFixed(2), margenDerecho - 60, y, { size: 8, font: fontBold });

  y -= 25;

  // --- Tabla de descuentos ---
  page.drawRectangle({ x: margenIzquierdo, y: y - 4, width: margenDerecho - margenIzquierdo, height: 16, color: grisClaro });
  escribir("DESCUENTOS", margenIzquierdo + 2, y, { size: 8, font: fontBold });
  escribir("Valor", margenDerecho - 60, y, { size: 8, font: fontBold });
  y -= 18;

  escribir("Aporte personal IESS", margenIzquierdo + 2, y, { size: 8 });
  escribir(rol.aportePersonalIess.toFixed(2), margenDerecho - 60, y, { size: 8 });
  y -= 14;
  if (rol.otrosDescuentos.gt(0)) {
    escribir(rol.otrosDescuentosDetalle || "Otros descuentos", margenIzquierdo + 2, y, { size: 8 });
    escribir(rol.otrosDescuentos.toFixed(2), margenDerecho - 60, y, { size: 8 });
    y -= 14;
  }
  escribir("Total descuentos", margenIzquierdo + 2, y, { size: 8, font: fontBold });
  escribir(rol.totalDescuentos.toFixed(2), margenDerecho - 60, y, { size: 8, font: fontBold });

  y -= 25;
  page.drawLine({ start: { x: margenIzquierdo, y }, end: { x: margenDerecho, y }, thickness: 0.5, color: grisTexto });
  y -= 20;

  // --- Neto a pagar ---
  page.drawRectangle({ x: margenIzquierdo, y: y - 4, width: margenDerecho - margenIzquierdo, height: 20, color: grisClaro });
  escribir("NETO A PAGAR:", margenIzquierdo + 2, y + 1, { size: 11, font: fontBold });
  escribir(`$${rol.netoAPagar.toFixed(2)}`, margenDerecho - 80, y + 1, { size: 11, font: fontBold });

  // --- Pie de página ---
  const pieY = 60;
  page.drawLine({ start: { x: margenIzquierdo, y: pieY }, end: { x: margenDerecho, y: pieY }, thickness: 0.5, color: grisTexto });
  escribir(
    "Este documento es un comprobante interno de pago de sueldo — no es un comprobante electrónico SRI.",
    margenIzquierdo,
    pieY - 14,
    { size: 7, color: grisTexto }
  );
  const marcaSistema = "Generado con AmbrossISP PYMES";
  const anchoMarca = fontRegular.widthOfTextAtSize(marcaSistema, 7);
  escribir(marcaSistema, (width - anchoMarca) / 2, pieY - 32, { size: 7, color: grisTexto });

  return pdfDoc.save();
}
