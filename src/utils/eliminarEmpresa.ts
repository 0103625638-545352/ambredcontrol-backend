// Contraparte de provisionarEmpresa.ts: borra una empresa de punta a punta
// (base de datos, carpeta de archivos y entrada en el registro). Es
// irreversible — quien llama a esto (ver routes/auth.ts) ya validó la clave
// maestra del servidor Y credenciales de administrador de ESA empresa
// puntual antes de llegar acá.
import { Client } from "pg";
import * as fs from "fs";
import { cerrarPrismaDeEmpresa } from "../db";
import { eliminarEmpresaDelRegistro, rutaAbsoluta, type EmpresaConfig } from "./empresas";

function nombreBaseDatosDesdeUrl(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, "");
}

export async function eliminarEmpresa(empresa: EmpresaConfig): Promise<void> {
  const urlAdmin = process.env.DATABASE_ADMIN_URL;
  if (!urlAdmin) {
    throw new Error("DATABASE_ADMIN_URL no está configurado en el .env del servidor");
  }

  // 1. Cerrar la conexión cacheada de este proceso (si existe) — Postgres no
  // deja hacer DROP DATABASE mientras alguien sigue conectado a ella.
  await cerrarPrismaDeEmpresa(empresa.id);

  // 2. Borrar la base de datos, forzando el cierre de cualquier OTRA conexión
  // que quedara abierta (ej. una pestaña de Prisma Studio apuntando ahí).
  const nombreBd = nombreBaseDatosDesdeUrl(empresa.databaseUrl);
  const clienteAdmin = new Client({ connectionString: urlAdmin });
  await clienteAdmin.connect();
  try {
    await clienteAdmin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [nombreBd]
    );
    await clienteAdmin.query(`DROP DATABASE IF EXISTS "${nombreBd}"`);
  } finally {
    await clienteAdmin.end();
  }

  // 3. Borrar su carpeta de archivos — SOLO si vive bajo data/<empresaId>/.
  // Nunca tocamos rutas fuera de ahí: así la empresa "principal" (que usa las
  // carpetas históricas en la raíz de backend/) jamás puede perder archivos
  // por error, sin importar qué tenga guardado en su config.
  const prefijoEsperado = `data/${empresa.id}`;
  if (empresa.carpetaUploads.startsWith(prefijoEsperado)) {
    const carpetaDatos = rutaAbsoluta(prefijoEsperado);
    if (fs.existsSync(carpetaDatos)) {
      fs.rmSync(carpetaDatos, { recursive: true, force: true });
    }
  }

  // 4. Sacarla del registro AL FINAL: si algo de arriba falló, la empresa
  // sigue apareciendo en el login en vez de desaparecer con la base de datos
  // todavía viva (o a medio borrar).
  eliminarEmpresaDelRegistro(empresa.id);
}
