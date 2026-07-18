import * as crypto from "crypto";

// Genera una contraseña temporal legible (sin caracteres ambiguos como 0/O,
// 1/l/I) para que un admin se la pueda dictar o escribir a mano sin errores
// — la usa el reseteo de contraseña (PATCH /usuarios/:id/resetear-password).
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export function generarPasswordTemporal(longitud = 10): string {
  let resultado = "";
  for (let i = 0; i < longitud; i++) {
    resultado += ALFABETO[crypto.randomInt(ALFABETO.length)];
  }
  return resultado;
}
