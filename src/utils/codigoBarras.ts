// Validación del dígito de control de un código de barras EAN-13/UPC-A/EAN-8.
// Es el mismo algoritmo GS1 (mod 10, pesos alternados 3/1 de derecha a
// izquierda) para las 3 longitudes — solo se aplica si el valor es puramente
// numérico y de 8, 12 o 13 dígitos; cualquier otro caso (código alfanumérico
// tipo Code128, u otra longitud) pasa sin validar, porque no existe un
// esquema de dígito de control conocido para aplicarle. Separado de
// routes/productos.ts para poder testearlo sin base de datos (mismo criterio
// que retenciones.ts/estadoPago.ts).

const LONGITUDES_VALIDABLES = [8, 12, 13];

export function validarCodigoBarras(codigo: string): boolean {
  if (!codigo) return true; // campo opcional, vacío es válido
  if (!/^\d+$/.test(codigo)) return true; // no numérico: no se valida
  if (!LONGITUDES_VALIDABLES.includes(codigo.length)) return true; // longitud no estándar: no se valida

  const digitos = codigo.split("").map(Number);
  const digitoControl = digitos.pop()!;

  let suma = 0;
  let peso = 3;
  for (let i = digitos.length - 1; i >= 0; i--) {
    suma += digitos[i] * peso;
    peso = peso === 3 ? 1 : 3;
  }

  const controlCalculado = (10 - (suma % 10)) % 10;
  return controlCalculado === digitoControl;
}
