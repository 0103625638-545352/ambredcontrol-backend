// Validación mínima de FORMA de un email (no verifica que el dominio exista
// ni hace ningún roundtrip real) — compartida por todo lugar donde un email
// es opcional: Cliente, Proveedor, y Usuario (recuperación de contraseña).
export function emailValido(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
