// Firma XAdES-BES completa para comprobantes electrónicos del SRI (Ecuador).
//
// XAdES-BES = XML-DSig (lo que ya construimos) + un bloque adicional obligatorio
// llamado "SignedProperties", que incluye:
//   - SigningTime: cuándo se firmó
//   - SigningCertificate: el "huella digital" (hash) del certificado usado,
//     para que nadie pueda sustituirlo por otro después de firmado
//   - DataObjectFormat: qué tipo de documento se firmó
//
// La complejidad de este archivo viene de una regla estricta de la firma digital:
// el SignedProperties también debe estar "protegido" por la firma (si no, alguien
// podría cambiar la hora de firma después sin invalidar nada). Por eso el
// SignedInfo tiene DOS referencias: una al documento, y otra al SignedProperties.

import * as crypto from "crypto";
import * as forge from "node-forge";
import { DOMParser } from "@xmldom/xmldom";
// @ts-ignore - xml-crypto no exporta tipos para esta clase interna, pero sí la clase en runtime
import { C14nCanonicalization } from "xml-crypto";
import { CredencialesCertificado } from "./certificado";

const XADES_NS = "http://uri.etsi.org/01903/v1.3.2#";
const DS_NS = "http://www.w3.org/2000/09/xmldsig#";

function sha1Base64(data: Buffer | string): string {
  return crypto.createHash("sha1").update(data).digest("base64");
}

/** Canonicaliza (normaliza) un fragmento XML de la misma forma en que lo hará el verificador. */
function canonicalizar(xmlFragment: string): string {
  const doc = new DOMParser().parseFromString(xmlFragment, "text/xml");
  if (!doc.documentElement) {
    throw new Error("No se pudo parsear el fragmento XML a canonicalizar");
  }
  const c14n = new C14nCanonicalization();
  // xml-crypto y @xmldom/xmldom definen "Element"/"Node" de forma distinta para
  // TypeScript, aunque en tiempo de ejecución son perfectamente compatibles
  // (ambos son DOM estándar). Forzamos el tipo aquí para evitar ese choque.
  return c14n.process(doc.documentElement as any, {});
}

/** Extrae del certificado PEM los datos que XAdES exige sobre el firmante. */
function extraerDatosCertificado(certificatePem: string) {
  const cert = forge.pki.certificateFromPem(certificatePem);

  // El hash de SigningCertificate se calcula sobre el DER (binario), no sobre el PEM (texto)
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const certDerBuffer = Buffer.from(certDer, "binary");
  const certDigest = sha1Base64(certDerBuffer);

  const issuerName = cert.issuer.attributes
    .map((attr) => `${attr.shortName}=${attr.value}`)
    .reverse()
    .join(",");
  const serialNumber = BigInt(`0x${cert.serialNumber}`).toString();

  const certBase64 = Buffer.from(certDer, "binary").toString("base64");

  return { certDigest, issuerName, serialNumber, certBase64 };
}

export function firmarXadesBes(xmlSinFirmar: string, credenciales: CredencialesCertificado): string {
  const { certDigest, issuerName, serialNumber, certBase64 } = extraerDatosCertificado(
    credenciales.certificatePem
  );

  const signingTime = new Date().toISOString().split(".")[0] + "-05:00"; // hora Ecuador (UTC-5)
  const signedPropertiesId = "SignedPropertiesId1";
  const signatureId = "SignatureId1";
  const certificateId = "CertificateId1";
  const referenceMainId = "Reference-Comprobante";

  // --- 1. Digest del documento principal (la factura completa) ---
  const digestComprobante = sha1Base64(canonicalizar(xmlSinFirmar));

  // --- 2. Construir el fragmento SignedProperties y calcular su digest ---
  const signedPropertiesXml =
    `<SignedProperties xmlns="${XADES_NS}" Id="${signedPropertiesId}">` +
      `<SignedSignatureProperties>` +
        `<SigningTime>${signingTime}</SigningTime>` +
        `<SigningCertificate>` +
          `<Cert>` +
            `<CertDigest>` +
              `<DigestMethod xmlns="${DS_NS}" Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
              `<DigestValue xmlns="${DS_NS}">${certDigest}</DigestValue>` +
            `</CertDigest>` +
            `<IssuerSerial>` +
              `<X509IssuerName xmlns="${DS_NS}">${issuerName}</X509IssuerName>` +
              `<X509SerialNumber xmlns="${DS_NS}">${serialNumber}</X509SerialNumber>` +
            `</IssuerSerial>` +
          `</Cert>` +
        `</SigningCertificate>` +
      `</SignedSignatureProperties>` +
      `<SignedDataObjectProperties>` +
        `<DataObjectFormat ObjectReference="#${referenceMainId}">` +
          `<Description>Comprobante electrónico</Description>` +
          `<MimeType>text/xml</MimeType>` +
        `</DataObjectFormat>` +
      `</SignedDataObjectProperties>` +
    `</SignedProperties>`;

  const digestSignedProperties = sha1Base64(canonicalizar(signedPropertiesXml));

  // --- 3. Construir SignedInfo con las DOS referencias ---
  const signedInfoXml =
    `<SignedInfo xmlns="${DS_NS}">` +
      `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
      `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>` +
      `<Reference Id="${referenceMainId}" URI="#comprobante">` +
        `<Transforms>` +
          `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
        `</Transforms>` +
        `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
        `<DigestValue>${digestComprobante}</DigestValue>` +
      `</Reference>` +
      `<Reference Type="http://uri.etsi.org/01903#SignedProperties" URI="#${signedPropertiesId}">` +
        `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
        `<DigestValue>${digestSignedProperties}</DigestValue>` +
      `</Reference>` +
    `</SignedInfo>`;

  // --- 4. Firmar el SignedInfo (esto es lo que realmente protege la clave privada) ---
  const signedInfoCanonico = canonicalizar(signedInfoXml);
  const signer = crypto.createSign("RSA-SHA1");
  signer.update(signedInfoCanonico);
  const signatureValue = signer.sign(credenciales.privateKeyPem, "base64");

  // --- 5. Ensamblar el <Signature> completo con todas sus piezas ---
  const signatureXml =
    `<Signature xmlns="${DS_NS}" Id="${signatureId}">` +
      signedInfoXml +
      `<SignatureValue>${signatureValue}</SignatureValue>` +
      `<KeyInfo Id="${certificateId}">` +
        `<X509Data>` +
          `<X509Certificate>${certBase64}</X509Certificate>` +
        `</X509Data>` +
      `</KeyInfo>` +
      `<Object>` +
        `<QualifyingProperties xmlns="${XADES_NS}" Target="#${signatureId}">` +
          signedPropertiesXml +
        `</QualifyingProperties>` +
      `</Object>` +
    `</Signature>`;

  // --- 6. Insertar la firma como último hijo del elemento raíz ---
  // Insertamos justo antes del cierre del último tag del documento.
  const ultimoCierre = xmlSinFirmar.lastIndexOf("</");
  const xmlFirmado =
    xmlSinFirmar.slice(0, ultimoCierre) + signatureXml + xmlSinFirmar.slice(ultimoCierre);

  return xmlFirmado;
}
