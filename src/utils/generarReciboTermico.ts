// Genera un recibo en formato de rollo térmico de 80mm, para el punto de
// venta físico (impresoras térmicas de recibo, tipo las de cualquier caja
// registradora). Es la contraparte compacta del RIDE en A4 — mismo dato,
// mucho menos espacio.
//
// No hablamos con la impresora directamente (no hay integración ESC/POS ni
// drivers): generamos un PDF con el ANCHO EXACTO de un rollo de 80mm y el
// ALTO ajustado al contenido (calculado de antemano, según cuántas líneas
// va a necesitar). El navegador lo abre como cualquier PDF, y al imprimirlo
// con "Tamaño real" el driver de la impresora térmica ya instalada en el
// sistema operativo lo recibe con las medidas correctas. Es el mismo truco
// que usan muchos sistemas de punto de venta basados en navegador.

import { PDFDocument, StandardFonts, PDFFont, PDFPage } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { generarQrClaveAcceso } from "./generarQrClaveAcceso";

const MM_A_PUNTOS = 2.8346;
const ANCHO_PAGINA = 80 * MM_A_PUNTOS; // ~226.77pt
const MARGEN = 8;
const ANCHO_CONTENIDO = ANCHO_PAGINA - MARGEN * 2;
const ALTO_LINEA = 10;
const QR_TAMANO = 70; // pt (~25mm) — suficiente para escanear en un rollo de 80mm
const LINEAS_RESERVADAS_QR = Math.ceil(QR_TAMANO / ALTO_LINEA);

interface DetalleTermico {
  nombre: string;
  cantidad: number;
  precioUnitario: Prisma.Decimal;
  subtotal: Prisma.Decimal;
}

export interface ReciboTermicoDatos {
  tipoDocumento: string; // "FACTURA" o "NOTA DE VENTA"
  secuencial: string;
  claveAcceso?: string | null; // la nota de venta no tiene — nunca pasa por el SRI
  fechaEmision: Date;
  estado: string;
  cliente: { identificacion: string; razonSocial: string };
  detalles: DetalleTermico[];
  subtotal0: Prisma.Decimal;
  subtotal12: Prisma.Decimal;
  iva: Prisma.Decimal;
  total: Prisma.Decimal;
  notaPie: string; // aviso legal al pie — distinto entre factura y nota de venta
}

export interface DatosEmisorTermico {
  ruc: string;
  razonSocial: string;
  dirMatriz: string;
}

// Una "línea" es la unidad mínima de este recibo: todo el contenido se arma
// primero como una lista de líneas (con su propio tamaño/negrita/centrado),
// así podemos calcular el alto total de la página ANTES de crearla —
// pdf-lib no permite crear una página y cambiarle el tamaño después.
interface Linea {
  texto: string;
  tamano: number;
  negrita?: boolean;
  centrado?: boolean;
}

function envolverTexto(texto: string, font: PDFFont, tamano: number, anchoMaximo: number): string[] {
  const palabras = texto.split(" ");
  const lineas: string[] = [];
  let actual = "";

  for (const palabra of palabras) {
    const prueba = actual ? `${actual} ${palabra}` : palabra;
    if (font.widthOfTextAtSize(prueba, tamano) > anchoMaximo && actual) {
      lineas.push(actual);
      actual = palabra;
    } else {
      actual = prueba;
    }
  }
  if (actual) lineas.push(actual);
  return lineas;
}

// La clave de acceso son 49 dígitos seguidos — ilegible en una sola línea a
// 80mm. La partimos en bloques fijos, más fácil de leer y de copiar a mano.
function partirEnBloques(texto: string, tamanoBloque: number): string[] {
  const bloques: string[] = [];
  for (let i = 0; i < texto.length; i += tamanoBloque) {
    bloques.push(texto.slice(i, i + tamanoBloque));
  }
  return bloques;
}

