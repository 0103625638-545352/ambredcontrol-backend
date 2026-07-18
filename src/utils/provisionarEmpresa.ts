// Crea una EMPRESA nueva de punta a punta: base de datos vacía, esquema
// completo (las mismas migraciones que ya corren las demás empresas) y su
// primer usuario administrador — todo automático, disparado desde el botón
// "Crear empresa" del login (ver routes/auth.ts, que exige la clave maestra
// antes de llamar a esto).
import { Client } from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "./auth";
import { generarIdEmpresa, agregarEmpresa, type EmpresaConfig } from "./empresas";

const execFileAsync = promisify(execFile);

export interface DatosNuevaEmpresa {
  nombre: string;
  ruc: string;
  razonSocial: string;
  direccionMatriz: string;
  ambienteSri: "1" | "2";
  establecimiento: string;
  puntoEmision: string;
  obligadoContabilidad: boolean;
  agenteRetencion: boolean;
  adminNombre: string;
  adminUsuario: string;
  adminPassword: string;
}

function nombreBaseDatos(empresaId: string): string {
  // generarIdEmpresa ya deja "empresaId" reducido a [a-z0-9-]+, así que esto
  // sigue siendo seguro para interpolar directo en el SQL de CREATE DATABASE
  // (no puede contener comillas, espacios ni ";").
  return `facturacion_${empresaId.replace(/-/g, "_")}`;
}

function construirUrlBaseDatos(urlAdmin: string, nombreBd: string): string {
  const url = new URL(urlAdmin);
  url.pathname = `/${nombreBd}`;
  return url.toString();
}

async function borrarBaseDatosSiExiste(urlAdmin: string, nombreBd: string): Promise<void> {
  const cliente = new Client({ connectionString: urlAdmin });
  await cliente.connect();
  try {
    await cliente.query(`DROP DATABASE IF EXISTS "${nombreBd}"`);
  } catch (error) {
    console.error(`No se pudo limpiar la base de datos "${nombreBd}" tras un provisionamiento fallido:`, error);
  } finally {
    await cliente.end();
  }
}

export async function provisionarEmpresa(datos: DatosNuevaEmpresa): Promise<EmpresaConfig> {
  const urlAdmin = process.env.DATABASE_ADMIN_URL;
  if (!urlAdmin) {
    throw new Error("DATABASE_ADMIN_URL no está configurado en el .env del servidor");
  }

  const empresaId = generarIdEmpresa(datos.nombre);
  const nombreBd = nombreBaseDatos(empresaId);
  const databaseUrl = construirUrlBaseDatos(urlAdmin, nombreBd);

  // --- 1. Crear la base de datos vacía ---
  const clienteAdmin = new Client({ connectionString: urlAdmin });
  await clienteAdmin.connect();
  try {
    await clienteAdmin.query(`CREATE DATABASE "${nombreBd}"`);
  } finally {
    await clienteAdmin.end();
  }

  try {
    // --- 2. Aplicar TODAS las migraciones existentes (mismo esquema que las demás empresas) ---
    // shell:true hace falta en Windows: "npx" ahí es en realidad "npx.cmd", y
    // los .cmd no son ejecutables nativos — necesitan pasar por cmd.exe (sin
    // esto, execFile falla con "spawn EINVAL").
    await execFileAsync("npx", ["prisma", "migrate", "deploy"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      shell: true,
    });

    // --- 3. Crear el usuario administrador inicial ---
    const prismaTemporal = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      const passwordHash = await hashPassword(datos.adminPassword);
      // La migración de sucursales ya sembró "Sucursal Principal" en esta base
      // de datos recién creada (igual que en cualquier empresa existente) — se
      // la asignamos al admin inicial para que el sistema quede usable desde
      // el día uno, sin un usuario sin sucursal asignada.
      const sucursalPrincipal = await prismaTemporal.sucursal.findFirst();
      await prismaTemporal.usuario.create({
        data: {
          nombre: datos.adminNombre,
          usuario: datos.adminUsuario,
          passwordHash,
          rol: "ADMIN",
          activo: true,
          sucursalId: sucursalPrincipal?.id,
        },
      });
    } finally {
      await prismaTemporal.$disconnect();
    }
  } catch (error) {
    // Si falló a mitad de camino, no dejamos una base de datos huérfana e
    // inutilizable — la limpiamos y dejamos que el error suba tal cual.
    await borrarBaseDatosSiExiste(urlAdmin, nombreBd);
    throw error;
  }

  // --- 4. Registrar la empresa (recién acá: si algo de arriba falló, nunca queda "fantasma" en el registro) ---
  const empresa: EmpresaConfig = {
    id: empresaId,
    nombre: datos.nombre,
    databaseUrl,
    ruc: datos.ruc,
    razonSocial: datos.razonSocial,
    direccionMatriz: datos.direccionMatriz,
    ambienteSri: datos.ambienteSri,
    establecimiento: datos.establecimiento,
    puntoEmision: datos.puntoEmision,
    obligadoContabilidad: datos.obligadoContabilidad,
    agenteRetencion: datos.agenteRetencion,
    // Sin certificado todavía — se configura después desde Ajustes, igual
    // que el logo. Sin él, esta empresa puede usar el sistema con
    // normalidad, solo no puede firmar/enviar comprobantes al SRI todavía.
    certificadoP12Path: `data/${empresaId}/certificado.p12`,
    certificadoP12Password: "",
    carpetaUploads: `data/${empresaId}/uploads`,
    carpetaComprobantes: `data/${empresaId}/comprobantes-autorizados`,
    // Sin destinatario todavía — se configura después desde Ajustes.
    emailResumenDestinatario: "",
    activa: true,
    createdAt: new Date().toISOString(),
  };
  agregarEmpresa(empresa);

  return empresa;
}
