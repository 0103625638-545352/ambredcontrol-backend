// Lee un archivo de certificado .p12 (PKCS#12) y extrae:
//   - la clave privada (para firmar)
//   - el certificado en formato PEM (para incluir en el XML, así el que lo reciba
//     puede verificar la firma con la clave pública)
//
// node-forge es la librería que sabe "abrir" el contenedor .p12, que es un formato
// binario cifrado con la contraseña que definiste al generar tu certificado.

import * as forge from "node-forge";
import * as fs from "fs";

export interface CredencialesCertificado {
  privateKeyPem: string;
  certificatePem: string;
}

export function cargarCertificadoP12(rutaArchivo: string, password: string): CredencialesCertificado {
  const p12Buffer = fs.readFileSync(rutaArchivo);
  const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString("binary"));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  // Un .p12 puede contener varios "bags" (compartimentos); buscamos
  // el que tiene la clave privada y el que tiene el certificado.
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });

  const keyBagArray = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag];
  const certBagArray = certBags[forge.pki.oids.certBag];

  if (!keyBagArray || keyBagArray.length === 0) {
    throw new Error("No se encontró una clave privada en el archivo .p12");
  }
  if (!certBagArray || certBagArray.length === 0) {
    throw new Error("No se encontró un certificado en el archivo .p12");
  }

  const privateKey = keyBagArray[0].key;
  const certificate = certBagArray[0].cert;

  if (!privateKey || !certificate) {
    throw new Error("El archivo .p12 no tiene el formato esperado");
  }

  const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
  const certificatePem = forge.pki.certificateToPem(certificate);

  return { privateKeyPem, certificatePem };
}

// Fecha de expiración del certificado, para el aviso del Dashboard (ver
// utils/alertasNegocio.ts). Con caché de 6 horas por empresa: descifrar un
// .p12 es una operación deliberadamente lenta, y GET /dashboard/resumen se
// pide en cada carga de pantalla — no tiene sentido repetir el descifrado en
// cada una. La caché se invalida sola al subir un certificado nuevo (ver
// invalidarCacheExpiracionCertificado, llamado desde routes/configuracion.ts).
interface CacheExpiracion {
  fechaExpiracion: Date;
  calculadaEn: number;
}
const TTL_CACHE_MS = 6 * 60 * 60 * 1000;
const cacheExpiracion = new Map<string, CacheExpiracion>();

export function leerFechaExpiracionCertificado(empresaId: string, rutaArchivo: string, password: string): Date {
  const cacheado = cacheExpiracion.get(empresaId);
  if (cacheado && Date.now() - cacheado.calculadaEn < TTL_CACHE_MS) {
    return cacheado.fechaExpiracion;
  }

  const { certificatePem } = cargarCertificadoP12(rutaArchivo, password);
  const fechaExpiracion = forge.pki.certificateFromPem(certificatePem).validity.notAfter;
  cacheExpiracion.set(empresaId, { fechaExpiracion, calculadaEn: Date.now() });
  return fechaExpiracion;
}

export function invalidarCacheExpiracionCertificado(empresaId: string): void {
  cacheExpiracion.delete(empresaId);
}
