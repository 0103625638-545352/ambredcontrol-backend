// Persistencia de los XML ya autorizados por el SRI (factura o nota de
// crédito) — el SRI exige conservar estos documentos varios años, así que no
// basta con tenerlos solo en la respuesta HTTP momentánea.
//
// Cada empresa guarda los suyos en SU PROPIA carpeta (ver
// EmpresaConfig.carpetaComprobantes) — nunca deben mezclarse entre empresas.
import * as fs from "fs";
import * as path from "path";
import { empresaActiva, empresaActivaId } from "../db";
import { rutaAbsoluta } from "./empresas";

function guardarEn(carpeta: string, claveAcceso: string, xmlAutorizado: string) {
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
  }
  fs.writeFileSync(path.join(carpeta, `${claveAcceso}.xml`), xmlAutorizado, "utf-8");
}

// Además de la carpeta principal, si se configura BACKUP_COMPROBANTES_PATH
// (otro disco, una unidad de red, una carpeta sincronizada a la nube) se
// guarda una SEGUNDA copia ahí — un solo disco nunca alcanza para cumplir con
// la obligación legal de conservar estos comprobantes. El respaldo es "mejor
// esfuerzo": si la ruta no existe o no es escribible, se registra el error
// pero NO se revierte el guardado principal ni la autorización ya concedida.
// Cada empresa respalda en su propia subcarpeta dentro de esa raíz.
export function guardarComprobanteAutorizado(claveAcceso: string, xmlAutorizado: string) {
  guardarEn(rutaComprobantesAutorizados(), claveAcceso, xmlAutorizado);

  const raizBackup = process.env.BACKUP_COMPROBANTES_PATH;
  if (raizBackup) {
    try {
      guardarEn(path.join(raizBackup, empresaActivaId()), claveAcceso, xmlAutorizado);
    } catch (error: any) {
      console.error(`[backup-comprobantes] No se pudo respaldar ${claveAcceso}:`, error.message);
    }
  }
}

export function rutaComprobantesAutorizados(): string {
  return rutaAbsoluta(empresaActiva().carpetaComprobantes);
}
