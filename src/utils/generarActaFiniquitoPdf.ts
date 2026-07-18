// Genera el PDF del acta de finiquito (liquidación) de un empleado —
// documento interno de CÁLCULO, no un documento legal listo para firmar.
// A diferencia de los demás PDF de este sistema, este lleva un aviso
// destacado (no solo en el pie de página) de que los montos de
// indemnización/desahucio deben confirmarse con un profesional antes de
// pagarse — ver utils/liquidacion.ts para el porqué.

import { PDFDocument, StandardFonts, rgb, PDFFont } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { leerLogoEmpresa } from "./logoEmpresa";
import { empresaActiva } from "../db";
import { rutaAbsoluta } from "./empresas";

interface LiquidacionParaPdf {
  fechaSalida: Date;
  motivoSalida: string;
  aniosServicio: Prisma.Decimal;
  empleado: { cedula: string; nombres: string; apellidos: string; cargo: string; fechaIngreso: Date };
  vacacionesPendientesDias: number;
  vacacionesPendientesValor: Prisma.Decimal;
  decimoTerceroProporcional: Prisma.Decimal;
  decimoCuartoProporcional: Prisma.Decimal;
  indemnizacion: Prisma.Decimal;
  bonificacionDesahucio: Prisma.Decimal;
  totalLiquidacion: Prisma.Decimal;
}

interface DatosEmisorLiquidacion {
  ruc: string;
  razonSocial: string;
  dirMatriz: string;
}

const MOTIVOS: Record<string, string> = {
  DESPIDO_INTEMPESTIVO: "Despido intempestivo",
  RENUNCIA_VOLUNTARIA: "Renuncia voluntaria",
  MUTUO_ACUERDO: "Mutuo acuerdo",
  VISTO_BUENO: "Visto bueno",
  OTRO: "Otro",
};

export async function generarActaFiniquitoPdf(liq: LiquidacionParaPdf, emisor: DatosEmisorLiquidacion): Promise<Uint8Array> {
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
  const rojoAviso = rgb(0.7, 0.1, 0.1);
  const fondoAviso = rgb(1, 0.93, 0.93);

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

  // --- Logo + empresa ---
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

  // --- Aviso destacado (recuadro rojo, no solo pie de página) ---
  const alturaAviso = 46;
  page.drawRectangle({
    x: margenIzquierdo,
    y: y - alturaAviso,
    width: margenDerecho - margenIzquierdo,
    height: alturaAviso,
    color: fondoAviso,
    borderColor: rojoAviso,
    borderWidth: 1,
  });
  escribir("¡ATENCIÓN! ESTE ES UN CÁLCULO PRELIMINAR — NO ES UN DOCUMENTO LEGAL LISTO PARA PAGAR", margenIzquierdo + 8, y - 16, {
    size: 9,
    font: fontBold,
    color: rojoAviso,
  });
  escribir(
    "Confirma la indemnización y bonificación por desahucio con un contador o abogado laboral antes de",
    margenIzquierdo + 8,
    y - 29,
    { size: 8, color: rojoAviso }
  );
  escribir(
    "pagar esta liquidación — las fórmulas han cambiado con reformas laborales en Ecuador.",
    margenIzquierdo + 8,
    y - 40,
    { size: 8, color: rojoAviso }
  );

  y -= alturaAviso + 25;

  // --- Datos del empleado y de la salida ---
  escribir("ACTA DE FINIQUITO", margenIzquierdo, y, { size: 13, font: fontBold });
  y -= 20;
  escribir("Empleado:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(`${liq.empleado.nombres} ${liq.empleado.apellidos}`, margenIzquierdo + 140, y, { size: 8 });
  y -= 13;
  escribir("Cédula:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(liq.empleado.cedula, margenIzquierdo + 140, y, { size: 8 });
  y -= 13;
  escribir("Cargo:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(liq.empleado.cargo, margenIzquierdo + 140, y, { size: 8 });
  y -= 13;
  escribir("Fecha de ingreso:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(formatearFecha(liq.empleado.fechaIngreso), margenIzquierdo + 140, y, { size: 8 });
  y -= 13;
  escribir("Fecha de salida:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(formatearFecha(liq.fechaSalida), margenIzquierdo + 140, y, { size: 8 });
  y -= 13;
  escribir("Motivo de salida:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(MOTIVOS[liq.motivoSalida] ?? liq.motivoSalida, margenIzquierdo + 140, y, { size: 8 });
  y -= 13;
  escribir("Años de servicio:", margenIzquierdo, y, { size: 8, font: fontBold });
  escribir(liq.aniosServicio.toFixed(2), margenIzquierdo + 140, y, { size: 8 });

  y -= 25;

  // --- Tabla de valores ---
  page.drawRectangle({ x: margenIzquierdo, y: y - 4, width: margenDerecho - margenIzquierdo, height: 16, color: grisClaro });
  escribir("CONCEPTO", margenIzquierdo + 2, y, { size: 8, font: fontBold });
  escribir("Valor", margenDerecho - 60, y, { size: 8, font: fontBold });
  y -= 18;

  const filas: [string, Prisma.Decimal][] = [
    [`Vacaciones pendientes (${liq.vacacionesPendientesDias} días)`, liq.vacacionesPendientesValor],
    ["Décimo tercero proporcional", liq.decimoTerceroProporcional],
    ["Décimo cuarto proporcional", liq.decimoCuartoProporcional],
    ["Indemnización por despido intempestivo", liq.indemnizacion],
    ["Bonificación por desahucio", liq.bonificacionDesahucio],
  ];
  for (const [etiqueta, valor] of filas) {
    if (valor.eq(0)) continue;
    escribir(etiqueta, margenIzquierdo + 2, y, { size: 8 });
    escribir(valor.toFixed(2), margenDerecho - 60, y, { size: 8 });
    y -= 14;
  }

  y -= 10;
  page.drawRectangle({ x: margenIzquierdo, y: y - 4, width: margenDerecho - margenIzquierdo, height: 20, color: grisClaro });
  escribir("TOTAL LIQUIDACIÓN:", margenIzquierdo + 2, y + 1, { size: 11, font: fontBold });
  escribir(`$${liq.totalLiquidacion.toFixed(2)}`, margenDerecho - 90, y + 1, { size: 11, font: fontBold });

  // --- Pie de página ---
  const pieY = 60;
  page.drawLine({ start: { x: margenIzquierdo, y: pieY }, end: { x: margenDerecho, y: pieY }, thickness: 0.5, color: grisTexto });
  escribir(
    "Documento interno de cálculo — verificar con un profesional antes de usarlo para un pago real.",
    margenIzquierdo,
    pieY - 14,
    { size: 7, color: grisTexto, font: fontBold }
  );
  const marcaSistema = "Generado con AmbrossISP PYMES";
  const anchoMarca = fontRegular.widthOfTextAtSize(marcaSistema, 7);
  escribir(marcaSistema, (width - anchoMarca) / 2, pieY - 32, { size: 7, color: grisTexto });

  return pdfDoc.save();
}

function formatearFecha(fecha: Date): string {
  const dd = String(fecha.getDate()).padStart(2, "0");
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const aaaa = fecha.getFullYear().toString();
  return `${dd}/${mm}/${aaaa}`;
}
