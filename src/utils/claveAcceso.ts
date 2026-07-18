// Cálculo de la Clave de Acceso de 49 dígitos exigida por el SRI (Ecuador).
//
// Estructura de los 48 dígitos base (el dígito 49 es el verificador, calculado):
//   1. Fecha de emisión         (8 dígitos, formato ddmmaaaa)
//   2. Tipo de comprobante      (2 dígitos, "01" = factura)
//   3. RUC del emisor           (13 dígitos)
//   4. Tipo de ambiente         (1 dígito, "1" = pruebas, "2" = producción)
//   5. Serie (establecimiento + punto de emisión) (6 dígitos, ej. "001001")
//   6. Número del comprobante / secuencial        (9 dígitos)
//   7. Código numérico          (8 dígitos, libre elección del emisor)
//   8. Tipo de emisión          (1 dígito, "1" = emisión normal)
//   9. Dígito verificador       (1 dígito, calculado con Módulo 11)

export interface DatosClaveAcceso {
  fechaEmision: Date;
  tipoComprobante?: string; // default "01" = factura
  ruc: string;
  ambiente: "1" | "2"; // "1" pruebas, "2" producción
  establecimiento: string; // 3 dígitos, ej "001"
  puntoEmision: string; // 3 dígitos, ej "001"
  secuencial: number; // se rellena a 9 dígitos
  codigoNumerico?: string; // 8 dígitos; si no se pasa, se genera aleatorio
  tipoEmision?: string; // default "1"
}

/**
 * Calcula el dígito verificador (Módulo 11) de una cadena de 48 dígitos.
 *
 * Algoritmo oficial (Ficha Técnica SRI):
 *   - Recorrer los dígitos de DERECHA a IZQUIERDA.
 *   - Multiplicar cada uno por un peso que cicla: 2, 3, 4, 5, 6, 7, 2, 3, 4, 5, 6, 7...
 *   - Sumar todos los productos.
 *   - residuo = suma % 11
 *   - Si (11 - residuo) === 11 → dígito verificador = 0
 *   - Si (11 - residuo) === 10 → dígito verificador = 1
 *   - En cualquier otro caso   → dígito verificador = 11 - residuo
 */
export function calcularDigitoVerificador(cadena48: string): number {
  if (cadena48.length !== 48) {
    throw new Error(`Se esperaban 48 dígitos, se recibieron ${cadena48.length}`);
  }

  const digitos = cadena48.split("").map(Number);
  let suma = 0;
  let peso = 2;

  for (let i = digitos.length - 1; i >= 0; i--) {
    suma += digitos[i] * peso;
    peso = peso === 7 ? 2 : peso + 1;
  }

  const residuo = suma % 11;
  const resultado = 11 - residuo;

  if (resultado === 11) return 0;
  if (resultado === 10) return 1;
  return resultado;
}

/** Genera un código numérico aleatorio de 8 dígitos (campo de libre elección del emisor). */
function generarCodigoNumerico(): string {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

function formatearFecha(fecha: Date): string {
  const dd = String(fecha.getDate()).padStart(2, "0");
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const aaaa = fecha.getFullYear().toString();
  return `${dd}${mm}${aaaa}`;
}

/** Construye la clave de acceso completa de 49 dígitos. */
export function generarClaveAcceso(datos: DatosClaveAcceso): string {
  const fecha = formatearFecha(datos.fechaEmision);
  const tipoComprobante = datos.tipoComprobante ?? "01";
  const ruc = datos.ruc.padStart(13, "0");
  const ambiente = datos.ambiente;
  const serie = `${datos.establecimiento.padStart(3, "0")}${datos.puntoEmision.padStart(3, "0")}`;
  const secuencial = String(datos.secuencial).padStart(9, "0");
  const codigoNumerico = (datos.codigoNumerico ?? generarCodigoNumerico()).padStart(8, "0");
  const tipoEmision = datos.tipoEmision ?? "1";

  const cadena48 = `${fecha}${tipoComprobante}${ruc}${ambiente}${serie}${secuencial}${codigoNumerico}${tipoEmision}`;

  if (cadena48.length !== 48) {
    throw new Error(`Error interno: la cadena base debería tener 48 dígitos, tiene ${cadena48.length}`);
  }

  const digitoVerificador = calcularDigitoVerificador(cadena48);

  return `${cadena48}${digitoVerificador}`;
}
