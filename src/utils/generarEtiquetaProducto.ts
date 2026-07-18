// Genera una hoja de etiquetas (código de barras + nombre del producto) para
// imprimir y pegar en el producto físico o el estante. El "codigo" del
// producto no siempre es un EAN/UPC válido (puede ser alfanumérico, ej.
// "PROD001"), así que usamos Code128: acepta letras, números y guiones.
//
// Se genera UNA sola imagen de barras (siempre es la misma para todas las
// copias) y se dibuja repetida en una cuadrícula, con un recuadro punteado
// como guía de corte cuando el preset lo pide — no hay integración con un
// modelo comercial de hoja de stickers en particular, es una cuadrícula
// genérica para recortar a mano o con guillotina (en los presets de rollo,
// cada "página" ES una etiqueta, así que no hace falta guía de corte: el
// propio rollo ya viene perforado/cortado entre etiquetas).
import { PDFDocument, PDFFont, StandardFonts, rgb } from "pdf-lib";
import bwipjs from "bwip-js";

const MM_A_PUNTOS = 2.8346; // 1mm en puntos PDF (72 puntos por pulgada / 25.4mm)
function mm(valorMm: number): number {
  return valorMm * MM_A_PUNTOS;
}

interface PresetEtiqueta {
  paginaAncho: number; // puntos PDF
  paginaAlto: number;
  columnas: number;
  filas: number;
  margen: number;
  guiaCorte: boolean;
}

const PRESETS = {
  // Valores actuales exactos (hoja A4, cuadrícula 4x9) — default, sin cambio de comportamiento.
  A4_4X9: { paginaAncho: 595.28, paginaAlto: 841.89, columnas: 4, filas: 9, margen: 20, guiaCorte: true },
  // Rollo de etiqueta térmica: cada "página" del PDF es una sola etiqueta.
  ROLLO_50X25: { paginaAncho: mm(50), paginaAlto: mm(25), columnas: 1, filas: 1, margen: mm(2), guiaCorte: false },
  ROLLO_40X30: { paginaAncho: mm(40), paginaAlto: mm(30), columnas: 1, filas: 1, margen: mm(2), guiaCorte: false },
} satisfies Record<string, PresetEtiqueta>;

export type TamanoEtiqueta = keyof typeof PRESETS;

export interface DatosEtiquetaProducto {
  codigo: string;
  nombre: string;
}

function envolverTexto(texto: string, font: PDFFont, tamano: number, anchoMaximo: number, maxLineas: number): string[] {
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

  if (lineas.length > maxLineas) {
    const recortadas = lineas.slice(0, maxLineas);
    let ultima = recortadas[maxLineas - 1];
    while (font.widthOfTextAtSize(`${ultima}…`, tamano) > anchoMaximo && ultima.length > 1) {
      ultima = ultima.slice(0, -1);
    }
    recortadas[maxLineas - 1] = `${ultima}…`;
    return recortadas;
  }
  return lineas;
}

export async function generarEtiquetasProductoPdf(
  producto: DatosEtiquetaProducto,
  cantidad: number,
  tamano: TamanoEtiqueta = "A4_4X9"
): Promise<Uint8Array> {
  const preset = PRESETS[tamano] ?? PRESETS.A4_4X9;
  const { paginaAncho, paginaAlto, columnas, filas, margen, guiaCorte } = preset;
  const celdaAncho = (paginaAncho - margen * 2) / columnas;
  const celdaAlto = (paginaAlto - margen * 2) / filas;
  const etiquetasPorPagina = columnas * filas;

  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const barcodeBuffer = await bwipjs.toBuffer({
    bcid: "code128",
    text: producto.codigo,
    scale: 3,
    height: 10,
    includetext: true,
    textxalign: "center",
  });
  const barcodeImagen = await pdfDoc.embedPng(barcodeBuffer);
  const barcodeRelacionAspecto = barcodeImagen.height / barcodeImagen.width;

  const barcodeAncho = celdaAncho - 16;
  const barcodeAlto = barcodeAncho * barcodeRelacionAspecto;

  const nombreLineas = envolverTexto(producto.nombre, fontRegular, 7, celdaAncho - 12, 2);

  let etiquetasRestantes = cantidad;
  while (etiquetasRestantes > 0) {
    const page = pdfDoc.addPage([paginaAncho, paginaAlto]);
    const enEstaPagina = Math.min(etiquetasRestantes, etiquetasPorPagina);

    for (let i = 0; i < enEstaPagina; i++) {
      const col = i % columnas;
      const fila = Math.floor(i / columnas);
      const x = margen + col * celdaAncho;
      const yTope = paginaAlto - margen - fila * celdaAlto;

      // Guía de corte: recuadro fino gris claro, solo si el preset la pide
      // (en los presets de rollo cada página ya es una sola etiqueta).
      if (guiaCorte) {
        page.drawRectangle({
          x: x + 3,
          y: yTope - celdaAlto + 3,
          width: celdaAncho - 6,
          height: celdaAlto - 6,
          borderColor: rgb(0.75, 0.75, 0.75),
          borderWidth: 0.5,
        });
      }

      let yTexto = yTope - 12;
      for (const linea of nombreLineas) {
        const anchoLinea = fontRegular.widthOfTextAtSize(linea, 7);
        page.drawText(linea, {
          x: x + (celdaAncho - anchoLinea) / 2,
          y: yTexto,
          size: 7,
          font: fontRegular,
        });
        yTexto -= 9;
      }

      page.drawImage(barcodeImagen, {
        x: x + (celdaAncho - barcodeAncho) / 2,
        y: yTope - celdaAlto + (celdaAlto - barcodeAlto - (nombreLineas.length * 9 + 5)) / 2,
        width: barcodeAncho,
        height: barcodeAlto,
      });
    }

    etiquetasRestantes -= enEstaPagina;
  }

  return pdfDoc.save();
}
