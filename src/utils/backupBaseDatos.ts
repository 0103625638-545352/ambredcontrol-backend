// Respaldo automático de la base de datos de cada empresa, disparado por el
// propio backend (jobs/backupDiario.ts) en vez de depender solo de un
// programador de tareas externo (backend/scripts/backup-db.ps1,
// backend/backup-completo.ts, o el cron documentado en DESPLIEGUE.md — esos
// 3 mecanismos siguen siendo válidos como respaldo del respaldo, pero si el
// programador externo se cae en silencio, este job y el estado que guarda
// acá son lo que permite darse cuenta a tiempo).
//
// Para restaurar en una emergencia: `pg_dump` corre sin "-Fc", así que el
// resultado es SQL plano comprimido — se restaura con
//   gunzip -c archivo.sql.gz | psql "$DATABASE_URL"
// contra una base de datos que ya exista (esto no incluye "--create").
import { spawn } from "child_process";
import * as zlib from "zlib";
import * as fs from "fs";
import * as path from "path";

const TAMANO_MINIMO_DUMP_VALIDO = 1024; // 1KB — un dump exitoso pero vacío/truncado es peor que un fallo visible

const RUTA_ESTADO = path.join(process.cwd(), "backups", "estado-respaldo-db.json");

export interface EstadoBackupEmpresa {
  ultimoExitoso: string | null;
  ultimoError: string | null;
  ultimoIntento: string | null;
  archivo: string | null;
}

const ESTADO_VACIO: EstadoBackupEmpresa = { ultimoExitoso: null, ultimoError: null, ultimoIntento: null, archivo: null };

type RegistroEstados = Record<string, EstadoBackupEmpresa>;

// Vive en disco LOCAL (backend/backups/, ya en .gitignore), nunca dentro de
// BACKUP_DB_PATH — esa ruta puede ser una unidad de red intermitente, y no
// queremos que una lectura/escritura de estado lenta o fallida se confunda
// con "el respaldo en sí falló".
function leerEstados(): RegistroEstados {
  if (!fs.existsSync(RUTA_ESTADO)) return {};
  try {
    return JSON.parse(fs.readFileSync(RUTA_ESTADO, "utf-8"));
  } catch {
    return {};
  }
}

function guardarEstado(empresaId: string, estado: EstadoBackupEmpresa): void {
  const estados = leerEstados();
  estados[empresaId] = estado;
  fs.mkdirSync(path.dirname(RUTA_ESTADO), { recursive: true });
  fs.writeFileSync(RUTA_ESTADO, JSON.stringify(estados, null, 2), "utf-8");
}

export function estadoBackup(empresaId: string): EstadoBackupEmpresa {
  return leerEstados()[empresaId] ?? ESTADO_VACIO;
}

export function backupAtrasado(estado: EstadoBackupEmpresa): boolean {
  if (!estado.ultimoExitoso) return true;
  const horasDesde = (Date.now() - new Date(estado.ultimoExitoso).getTime()) / (1000 * 60 * 60);
  return horasDesde > Number(process.env.BACKUP_DB_ALERTA_HORAS || 30);
}

