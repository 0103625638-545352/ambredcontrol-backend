import * as crypto from "crypto";

// Código numérico de 6 dígitos para recuperación de contraseña por correo
// (ver POST /auth/recuperar-password/*). Puramente generación — no toca la
// base de datos ni hashea nada (eso lo hace quien llama, con
// utils/auth.ts::hashPassword, igual que con las contraseñas reales).
export function generarCodigoRecuperacion(): string {
  return String(crypto.randomInt(100000, 1000000));
}
