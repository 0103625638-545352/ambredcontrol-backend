// URLs de los web services SOAP del SRI (Ecuador) — el SRI usa un servidor
// DISTINTO según el ambiente: "celcer" para pruebas, "cel" (sin el "cer")
// para producción. Antes esto vivía como una sola URL global en .env, lo que
// significaba que una empresa en ambiente producción podía terminar
// mandando sus comprobantes al servidor de pruebas por error. Ahora se
// resuelve siempre a partir del ambiente de la empresa activa — no hay nada
// que configurar ni que se pueda desalinear.
export interface UrlsSri {
  recepcion: string;
  autorizacion: string;
}

const URLS_PRUEBAS: UrlsSri = {
  recepcion: "https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl",
  autorizacion: "https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl",
};

const URLS_PRODUCCION: UrlsSri = {
  recepcion: "https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl",
  autorizacion: "https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl",
};

export function obtenerUrlsSri(ambiente: "1" | "2"): UrlsSri {
  return ambiente === "2" ? URLS_PRODUCCION : URLS_PRUEBAS;
}
