// Contrato de prestación del servicio de internet firmado en el celular del
// técnico (ver routes/contratos.ts). El texto sale de una PLANTILLA editable
// por empresa desde Ajustes (EmpresaConfig.textoContratoInternet); si la
// empresa no cargó la suya, se usa TEXTO_CONTRATO_POR_DEFECTO. Las marcas
// {{asi}} se reemplazan con los datos del cliente y del plan.
//
// La plantilla por defecto es un punto de partida general: cada ISP debe
// hacerla revisar por su abogado y ajustarla al modelo de contrato de
// adhesión que exige ARCOTEL.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export const TEXTO_CONTRATO_POR_DEFECTO = `PRIMERA – PARTES. Comparecen, por una parte, {{empresa}}, con RUC {{rucEmpresa}}, en adelante "el PROVEEDOR"; y por otra, {{cliente}}, con cédula/RUC {{cedula}}, domiciliado en {{direccion}}, en adelante "el ABONADO".

SEGUNDA – OBJETO. El PROVEEDOR prestará al ABONADO el servicio de acceso a internet en el domicilio indicado, según el plan contratado: {{plan}} (velocidad de bajada {{bajada}} y de subida {{subida}}).

TERCERA – PRECIO Y FORMA DE PAGO. El ABONADO pagará mensualmente USD {{precio}} más los impuestos de ley, por adelantado. El día de corte es el {{diaCorte}} de cada mes. Si no paga hasta esa fecha, el PROVEEDOR podrá suspender el servicio hasta que se regularice el pago, sin perjuicio del cobro de los valores adeudados.

CUARTA – PLAZO. El contrato rige desde el {{fechaInicio}}. {{textoVigencia}}

QUINTA – EQUIPOS EN COMODATO. Los equipos detallados en este documento se entregan en comodato (préstamo) y son propiedad del PROVEEDOR. El ABONADO se obliga a cuidarlos y a devolverlos en buen estado al terminar el contrato; si no los devuelve o están dañados por mal uso, pagará su valor de reposición.

SEXTA – TERMINACIÓN. El ABONADO puede terminar el contrato en cualquier momento avisando con la debida anticipación. Si lo termina antes del plazo mínimo pactado, pagará los valores pendientes y los equipos no devueltos.

SÉPTIMA – CALIDAD Y RECLAMOS. El PROVEEDOR atenderá los reclamos por los canales de atención publicados. El ABONADO puede presentar reclamos ante la Agencia de Regulación y Control de las Telecomunicaciones (ARCOTEL).

OCTAVA – DATOS PERSONALES. El ABONADO autoriza al PROVEEDOR a tratar sus datos personales únicamente para prestar el servicio, facturar y atender reclamos, conforme a la Ley Orgánica de Protección de Datos Personales.

