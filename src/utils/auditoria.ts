// Registra una acción sensible (anular, editar, desactivar, eliminar) en la
// bitácora de auditoría. Se llama con "prisma" directo (fuera de transacción)
// o con "tx" (dentro de una) según el caso — ambos exponen el mismo método
// .registroAuditoria.create, por eso el parámetro acepta cualquiera de los dos.
import { Prisma, PrismaClient } from "@prisma/client";

export interface DatosAuditoria {
  usuarioId: number;
  accion: string;
  entidad: string;
  entidadId?: number;
  detalle?: string;
}

export async function registrarAuditoria(
  cliente: PrismaClient | Prisma.TransactionClient,
  datos: DatosAuditoria
): Promise<void> {
  await cliente.registroAuditoria.create({ data: datos });
}
