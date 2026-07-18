// Genera el código QR que representa la clave de acceso de 49 dígitos, para
// que el RIDE (o el recibo térmico) se pueda verificar escaneándolo, en vez
// de tener que tipear los 49 dígitos a mano.
//
// El QR codifica la clave de acceso en TEXTO PLANO, no una URL de consulta
// del SRI: la dirección exacta del portal público de verificación cambia de
// tanto en tanto, y arriesgarse a codificar un enlace equivocado en un
// documento que puede tener valor legal es peor que no ponerlo. Con la
// clave de acceso en texto, cualquier lector de QR o sistema (incluido el
// portal del SRI) puede usarla para buscar el comprobante.

import QRCode from "qrcode";

export async function generarQrClaveAcceso(claveAcceso: string): Promise<Buffer> {
  return QRCode.toBuffer(claveAcceso, {
    type: "png",
    margin: 1,
    width: 200,
    errorCorrectionLevel: "M",
  });
}
