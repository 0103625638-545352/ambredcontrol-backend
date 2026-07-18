// Respaldo diario de la base de datos de cada empresa — corre DENTRO del
// backend (utils/backupBaseDatos.ts hace el pg_dump real), no depende de que
// un programador de tareas externo siga vivo. Si un respaldo falla, avisa
// por correo de inmediato (además de quedar reflejado en el resumen diario y
// el Dashboard vía backupAtrasado — ver utils/alertasNegocio.ts).
//
// Mismo criterio que jobs/resumenDiario.ts: NO corre de inmediato al
// arrancar el servidor (correr en cada reinicio duplicaría intentos sin
// relación con la hora configurada), solo revisa cada 15 minutos si ya es la
// hora y si no se ejecutó todavía hoy.
//
// A propósito, este job NO usa ejecutarConEmpresa/AsyncLocalStorage: nunca
// llama a "prisma.*" (pg_dump habla directo con Postgres por la cadena de
// conexión), así que le alcanza con los campos planos de EmpresaConfig que
// ya da listarEmpresas().
import { listarEmpresas } from "../utils/empresas";
import { ejecutarBackupDeEmpresa } from "../utils/backupBaseDatos";
import { enviarCorreoTextoPlano } from "../utils/email";

const QUINCE_MINUTOS_MS = 15 * 60_000;

let ultimaFechaEjecutada: string | null = null;

function fechaLocalYMD(fecha: Date): string {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function debeEjecutarAhora(): boolean {
  const horaConfigurada = Number(process.env.BACKUP_DB_HORA);
  if (Number.isNaN(horaConfigurada)) return false;

  const ahora = new Date();
  if (ahora.getHours() !== horaConfigurada) return false;

  const hoy = fechaLocalYMD(ahora);
  return hoy !== ultimaFechaEjecutada;
}

async function respaldarTodasLasEmpresas(): Promise<void> {
  if (!process.env.BACKUP_DB_PATH) {
    console.log("[backup-db] BACKUP_DB_PATH no configurado — se omite el respaldo automático.");
    return;
  }

  for (const empresa of listarEmpresas()) {
    try {
      const resultado = await ejecutarBackupDeEmpresa({ id: empresa.id, databaseUrl: empresa.databaseUrl });
      if (!resultado.ok) {
        console.error(`[backup-db] Falló el respaldo de "${empresa.nombre}":`, resultado.error);
        const destinatario = (empresa.emailResumenDestinatario || "").trim();
        if (destinatario) {
          await enviarCorreoTextoPlano({
            destinatario,
            asunto: `⚠ Falló el respaldo de base de datos — ${empresa.nombre}`,
            textoPlano: [
              `El respaldo automático de la base de datos de "${empresa.nombre}" falló hoy.`,
              "",
              `Error: ${resultado.error}`,
              "",
              "Revisa BACKUP_DB_PATH, la conexión a PostgreSQL y que pg_dump esté disponible en el servidor.",
            ].join("\n"),
          });
        }
      } else {
        console.log(`[backup-db] Respaldo de "${empresa.nombre}" completado: ${resultado.archivo}`);
      }
    } catch (error: any) {
      console.error(`[backup-db] Error inesperado respaldando "${empresa.nombre}":`, error.message);
    }
  }
}

async function revisarSiTocaEjecutar() {
  if (!debeEjecutarAhora()) return;

  ultimaFechaEjecutada = fechaLocalYMD(new Date());
  console.log("[backup-db] Ejecutando el respaldo diario de todas las empresas...");
  await respaldarTodasLasEmpresas();
}

export function iniciarBackupDiario(): void {
  console.log("[backup-db] Job activado: revisa cada 15 minutos si toca ejecutar el respaldo diario.");
  setInterval(revisarSiTocaEjecutar, QUINCE_MINUTOS_MS);
}