export async function generarReciboTermicoPdf(
  datos: ReciboTermicoDatos,
  emisor: DatosEmisorTermico
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const lineas: Linea[] = [];
  const agregar = (texto: string, opciones: { tamano?: number; negrita?: boolean; centrado?: boolean } = {}) => {
    lineas.push({ texto, tamano: opciones.tamano ?? 7, negrita: opciones.negrita, centrado: opciones.centrado });
  };
  const agregarVarias = (textos: string[], opciones: { tamano?: number; negrita?: boolean; centrado?: boolean } = {}) => {
    for (const t of textos) agregar(t, opciones);
  };
  const separador = () => agregar("-".repeat(38), { tamano: 7 });

  // --- Encabezado ---
  agregarVarias(envolverTexto(emisor.razonSocial, fontBold, 9, ANCHO_CONTENIDO), { tamano: 9, negrita: true, centrado: true });
  agregar(`RUC: ${emisor.ruc}`, { centrado: true });
  agregarVarias(envolverTexto(emisor.dirMatriz, fontRegular, 7, ANCHO_CONTENIDO), { centrado: true });
  separador();

  // --- Datos del documento ---
  agregar(datos.tipoDocumento, { tamano: 8, negrita: true, centrado: true });
  agregar(`No. ${datos.secuencial}`, { centrado: true });
  agregar(`Estado: ${datos.estado}`, { centrado: true });
  agregar(formatearFecha(datos.fechaEmision));
  separador();

  // --- Cliente ---
  agregarVarias(envolverTexto(datos.cliente.razonSocial, fontRegular, 7, ANCHO_CONTENIDO));
  agregar(`ID: ${datos.cliente.identificacion}`);
  separador();

  // --- Detalle de productos ---
  for (const item of datos.detalles) {
    agregarVarias(envolverTexto(item.nombre, fontRegular, 7, ANCHO_CONTENIDO));
    agregar(`  ${item.cantidad} x ${item.precioUnitario.toFixed(2)}${" ".repeat(6)}${item.subtotal.toFixed(2)}`);
  }
  separador();

  // --- Totales ---
  if (datos.subtotal0.gt(0)) agregar(`Subtotal 0%:${" ".repeat(10)}${datos.subtotal0.toFixed(2)}`);
  if (datos.subtotal12.gt(0)) agregar(`Subtotal con IVA:${" ".repeat(6)}${datos.subtotal12.toFixed(2)}`);
  agregar(`IVA:${" ".repeat(18)}${datos.iva.toFixed(2)}`);
  agregar(`TOTAL: $${datos.total.toFixed(2)}`, { tamano: 9, negrita: true });
  separador();

  // --- Clave de acceso + QR (solo si aplica: factura/nota de crédito, no nota de venta) ---
  // El QR no es texto — no puede ir en la lista de "líneas". Reservamos su
  // espacio como líneas en blanco (para que el cálculo de alto de página lo
  // cuente) y anotamos en qué línea empieza, para dibujarlo ahí después de
  // crear la página con el alto ya definitivo.
  let indiceLineaQr: number | null = null;
  if (datos.claveAcceso) {
    agregar("Escanea para verificar:", { tamano: 6, centrado: true });
    indiceLineaQr = lineas.length;
    for (let i = 0; i < LINEAS_RESERVADAS_QR; i++) agregar("", { tamano: 7 });
    agregarVarias(partirEnBloques(datos.claveAcceso, 12), { tamano: 6, centrado: true });
    separador();
  }

  // --- Aviso legal ---
  agregarVarias(envolverTexto(datos.notaPie, fontRegular, 6, ANCHO_CONTENIDO), { tamano: 6, centrado: true });

  // --- Ahora sí: con el número de líneas ya conocido, calculamos el alto
  // exacto de la página y la creamos ---
  const altoContenido = lineas.length * ALTO_LINEA;
  const altoPagina = altoContenido + MARGEN * 2;
  const page: PDFPage = pdfDoc.addPage([ANCHO_PAGINA, altoPagina]);

  let y = altoPagina - MARGEN;
  for (const linea of lineas) {
    const font = linea.negrita ? fontBold : fontRegular;
    const x = linea.centrado
      ? (ANCHO_PAGINA - font.widthOfTextAtSize(linea.texto, linea.tamano)) / 2
      : MARGEN;
    page.drawText(linea.texto, { x, y: y - linea.tamano, size: linea.tamano, font });
    y -= ALTO_LINEA;
  }

  if (indiceLineaQr !== null && datos.claveAcceso) {
    const qrBuffer = await generarQrClaveAcceso(datos.claveAcceso);
    const qrImagen = await pdfDoc.embedPng(qrBuffer);
    const topeQr = altoPagina - MARGEN - indiceLineaQr * ALTO_LINEA;
    page.drawImage(qrImagen, {
      x: (ANCHO_PAGINA - QR_TAMANO) / 2,
      y: topeQr - LINEAS_RESERVADAS_QR * ALTO_LINEA,
      width: QR_TAMANO,
      height: QR_TAMANO,
    });
  }

  return pdfDoc.save();
}

function formatearFecha(fecha: Date): string {
  const dd = String(fecha.getDate()).padStart(2, "0");
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const aaaa = fecha.getFullYear().toString();
  return `${dd}/${mm}/${aaaa}`;
}
