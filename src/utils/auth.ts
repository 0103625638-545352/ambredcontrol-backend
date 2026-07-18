// Funciones para manejar contraseñas de forma segura y sesiones con JWT.
//
// CONCEPTO CLAVE: nunca guardamos la contraseña real en la base de datos,
// solo su "hash" — una huella digital de un solo sentido. Si alguien roba
// la base de datos, no puede recuperar la contraseña original a partir del hash.

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "cambia-esto-en-produccion";
const JWT_EXPIRACION = "8h"; // la sesión expira sola después de 8 horas

export async function hashPassword(passwordPlano: string): Promise<string> {
  // El "10" es el costo del hashing: más alto = más seguro pero más lento.
  // 10 es un valor estándar recomendado, buen balance para este tipo de app.
  return bcrypt.hash(passwordPlano, 10);
}

export async function compararPassword(passwordPlano: string, hash: string): Promise<boolean> {
  return bcrypt.compare(passwordPlano, hash);
}

export interface TokenPayload {
  usuarioId: number;
  usuario: string;
  rol: string;
  empresaId: string;
}

export function generarToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRACION });
}

export function verificarToken(token: string): TokenPayload {
  // Si el token es inválido o expiró, jwt.verify lanza un error automáticamente
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}
