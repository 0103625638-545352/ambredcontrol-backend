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
import { CAMPOS_CIFRADOS, cifrar, descifrar, estaCifrado, cifradoActivo, transformarCampos } from "./utils/cifrado";

// Cifra al escribir y descifra al leer las credenciales de los equipos de red
// (ver utils/cifrado.ts) — en un solo lugar, para que ninguna ruta tenga que
// acordarse de hacerlo. Solo cubre consultas DIRECTAS a esos modelos
// (prisma.nodoRed.findUnique, etc.); un include desde otro modelo devuelve
// el valor cifrado, y por eso todo el código que se conecta a un equipo lo
// vuelve a leer por su id (ver obtenerConexion en utils/mikrotik.ts).
function descifrarResultado(resultado: any, campos: string[]): any {
  if (Array.isArray(resultado)) return resultado.map((r) => descifrarResultado(r, campos));
  if (!resultado || typeof resultado !== "object") return resultado;
  for (const campo of campos) {
    if (campo in resultado) resultado[campo] = descifrar(resultado[campo]);
  }
  return resultado;
}

const extensionCifrado = {
  name: "cifrado-credenciales-equipos",
  query: Object.fromEntries(
    Object.entries(CAMPOS_CIFRADOS).map(([modelo, campos]) => [
      modelo,
      {
        async $allOperations({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          const a = { ...args };
          if (a.data) a.data = transformarCampos(a.data, campos, cifrar);
          if (a.create) a.create = transformarCampos(a.create, campos, cifrar);
          if (a.update) a.update = transformarCampos(a.update, campos, cifrar);
          return descifrarResultado(await query(a), campos);
        },
      },
    ])
  ),
};

// Migración única y automática: cifra las credenciales que todavía estén en
// texto plano (las que existían antes de activar CLAVE_CIFRADO_EQUIPOS). Se
// llama al arrancar el servidor, por empresa; es idempotente — lo ya cifrado
// se salta. Usa un cliente SIN la extensión para poder ver el valor crudo.
export async function cifrarCredencialesExistentes(empresaId: string): Promise<number> {
  if (!cifradoActivo()) return 0;
  const empresa = obtenerEmpresa(empresaId);
  if (!empresa) return 0;
  const crudo = new PrismaClient({ datasourceUrl: empresa.databaseUrl }) as any;
  let actualizados = 0;
  try {
    for (const [modelo, campos] of Object.entries(CAMPOS_CIFRADOS)) {
      const select = Object.fromEntries([["id", true], ...campos.map((c) => [c, true])]);
      const filas: any[] = await crudo[modelo].findMany({ select });
      for (const fila of filas) {
        const data: Record<string, string> = {};
        for (const campo of campos) {
          const valor = fila[campo];
          if (typeof valor === "string" && valor !== "" && !estaCifrado(valor)) data[campo] = cifrar(valor) as string;
        }
        if (Object.keys(data).length > 0) {
          await crudo[modelo].update({ where: { id: fila.id }, data });
          actualizados++;
        }
      }
    }
  } finally {
    await crudo.$disconnect();
  }
  return actualizados;
}

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

  // El tipo extendido es compatible en tiempo de ejecución con PrismaClient
  // (mismos modelos y métodos) — se castea para no tener que cambiar el tipo
  // de "prisma" en los ~60 archivos que lo importan.
  cliente = new PrismaClient({ datasourceUrl: empresa.databaseUrl }).$extends(extensionCifrado as any) as unknown as PrismaClient;
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
