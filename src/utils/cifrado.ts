// Cifrado de las credenciales de los equipos de red (contraseña del API del
// Mikrotik, comunidad/contraseñas SNMP y contraseña SSH de las OLT y de los
// switches). Antes se guardaban en texto plano: cualquiera con un respaldo de
// la base de datos tenía acceso administrativo a toda la red.
//
// AES-256-GCM con la clave CLAVE_CIFRADO_EQUIPOS del .env. Formato guardado:
//   "enc:v1:<iv base64>:<tag base64>:<datos base64>"
// Un valor sin ese prefijo se considera texto plano todavía no migrado: se
// devuelve tal cual al leerlo (así nada se rompe a mitad de la migración) y
// se cifra en el próximo arranque del servidor (ver
// cifrarCredencialesExistentes en db.ts).
//
// SIN la clave en .env el sistema se comporta como siempre (no cifra nada).
// CON la clave, perderla significa no poder descifrar: hay que volver a
// cargar las contraseñas de cada equipo a mano. Por eso va respaldada junto
// con el .env.
import * as crypto from "crypto";

const PREFIJO = "enc:v1:";

let claveCache: Buffer | null | undefined;

function clave(): Buffer | null {
  if (claveCache !== undefined) return claveCache;
  const texto = process.env.CLAVE_CIFRADO_EQUIPOS?.trim();
  // Se acepta cualquier texto: se deriva a 32 bytes con SHA-256, así no hay
  // que exigir un formato exacto (hex/base64) a quien lo configura.
  claveCache = texto ? crypto.createHash("sha256").update(texto).digest() : null;
  return claveCache;
}

export function cifradoActivo(): boolean {
  return clave() !== null;
}

export function estaCifrado(valor: unknown): boolean {
  return typeof valor === "string" && valor.startsWith(PREFIJO);
}

export function cifrar(valor: string | null | undefined): string | null | undefined {
  const k = clave();
  if (!k || valor == null || valor === "" || estaCifrado(valor)) return valor;
  const iv = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv("aes-256-gcm", k, iv);
  const datos = Buffer.concat([cifrador.update(valor, "utf8"), cifrador.final()]);
  const tag = cifrador.getAuthTag();
  return `${PREFIJO}${iv.toString("base64")}:${tag.toString("base64")}:${datos.toString("base64")}`;
}

export function descifrar(valor: string | null | undefined): string | null | undefined {
  if (!estaCifrado(valor)) return valor;
  const k = clave();
  if (!k) {
    throw new Error(
      "Hay credenciales de equipos cifradas en la base de datos pero falta CLAVE_CIFRADO_EQUIPOS en el .env — sin ella no se puede conectar a los Mikrotik/OLT."
    );
  }
  const [ivB64, tagB64, datosB64] = (valor as string).slice(PREFIJO.length).split(":");
  const descifrador = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(ivB64, "base64"));
  descifrador.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([descifrador.update(Buffer.from(datosB64, "base64")), descifrador.final()]).toString("utf8");
}

// Campos sensibles por modelo de Prisma (nombre del modelo en camelCase,
// como en prisma.nodoRed).
export const CAMPOS_CIFRADOS: Record<string, string[]> = {
  nodoRed: ["mikrotikPassword"],
  olt: ["snmpComunidad", "snmpAuthPassword", "snmpPrivPassword", "sshPassword"],
  switchCliente: ["snmpComunidad", "snmpAuthPassword", "snmpPrivPassword"],
};

// Aplica "transformar" a los campos sensibles de un objeto de datos de
// escritura (data de create/update, o cada elemento si es un arreglo).
export function transformarCampos(datos: any, campos: string[], transformar: (v: any) => any): any {
  if (Array.isArray(datos)) return datos.map((d) => transformarCampos(d, campos, transformar));
  if (!datos || typeof datos !== "object") return datos;
  const copia = { ...datos };
  for (const campo of campos) {
    if (!(campo in copia)) continue;
    const valor = copia[campo];
    // Prisma admite { set: "..." } en los update.
    if (valor && typeof valor === "object" && "set" in valor) copia[campo] = { ...valor, set: transformar(valor.set) };
    else copia[campo] = transformar(valor);
  }
  return copia;
}
