// Cliente para el servicio de AUTORIZACIÓN del SRI.
//
// Este es el "segundo paso": le preguntas al SRI, usando la clave de acceso,
// si ya terminó de validar tu comprobante. Aquí es donde se revisa TODO a fondo:
// la firma XAdES completa, que el certificado sea de una entidad acreditada,
// que los cálculos de IVA sean correctos, que el RUC del cliente exista, etc.

import axios from "axios";
import { XMLParser } from "fast-xml-parser";

export interface RespuestaAutorizacion {
  estado: "AUTORIZADO" | "NO AUTORIZADO" | "EN_PROCESO" | "ERROR_INESPERADO";
  numeroAutorizacion?: string;
  fechaAutorizacion?: string;
  ambiente?: string;
  comprobante?: string; // el XML autorizado completo, tal como lo devuelve el SRI
  mensajes: { identificador: string; mensaje: string; informacionAdicional?: string; tipo: string }[];
}

export async function consultarAutorizacion(
  claveAcceso: string,
  urlWsdl: string
): Promise<RespuestaAutorizacion> {
  const urlServicio = urlWsdl.replace("?wsdl", "");

  const sobreSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">
  <soapenv:Header/>
  <soapenv:Body>
    <ec:autorizacionComprobante>
      <claveAccesoComprobante>${claveAcceso}</claveAccesoComprobante>
    </ec:autorizacionComprobante>
  </soapenv:Body>
</soapenv:Envelope>`;

  try {
    const respuesta = await axios.post(urlServicio, sobreSoap, {
      headers: { "Content-Type": "text/xml;charset=UTF-8", SOAPAction: "" },
      timeout: 30000,
    });

    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
    const json = parser.parse(respuesta.data);

    const respuestaAutorizacion =
      json?.Envelope?.Body?.autorizacionComprobanteResponse?.RespuestaAutorizacionComprobante;

    if (!respuestaAutorizacion) {
      return { estado: "ERROR_INESPERADO", mensajes: [{ identificador: "N/A", mensaje: "Respuesta con formato inesperado", tipo: "ERROR" }] };
    }

    const autorizaciones = respuestaAutorizacion.autorizaciones?.autorizacion;

    if (!autorizaciones) {
      // Todavía no hay ningún registro de autorización: el SRI aún no ha procesado el comprobante
      return { estado: "EN_PROCESO", mensajes: [] };
    }

    const autorizacion = Array.isArray(autorizaciones) ? autorizaciones[0] : autorizaciones;

    const mensajesRaw = autorizacion.mensajes?.mensaje;
    const mensajes = mensajesRaw ? (Array.isArray(mensajesRaw) ? mensajesRaw : [mensajesRaw]) : [];

    return {
      estado: autorizacion.estado,
      numeroAutorizacion: autorizacion.numeroAutorizacion,
      fechaAutorizacion: autorizacion.fechaAutorizacion,
      ambiente: autorizacion.ambiente,
      comprobante: autorizacion.comprobante,
      mensajes,
    };
  } catch (error: any) {
    return {
      estado: "ERROR_INESPERADO",
      mensajes: [{ identificador: "N/A", mensaje: `Error de conexión: ${error.message}`, tipo: "ERROR" }],
    };
  }
}
