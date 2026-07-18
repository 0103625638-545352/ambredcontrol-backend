// El logo de la empresa se guarda en disco con un nombre fijo (no en la base
// de datos, igual que las fotos de producto) — así el RIDE lo puede leer
// directamente sin necesidad de una consulta extra ni de guardar una URL.
// Cada empresa tiene su propia carpeta de uploads (ver EmpresaConfig.carpetaUploads
// en utils/empresas.ts), así que "carpetaUploads" siempre llega como parámetro
// — este archivo no asume ninguna carpeta fija.
import * as fs from "fs";
import * as path from "path";

const NOMBRE_BASE = "logo-empresa";

// Solo PNG y JPG: son los únicos formatos que pdf-lib puede incrustar
// directamente en el PDF (a diferencia de WEBP, que sí se acepta para fotos
// de producto porque esas nunca se dibujan dentro de un PDF).
export const EXTENSIONES_LOGO_PERMITIDAS = ["png", "jpg", "jpeg"] as const;
export type ExtensionLogo = (typeof EXTENSIONES_LOGO_PERMITIDAS)[number];

export function rutaLogo(carpetaUploads: string, extension: ExtensionLogo): string {
  return path.join(carpetaUploads, `${NOMBRE_BASE}.${extension}`);
}

// Busca el logo actual (si existe) probando cada extensión posible, porque
// no sabemos de antemano con cuál se subió la última vez.
export function leerLogoEmpresa(carpetaUploads: string): { bytes: Buffer; extension: ExtensionLogo } | null {
  for (const extension of EXTENSIONES_LOGO_PERMITIDAS) {
    const ruta = rutaLogo(carpetaUploads, extension);
    if (fs.existsSync(ruta)) {
      return { bytes: fs.readFileSync(ruta), extension };
    }
  }
  return null;
}

// Borra cualquier logo anterior, sin importar la extensión — evita quedarnos
// con "logo-empresa.png" viejo y "logo-empresa.jpg" nuevo coexistiendo.
export function borrarLogoAnterior(carpetaUploads: string): void {
  for (const extension of EXTENSIONES_LOGO_PERMITIDAS) {
    const ruta = rutaLogo(carpetaUploads, extension);
    if (fs.existsSync(ruta)) fs.unlinkSync(ruta);
  }
}