El ABONADO declara haber leído este contrato y lo acepta firmando a continuación.`;

export interface DatosContrato {
  empresa: string;
  rucEmpresa: string;
  direccionEmpresa: string;
  cliente: string;
  cedula: string;
  direccion: string;
  telefono: string;
  plan: string;
  bajada: string;
  subida: string;
  precio: string; // "25.00"
  diaCorte: string;
  fechaInicio: string; // "1 de octubre de 2026"
  vigenciaMeses: number | null;
  ciudad: string;
}

export function textoVigencia(vigenciaMeses: number | null): string {
  return vigenciaMeses
    ? `El plazo mínimo de permanencia es de ${vigenciaMeses} meses; cumplido ese plazo, se renueva mes a mes.`
    : "No tiene plazo mínimo de permanencia; se renueva mes a mes.";
}

// Reemplaza las marcas {{nombre}} por los datos. Una marca desconocida se
// deja tal cual, para que se note en el PDF si la plantilla tiene un error.
export function rellenarPlantilla(plantilla: string, datos: DatosContrato): string {
  const valores: Record<string, string> = {
    ...Object.fromEntries(Object.entries(datos).map(([k, v]) => [k, v == null ? "" : String(v)])),
    textoVigencia: textoVigencia(datos.vigenciaMeses),
    vigencia: datos.vigenciaMeses ? `${datos.vigenciaMeses} meses` : "sin plazo mínimo",
  };
  return plantilla.replace(/\{\{\s*(\w+)\s*\}\}/g, (marca, clave) => (clave in valores ? valores[clave] : marca));
}

// Los PDF con fuentes estándar solo admiten caracteres WinAnsi: se reemplaza
// lo que no entra (comillas tipográficas, guiones largos, emojis) para que
// la generación nunca falle por un carácter raro pegado en la plantilla.
export function limpiarParaPdf(texto: string): string {
  return texto
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x0A\x20-\x7E\xA0-\xFF]/g, "");
}

export interface EquipoEntregado {
  tipo: string;
  modelo: string | null;
  serial: string | null;
}

export async function generarContratoPdf(params: {
  datos: DatosContrato;
  plantilla: string;
  equipos: EquipoEntregado[];
  firmaPng: Uint8Array;
  nombreFirmante: string;
  cedulaFirmante: string;
  tecnico: string | null;
  fechaFirma: Date;
  ubicacion: { latitud: number; longitud: number } | null;
  logo: { bytes: Buffer; extension: string } | null;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ANCHO = 595.28;
  const ALTO = 841.89;
  const MARGEN = 50;
  const anchoUtil = ANCHO - MARGEN * 2;
  const gris = rgb(0.35, 0.35, 0.35);

  let pagina: PDFPage = pdf.addPage([ANCHO, ALTO]);
  let y = ALTO - MARGEN;

  function nuevaPaginaSiHaceFalta(alto: number) {
    if (y - alto < MARGEN + 20) {
      pagina = pdf.addPage([ANCHO, ALTO]);
      y = ALTO - MARGEN;
    }
  }

  function lineas(texto: string, fuente: PDFFont, tamano: number, ancho: number): string[] {
    const resultado: string[] = [];
    for (const parrafo of limpiarParaPdf(texto).split("\n")) {
      if (!parrafo.trim()) {
        resultado.push("");
        continue;
      }
      let linea = "";
      for (const palabra of parrafo.split(/\s+/)) {
        const prueba = linea ? `${linea} ${palabra}` : palabra;
        if (fuente.widthOfTextAtSize(prueba, tamano) > ancho && linea) {
          resultado.push(linea);
          linea = palabra;
        } else {
          linea = prueba;
        }
      }
      resultado.push(linea);
    }
    return resultado;
  }

  function texto(t: string, opciones: { fuente?: PDFFont; tamano?: number; color?: ReturnType<typeof rgb>; x?: number; ancho?: number; interlineado?: number } = {}) {
    const fuente = opciones.fuente ?? normal;
    const tamano = opciones.tamano ?? 10;
    const interlineado = opciones.interlineado ?? tamano * 1.45;
    for (const l of lineas(t, fuente, tamano, opciones.ancho ?? anchoUtil)) {
      nuevaPaginaSiHaceFalta(interlineado);
      if (l) pagina.drawText(l, { x: opciones.x ?? MARGEN, y, size: tamano, font: fuente, color: opciones.color ?? rgb(0, 0, 0) });
      y -= interlineado;
    }
  }

  // --- Encabezado ---
  let xEmisor = MARGEN;
  if (params.logo) {
    try {
      const imagen = params.logo.extension === "png" ? await pdf.embedPng(params.logo.bytes) : await pdf.embedJpg(params.logo.bytes);
      const escala = Math.min(80 / imagen.width, 44 / imagen.height, 1);
      pagina.drawImage(imagen, { x: MARGEN, y: y - imagen.height * escala + 12, width: imagen.width * escala, height: imagen.height * escala });
      xEmisor = MARGEN + imagen.width * escala + 12;
    } catch {
      // logo ilegible: el contrato sale igual, sin logo
    }
  }
  pagina.drawText(limpiarParaPdf(params.datos.empresa), { x: xEmisor, y, size: 13, font: negrita });
  pagina.drawText(limpiarParaPdf(`RUC ${params.datos.rucEmpresa} · ${params.datos.direccionEmpresa}`), { x: xEmisor, y: y - 14, size: 8.5, font: normal, color: gris });
  y -= 46;

  texto("CONTRATO DE PRESTACIÓN DEL SERVICIO DE ACCESO A INTERNET", { fuente: negrita, tamano: 12.5 });
  y -= 4;

  // --- Datos del abonado y del plan ---
  const filas: [string, string][] = [
    ["Abonado", params.datos.cliente],
    ["Cédula / RUC", params.datos.cedula],
    ["Dirección", params.datos.direccion],
    ["Teléfono", params.datos.telefono],
    ["Plan", `${params.datos.plan} (bajada ${params.datos.bajada} / subida ${params.datos.subida})`],
    ["Valor mensual", `USD ${params.datos.precio} + impuestos`],
    ["Plazo mínimo", params.datos.vigenciaMeses ? `${params.datos.vigenciaMeses} meses` : "Sin plazo mínimo"],
    ["Inicio del servicio", params.datos.fechaInicio],
  ];
  for (const [etiqueta, valor] of filas) {
    nuevaPaginaSiHaceFalta(14);
    pagina.drawText(limpiarParaPdf(etiqueta), { x: MARGEN, y, size: 9, font: negrita, color: gris });
    const lv = lineas(valor || "—", normal, 9.5, anchoUtil - 120);
    lv.forEach((l, i) => pagina.drawText(l, { x: MARGEN + 120, y: y - i * 12, size: 9.5, font: normal }));
    y -= 12 * Math.max(1, lv.length) + 2;
  }
  y -= 8;

  // --- Cláusulas ---
  texto(params.plantilla, { tamano: 9.5 });
  y -= 6;

  // --- Equipos en comodato ---
  nuevaPaginaSiHaceFalta(40);
  texto("EQUIPOS ENTREGADOS EN COMODATO", { fuente: negrita, tamano: 10 });
  if (params.equipos.length === 0) {
    texto("No se registraron equipos en el acta de instalación.", { tamano: 9, color: gris });
  } else {
    for (const e of params.equipos) {
      texto(`- ${e.tipo}${e.modelo ? ` ${e.modelo}` : ""}${e.serial ? `  —  Serie: ${e.serial}` : ""}`, { tamano: 9.5 });
    }
  }
  y -= 10;

  // --- Firma ---
  nuevaPaginaSiHaceFalta(150);
  const firma = await pdf.embedPng(params.firmaPng);
  const escalaFirma = Math.min(220 / firma.width, 90 / firma.height, 1);
  const altoFirma = firma.height * escalaFirma;
  pagina.drawImage(firma, { x: MARGEN, y: y - altoFirma, width: firma.width * escalaFirma, height: altoFirma });
  y -= altoFirma + 4;
  pagina.drawLine({ start: { x: MARGEN, y }, end: { x: MARGEN + 230, y }, thickness: 0.8, color: gris });
  y -= 13;
  texto(`${params.nombreFirmante}`, { fuente: negrita, tamano: 10 });
  texto(`C.I./RUC ${params.cedulaFirmante} — EL ABONADO`, { tamano: 9 });
  y -= 6;
  const fecha = params.fechaFirma.toLocaleString("es-EC", { dateStyle: "long", timeStyle: "short" });
  const detalleFirma = [
    `Firmado electrónicamente en pantalla el ${fecha}`,
    params.datos.ciudad ? `en ${params.datos.ciudad}` : null,
    params.ubicacion ? `(GPS ${params.ubicacion.latitud.toFixed(6)}, ${params.ubicacion.longitud.toFixed(6)})` : null,
    params.tecnico ? `ante el técnico ${params.tecnico}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  texto(detalleFirma, { tamano: 8, color: gris });

  // Pie con número de página en todas las páginas.
  const paginas = pdf.getPages();
  paginas.forEach((p, i) => {
    p.drawText(limpiarParaPdf(`${params.datos.empresa} · Contrato de ${params.datos.cliente} · Página ${i + 1} de ${paginas.length}`), {
      x: MARGEN,
      y: 28,
      size: 7.5,
      font: normal,
      color: gris,
    });
  });

  return pdf.save();
}