function timestamp(): string {
  const ahora = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${ahora.getFullYear()}${pad(ahora.getMonth() + 1)}${pad(ahora.getDate())}_${pad(ahora.getHours())}${pad(ahora.getMinutes())}${pad(ahora.getSeconds())}`;
}

// Vuelca la base de datos de "databaseUrl" comprimida en gzip directo a
// "rutaSalida", sin pasar por un archivo .sql intermedio. Usa spawn (no
// execFile) para poder canalizar el stdout de pg_dump a través de
// zlib.createGzip() sin acumular todo el dump en memoria.
function volcarComprimido(databaseUrl: string, rutaSalida: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const binarioPgDump = process.env.PG_DUMP_PATH || "pg_dump";
    const proceso = spawn(binarioPgDump, [databaseUrl, "--no-owner", "--no-privileges"]);

    let stderr = "";
    proceso.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // El proceso hijo y el stream de salida a disco terminan de forma
    // independiente y en cualquier orden (el proceso puede "close"-ar antes
    // de que gzip+disco terminen de vaciar el buffer, o después) — hay que
    // esperar a los DOS antes de resolver/rechazar, sin asumir un orden.
    let liquidado = false;
    let procesoTerminado = false;
    let streamCerrado = false;
    let codigoSalida: number | null = null;
    let errorFinal: Error | null = null;

    function intentarFinalizar() {
      if (liquidado || !procesoTerminado || !streamCerrado) return;
      liquidado = true;
      if (errorFinal) return reject(errorFinal);
      if (codigoSalida !== 0) return reject(new Error(stderr.trim() || `pg_dump terminó con código ${codigoSalida}`));
      resolve();
    }

    // Necesario además de "close": si el binario no existe en el PATH,
    // "close" nunca llega con información útil (o no llega en absoluto).
    proceso.on("error", (error) => {
      if (liquidado) return;
      liquidado = true;
      reject(new Error(`No se pudo ejecutar "${binarioPgDump}": ${error.message}`));
    });

    proceso.on("close", (codigo) => {
      codigoSalida = codigo;
      procesoTerminado = true;
      intentarFinalizar();
    });

    const salida = fs.createWriteStream(rutaSalida);
    const gzip = zlib.createGzip();

    gzip.on("error", (error) => {
      errorFinal = errorFinal ?? error;
    });
    salida.on("error", (error) => {
      errorFinal = errorFinal ?? error;
    });

    proceso.stdout.pipe(gzip).pipe(salida);

    salida.on("close", () => {
      streamCerrado = true;
      intentarFinalizar();
    });
  });
}

function limpiarBackupsViejos(carpetaEmpresa: string, empresaId: string): void {
  const diasRetencion = Number(process.env.BACKUP_DB_DIAS_RETENCION) || 14;
  const ahora = Date.now();
  let archivos: string[];
  try {
    archivos = fs.readdirSync(carpetaEmpresa).filter((f) => f.startsWith(`${empresaId}_`) && f.endsWith(".sql.gz"));
  } catch {
    return;
  }

  for (const archivo of archivos) {
    const rutaCompleta = path.join(carpetaEmpresa, archivo);
    try {
      const antiguedadDias = (ahora - fs.statSync(rutaCompleta).mtimeMs) / (1000 * 60 * 60 * 24);
      if (antiguedadDias > diasRetencion) {
        fs.unlinkSync(rutaCompleta);
      }
    } catch {
      // Otro proceso pudo haber borrado/tocado este archivo al mismo tiempo — no es motivo para abortar la limpieza.
    }
  }
}

// Guarda contra que el job diario y el botón manual de Ajustes corran un
// pg_dump en paralelo para la misma empresa.
const empresasRespaldandoAhora = new Set<string>();

export async function ejecutarBackupDeEmpresa(empresa: { id: string; databaseUrl: string }): Promise<{ ok: boolean; archivo?: string; error?: string }> {
  const raiz = process.env.BACKUP_DB_PATH;
  if (!raiz) {
    return { ok: false, error: "BACKUP_DB_PATH no configurado" };
  }

  if (empresasRespaldandoAhora.has(empresa.id)) {
    return { ok: false, error: "Ya hay un respaldo en curso para esta empresa" };
  }
  empresasRespaldandoAhora.add(empresa.id);

  const carpetaEmpresa = path.join(raiz, empresa.id);
  const nombreArchivo = `${empresa.id}_${timestamp()}.sql.gz`;
  const rutaSalida = path.join(carpetaEmpresa, nombreArchivo);
  const ahoraIso = new Date().toISOString();

  try {
    fs.mkdirSync(carpetaEmpresa, { recursive: true });
    await volcarComprimido(empresa.databaseUrl, rutaSalida);

    const tamano = fs.statSync(rutaSalida).size;
    if (tamano < TAMANO_MINIMO_DUMP_VALIDO) {
      throw new Error(`El archivo de respaldo quedó sospechosamente pequeño (${tamano} bytes) — se descarta`);
    }

    limpiarBackupsViejos(carpetaEmpresa, empresa.id);
    guardarEstado(empresa.id, { ultimoExitoso: ahoraIso, ultimoError: null, ultimoIntento: ahoraIso, archivo: nombreArchivo });
    return { ok: true, archivo: nombreArchivo };
  } catch (error: any) {
    if (fs.existsSync(rutaSalida)) {
      try {
        fs.unlinkSync(rutaSalida);
      } catch {
        // best-effort
      }
    }
    // Nunca guardar/mostrar la cadena de conexión (lleva la contraseña de Postgres).
    const mensaje = String(error.message || error).replaceAll(empresa.databaseUrl, "<cadena de conexión omitida>");
    const estadoPrevio = estadoBackup(empresa.id);
    guardarEstado(empresa.id, { ...estadoPrevio, ultimoError: mensaje, ultimoIntento: ahoraIso });
    return { ok: false, error: mensaje };
  } finally {
    empresasRespaldandoAhora.delete(empresa.id);
  }
}
