// Validación de cédula y RUC ecuatorianos usando los algoritmos oficiales
// de dígito verificador. Esto evita que alguien registre un cliente con un
// número inventado o mal tipeado (ej. un dígito de más, o transpuesto).
//
// Ecuador tiene 3 tipos de identificación con reglas de validación distintas:
//   1. Cédula (10 dígitos)                    → persona natural
//   2. RUC de persona natural (13 dígitos)     → cédula + "001" (o más establecimientos)
//   3. RUC de sociedad privada (13 dígitos)    → tercer dígito "9"
//   4. RUC de entidad del sector público (13)  → tercer dígito "6"

export interface ResultadoValidacion {
  valido: boolean;
  mensaje?: string;
}

/** Valida que las provincias (2 primeros dígitos) sean un código real. */
function provinciaValida(codigo: string): boolean {
  const numero = parseInt(codigo, 10);
  // 01-24 son las 24 provincias; 30 se usa para ecuatorianos en el exterior
  return (numero >= 1 && numero <= 24) || numero === 30;
}

/**
 * Algoritmo de Módulo 10 — usado para validar la CÉDULA (y los primeros 10
 * dígitos de un RUC de persona natural).
 *
 * Se multiplican los primeros 9 dígitos alternando por 2 y 1; si el producto
 * de un dígito por 2 da un número de dos cifras, se le resta 9. Se suman
 * todos los resultados, y el dígito verificador es lo que le falta a esa
 * suma para llegar al siguiente múltiplo de 10.
 */
function calcularDigitoVerificadorModulo10(nueveDigitos: string): number {
  const coeficientes = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let suma = 0;

  for (let i = 0; i < 9; i++) {
    let producto = parseInt(nueveDigitos[i], 10) * coeficientes[i];
    if (producto >= 10) producto -= 9;
    suma += producto;
  }

  const residuo = suma % 10;
  return residuo === 0 ? 0 : 10 - residuo;
}

export function validarCedula(cedula: string): ResultadoValidacion {
  // Caso especial: "9999999999" es el código reconocido para "Consumidor Final"
  // en ventas sin identificación del comprador — no es una cédula real, así
  // que no le aplicamos el algoritmo de dígito verificador.
  if (cedula === "9999999999") {
    return { valido: true };
  }

  if (!/^\d{10}$/.test(cedula)) {
    return { valido: false, mensaje: "La cédula debe tener exactamente 10 dígitos numéricos" };
  }

  if (!provinciaValida(cedula.slice(0, 2))) {
    return { valido: false, mensaje: "Los dos primeros dígitos no corresponden a una provincia válida" };
  }

  const tercerDigito = parseInt(cedula[2], 10);
  if (tercerDigito > 5) {
    return { valido: false, mensaje: "El tercer dígito indica que esto no es una cédula de persona natural" };
  }

  const digitoEsperado = calcularDigitoVerificadorModulo10(cedula.slice(0, 9));
  const digitoReal = parseInt(cedula[9], 10);

  if (digitoEsperado !== digitoReal) {
    return { valido: false, mensaje: "El dígito verificador de la cédula no coincide" };
  }

  return { valido: true };
}

/**
 * Algoritmo de Módulo 11 — usado para RUC de sociedades (privadas y públicas).
 * Mismo principio que el Módulo 10, pero con coeficientes distintos y sin el
 * ajuste de "restar 9".
 */
function calcularDigitoVerificadorModulo11(digitos: string, coeficientes: number[]): number {
  let suma = 0;
  for (let i = 0; i < coeficientes.length; i++) {
    suma += parseInt(digitos[i], 10) * coeficientes[i];
  }
  const residuo = suma % 11;
  const resultado = 11 - residuo;
  if (resultado === 11) return 0;
  return resultado;
}

export function validarRuc(ruc: string): ResultadoValidacion {
  if (!/^\d{13}$/.test(ruc)) {
    return { valido: false, mensaje: "El RUC debe tener exactamente 13 dígitos numéricos" };
  }

  if (!provinciaValida(ruc.slice(0, 2))) {
    return { valido: false, mensaje: "Los dos primeros dígitos no corresponden a una provincia válida" };
  }

  const tercerDigito = parseInt(ruc[2], 10);

  // --- Caso 1: RUC de persona natural (tercer dígito 0-5) ---
  if (tercerDigito <= 5) {
    const cedulaValidacion = validarCedula(ruc.slice(0, 10));
    if (!cedulaValidacion.valido) {
      return { valido: false, mensaje: `RUC de persona natural inválido: ${cedulaValidacion.mensaje}` };
    }
    const establecimiento = ruc.slice(10, 13);
    if (establecimiento === "000") {
      return { valido: false, mensaje: "El código de establecimiento (últimos 3 dígitos) no puede ser 000" };
    }
    return { valido: true };
  }

  // --- Caso 2: RUC de sociedad privada (tercer dígito 9) ---
  if (tercerDigito === 9) {
    const coeficientes = [4, 3, 2, 7, 6, 5, 4, 3, 2];
    const digitoEsperado = calcularDigitoVerificadorModulo11(ruc.slice(0, 9), coeficientes);
    const digitoReal = parseInt(ruc[9], 10);
    if (digitoEsperado !== digitoReal) {
      return { valido: false, mensaje: "El dígito verificador del RUC de sociedad privada no coincide" };
    }
    if (ruc.slice(10, 13) === "000") {
      return { valido: false, mensaje: "El código de establecimiento (últimos 3 dígitos) no puede ser 000" };
    }
    return { valido: true };
  }

  // --- Caso 3: RUC de entidad del sector público (tercer dígito 6) ---
  if (tercerDigito === 6) {
    const coeficientes = [3, 2, 7, 6, 5, 4, 3, 2];
    const digitoEsperado = calcularDigitoVerificadorModulo11(ruc.slice(0, 8), coeficientes);
    const digitoReal = parseInt(ruc[8], 10);
    if (digitoEsperado !== digitoReal) {
      return { valido: false, mensaje: "El dígito verificador del RUC del sector público no coincide" };
    }
    return { valido: true };
  }

  return { valido: false, mensaje: "El tercer dígito no corresponde a ningún tipo de RUC conocido" };
}

/** Punto de entrada único: valida según el tipo de identificación declarado. */
export function validarIdentificacion(tipo: string, numero: string): ResultadoValidacion {
  if (tipo === "CEDULA") return validarCedula(numero);
  if (tipo === "RUC") return validarRuc(numero);
  // Los pasaportes no siguen un formato numérico estandarizado internacionalmente,
  // así que no aplicamos validación de dígito verificador a ese caso.
  return { valido: true };
}
