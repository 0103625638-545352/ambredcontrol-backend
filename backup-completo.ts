// Script de backup: crea un archivo .zip con:
//   1. Un volcado (dump) completo de tu base de datos PostgreSQL
//   2. Todos los XML autorizados por el SRI que tengas guardados
//
// Uso manual:      npx ts-node backup-completo.ts
// Uso programado:  ver instrucciones para el Programador de Tareas de Windows
//                   al final de este archivo (o en el mensaje del chat).

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { ZipArchive } from "archiver";
import * as dotenv from "dotenv";

dotenv.config();

const execFileAsync = promisify(execFile);

const CARPETA_BACKUPS = path.join(process.cwd(), "backups");
const CARPETA_COMPROBANTES = path.join(process.cwd(), "comprobantes-autorizados");
const DIAS_A_CONSERVAR = 30; // cuántos backups viejos mantener antes de borrarlos

function timestamp(): string {
  const ahora = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${ahora.getFullYear()}${pad(ahora.getMonth() + 1)}${pad(ahora.getDate())}_${pad(ahora.getHours())}${pad(ahora.getMinutes())}`;
}

async function volcarBaseDeDatos(rutaSalida: string) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("No se encontró DATABASE_URL en tu archivo .env");
  }

  // pg_dump acepta directamente una URL de conexión completa como argumento.
  // --no-owner y --no-privileges hacen el dump más portable (evita fallos
  // al restaurar en un servidor con usuarios de PostgreSQL distintos).
  await execFileAsync("pg_dump", [databaseUrl, "--no-owner", "--no-privileges", "-f", rutaSalida]);
}

async function main() {
  console.log("=== Iniciando backup ===");

  if (!fs.existsSync(CARPETA_BACKUPS)) {
    fs.mkdirSync(CARPETA_BACKUPS, { recursive: true });
  }

  const nombreBase = `backup-${timestamp()}`;
  const rutaSqlTemporal = path.join(CARPETA_BACKUPS, `${nombreBase}.sql`);
  const rutaZipFinal = path.join(CARPETA_BACKUPS, `${nombreBase}.zip`);

  console.log("Exportando base de datos con pg_dump...");
  await volcarBaseDeDatos(rutaSqlTemporal);
  console.log("Base de datos exportada.");

  console.log("Empaquetando en .zip (base de datos + comprobantes autorizados)...");

  await new Promise<void>((resolve, reject) => {
    const salida = fs.createWriteStream(rutaZipFinal);
    const archivo = new ZipArchive({ zlib: { level: 9 } });

    salida.on("close", () => resolve());
    archivo.on("error", (err: Error) => reject(err));

    archivo.pipe(salida);
    archivo.file(rutaSqlTemporal, { name: "base-de-datos.sql" });

    if (fs.existsSync(CARPETA_COMPROBANTES)) {
      archivo.directory(CARPETA_COMPROBANTES, "comprobantes-autorizados");
    }

    archivo.finalize();
  });

  // Borramos el .sql suelto: ya quedó dentro del .zip, no hace falta duplicarlo
  fs.unlinkSync(rutaSqlTemporal);

  const tamanoMB = (fs.statSync(rutaZipFinal).size / (1024 * 1024)).toFixed(2);
  console.log(`✅ Backup creado: ${rutaZipFinal} (${tamanoMB} MB)`);

  // --- Rotación: borrar backups más viejos que DIAS_A_CONSERVAR días ---
  const ahora = Date.now();
  const archivosBackup = fs.readdirSync(CARPETA_BACKUPS).filter((f) => f.endsWith(".zip"));

  for (const archivoNombre of archivosBackup) {
    const rutaCompleta = path.join(CARPETA_BACKUPS, archivoNombre);
    const antiguedadDias = (ahora - fs.statSync(rutaCompleta).mtimeMs) / (1000 * 60 * 60 * 24);
    if (antiguedadDias > DIAS_A_CONSERVAR) {
      fs.unlinkSync(rutaCompleta);
      console.log(`🗑️  Backup antiguo eliminado: ${archivoNombre}`);
    }
  }

  console.log("=== Backup completo ===");
}

main().catch((error) => {
  console.error("❌ Error al hacer el backup:", error.message);
  process.exit(1);
});
