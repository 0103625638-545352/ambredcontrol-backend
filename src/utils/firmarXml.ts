// Firma un XML con una firma "enveloped" (la firma queda insertada DENTRO
// del mismo documento que firma, como último elemento del nodo raíz).
//
// Esto es XML-DSig estándar — la base técnica de XAdES-BES. En la siguiente
// lección le agregamos las propiedades específicas que exige el SRI
// (SigningTime, hash del certificado, política de firma) para que sea
// XAdES-BES completo y no solo una firma XML genérica.

import { SignedXml } from "xml-crypto";
import { CredencialesCertificado } from "./certificado";

export function firmarXmlEnveloped(xml: string, credenciales: CredencialesCertificado): string {
  const sig = new SignedXml({
    privateKey: credenciales.privateKeyPem,
    publicCert: credenciales.certificatePem,
    signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
    canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  });

  // Firmamos el documento completo (nodo raíz "/*"), con la transformación
  // "enveloped-signature" que le dice al verificador: "ignora la firma misma
  // al momento de recalcular el hash, porque ella no existía cuando se firmó".
  sig.addReference({
    xpath: "/*",
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
    ],
  });

  // Insertamos el <Signature> como último hijo del elemento raíz (<factura>)
  sig.computeSignature(xml, {
    location: { reference: "/*", action: "append" },
  });

  return sig.getSignedXml();
}

/** Verifica que una firma XML-DSig sea válida (para probar nuestro propio trabajo). */
export function verificarFirmaXml(xmlFirmado: string): boolean {
  const { DOMParser } = require("@xmldom/xmldom");
  const xpath = require("xpath");

  const doc = new DOMParser().parseFromString(xmlFirmado, "text/xml");
  const signatureNode = xpath.select(
    "//*[local-name(.)='Signature']",
    doc
  )[0];

  if (!signatureNode) return false;

  const certMatch = xmlFirmado.match(/<X509Certificate>([\s\S]*?)<\/X509Certificate>/);
  if (!certMatch) return false;
  const certBase64 = certMatch[1].replace(/\s+/g, "");
  const certPem = `-----BEGIN CERTIFICATE-----\n${certBase64}\n-----END CERTIFICATE-----`;

  const sig = new SignedXml();
  sig.publicCert = certPem;
  sig.loadSignature(signatureNode);

  return sig.checkSignature(xmlFirmado);
}
