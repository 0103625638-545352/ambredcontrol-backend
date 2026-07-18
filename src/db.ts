// Multiempresa: cada empresa tiene su PROPIA base de datos (ver
// utils/empresas.ts), así que ya no existe un único PrismaClient global.
//
// En vez de eso, cacheamos una instancia de PrismaClient por empresa (nunca
// una por request — cada instancia abre su propio pool de conexiones, así
// que reabrirla en cada petición agotaría las conexiones disponibles de
// Postgres) y usamos AsyncLocalStorage para que CUALQUIER archivo pueda
// seguir escribiendo simplemente:
//
//   import { prisma } from "../db";
//   await prisma.producto.findMany(...)
//
// exactamente como antes — "prisma" ahora es un Proxy que reenvía cada
// llamada al cliente de la empresa activa en el request actual. Esto evita
// tener que tocar los ~20 archivos de rutas que ya usaban "prisma" así.
// requireAuth (ver middleware/auth.ts) es quien entra a ese contexto al
// principio de cada request autenticado; el job en segundo plano
// (jobs/reintentoAutorizacionSri.ts) entra una vez por empresa, a mano.
//
// El contexto guarda también el "empresaId" (no solo el PrismaClient): así,
// código que necesita datos de la empresa (RUC, certificado, carpetas — ver
// utils/empresas.ts) puede pedirlos con empresaActivaId(), sin que cada
// función tenga que recibir el empresaId como parámetro explícito.
import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaClient } from "@prisma/client";
import { obtenerEmpresa, type EmpresaConfig } from "./utils/empresas";

interface ContextoEmpresa {
  empresaId: string;
  prisma: PrismaClient;
}

const almacenContexto = new AsyncLocalStorage<ContextoEmpresa>();
const clientesPorEmpresa = new Map<string, PrismaClient>();

export function obtenerPrismaDeEmpresa(empresaId: string): PrismaClient {
  let cliente = clientesPorEmpresa.get(empresaId);
  if (cliente) return cliente;

  const empresa = obtenerEmpresa(empresaId);
  if (!empresa) {
    throw new Error(`Empresa desconocida o inactiva: "${empresaId}"`);
  }

  cliente = new PrismaClient({ datasourceUrl: empresa.databaseUrl });
  clientesPorEmpresa.set(empresaId, cliente);
  return cliente;
}

// Libera la conexión cacheada de una empresa (si existe) y la saca del mapa
// — hace falta ANTES de poder borrar su base de datos: Postgres no deja
// hacer DROP DATABASE mientras alguien sigue conectado a ella.
export async function cerrarPrismaDeEmpresa(empresaId: string): Promise<void> {
  const cliente = clientesPorEmpresa.get(empresaId);
  if (!cliente) return;
  clientesPorEmpresa.delete(empresaId);
  await cliente.$disconnect();
}

// Ejecuta "fn" con "empresaId" como contexto activo — todo lo que corra
// DENTRO de fn (incluido cualquier código async que dispare, sin importar
// cuántos await tenga) ve automáticamente el "prisma" y el empresaId correctos.
export function ejecutarConEmpresa<T>(empresaId: string, fn: () => T): T {
  const prisma = obtenerPrismaDeEmpresa(empresaId);
  return almacenContexto.run({ empresaId, prisma }, fn);
}

function contextoActivo(): ContextoEmpresa {
  const contexto = almacenContexto.getStore();
  if (!contexto) {
    throw new Error(
      "No hay una empresa activa en este contexto. ¿Falta pasar por requireAuth, o por ejecutarConEmpresa() en un job en segundo plano?"
    );
  }
  return contexto;
}

export function empresaActivaId(): string {
  return contextoActivo().empresaId;
}

// La config completa (RUC, certificado, carpetas...) de la empresa activa en
// este contexto — para las rutas/jobs que arman el XML/PDF/firma del SRI.
export function empresaActiva(): EmpresaConfig {
  const empresa = obtenerEmpresa(contextoActivo().empresaId);
  if (!empresa) {
    throw new Error(`La empresa activa "${contextoActivo().empresaId}" ya no existe en el registro`);
  }
  return empresa;
}

// Proxy: cada acceso a una propiedad (prisma.factura, prisma.$transaction, ...)
// se resuelve contra el cliente de la empresa activa AL MOMENTO de la llamada,
// no al importar el módulo — así "prisma" sigue siendo un solo objeto estable
// que cualquier archivo puede importar una vez, arriba del todo.
//
// OJO con el "this": "prisma.$transaction(cb)" se invoca con this = prisma
// (el Proxy), no this = cliente real — y $transaction (como casi todos los
// métodos de PrismaClient) depende de su estado interno vía "this". Por eso,
// cuando la propiedad resuelta es una función, la devolvemos ATADA (.bind) al
// cliente real. Las propiedades que son objetos (prisma.factura, etc.) no
// necesitan esto: una vez devuelto ese objeto real, sus propios métodos
// (prisma.factura.findMany) se llaman directo sobre él, sin volver a pasar
// por este Proxy.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const cliente = contextoActivo().prisma as any;
    const valor = cliente[prop];
    return typeof valor === "function" ? valor.bind(cliente) : valor;
  },
}) as PrismaClient;
