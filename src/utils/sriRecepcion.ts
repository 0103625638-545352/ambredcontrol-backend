// Cliente para el servicio de RECEPCIÓN del SRI.
//
// Este es el "primer paso": le mandas el XML firmado y el SRI solo revisa
// que la estructura y la firma sean correctas. Te responde "RECIBIDA" (pasó
// esa revisión superficial) o "DEVUELTA" (algo está mal, con el detalle del error).
//
// OJO: "RECIBIDA" NO significa autorizada todavía — solo significa que puedes
// pasar al siguiente paso (Autorización) a preguntar si ya la validaron del todo.

import axios from "axios";
import { XMLParser } from "fast-xml-parser";

export interface MensajeSri {
  identificador: string;
  mensaje: string;
  informacionAdicional?: string;
  tipo: string;
}

export interface RespuestaRecepcion {
  estado: "RECIBIDA" | "DEVUELTA" | "ERROR_INESPERADO";
  mensajes: MensajeSri[];
}

export async function enviarComprobanteRecepcion(
  xmlFirmado: string,
  urlWsdl: string
): Promise<RespuestaRecepcion> {
  // El servicio espera el XML codificado en Base64, viajando dentro del sobre SOAP
  const xmlBase64 = Buffer.from(xmlFirmado, "utf-8").toString("base64");

  // La URL del servicio real (sin "?wsdl") es la que recibe el POST
  const urlServicio = urlWsdl.replace("?wsdl", "");

  const sobreSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion">
  <soapenv:Header/>
  <soapenv:Body>
    <ec:validarComprobante>
      <xml>${xmlBase64}</xml>
    </ec:validarComprobante>
  </soapenv:Body>
</soapenv:Envelope>`;

  try {
    const respuesta = await axios.post(urlServicio, sobreSoap, {
      headers: {
        "Content-Type": "text/xml;charset=UTF-8",
        SOAPAction: "",
      },
      timeout: 30000,
    });

    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
    const json = parser.parse(respuesta.data);

    // La estructura real de la respuesta SOAP anida bastante; navegamos hasta el contenido
    const respuestaSolicitud =
      json?.Envelope?.Body?.validarComprobanteResponse?.RespuestaRecepcionComprobante;

    if (!respuestaSolicitud) {
      return {
        estado: "ERROR_INESPERADO",
        mensajes: [
          {
            identificador: "N/A",
            mensaje: "Respuesta con formato inesperado. XML crudo: " + respuesta.data.substring(0, 2000),
            tipo: "ERROR",
          },
        ],
      };
    }

    const estado = respuestaSolicitud.estado;
    let mensajes: MensajeSri[] = [];

    const comprobantes = respuestaSolicitud.comprobantes?.comprobante;
    if (comprobantes) {
      const listaComprobantes = Array.isArray(comprobantes) ? comprobantes : [comprobantes];
      for (const comp of listaComprobantes) {
        const msgs = comp.mensajes?.mensaje;
        if (msgs) {
          const listaMsgs = Array.isArray(msgs) ? msgs : [msgs];
          mensajes.push(...listaMsgs);
        }
      }
    }

    return { estado, mensajes };
  } catch (error: any) {
    const detalle = error.response?.data
      ? `Respuesta del servidor: ${String(error.response.data).substring(0, 2000)}`
      : error.message;
    return {
      estado: "ERROR_INESPERADO",
      mensajes: [{ identificador: "N/A", mensaje: `Error de conexión: ${detalle}`, tipo: "ERROR" }],
    };
  }
}
