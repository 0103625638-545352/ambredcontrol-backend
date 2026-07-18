// Script de UN SOLO USO para generar un certificado de prueba (autofirmado).
// Esto NO sirve para facturar de verdad ante el SRI (necesitas un certificado
// acreditado real), pero sí sirve para probar que nuestro código de firma
// funciona correctamente mientras tramitas el certificado real.
//
// Uso: npx ts-node generar-certificado-prueba.ts

import * as forge from "node-forge";
import * as fs from "fs";

console.log("Generando par de claves RSA de 2048 bits (puede tardar unos segundos)...");
const keys = forge.pki.rsa.generateKeyPair(2048);

const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = "01" + Date.now(); // debe ser único
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

const atributos = [
  { name: "commonName", value: "1234567890001" }, // aquí normalmente iría tu RUC
  { name: "countryName", value: "EC" },
  { shortName: "ST", value: "Pichincha" },
  { name: "localityName", value: "Quito" },
  { name: "organizationName", value: "Negocio de Prueba" },
];

cert.setSubject(atributos as any);
cert.setIssuer(atributos as any); // autofirmado: el emisor es el mismo que el sujeto
cert.sign(keys.privateKey, forge.md.sha256.create());

// Empaquetar todo en un .p12, protegido con la contraseña "1234"
const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "1234", {
  algorithm: "3des",
});
const p12Der = forge.asn1.toDer(p12Asn1).getBytes();

fs.writeFileSync("./certificado.p12", Buffer.from(p12Der, "binary"));

console.log("\n✅ Certificado de prueba creado: ./certificado.p12");
console.log("   Contraseña: 1234");
console.log("\nAgrega esto a tu .env:");
console.log('CERTIFICADO_P12_PATH="./certificado.p12"');
console.log('CERTIFICADO_P12_PASSWORD="1234"');
