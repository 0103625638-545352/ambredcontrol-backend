// Recalcula el caché de Vehiculo.kilometrajeActual — ver el comentario en el
// modelo (schema.prisma): es el mayor kilometraje registrado entre todas las
// cargas de combustible, mantenimientos y usos diarios del vehículo, nunca
// se edita a mano. Se llama desde routes/vehiculos.ts después de crear,
// editar, eliminar, abrir o cerrar cualquiera de esos tres, para que el
// caché nunca quede desactualizado (ej. si se elimina por error la carga
// con el kilometraje más alto, este recalcula y "retrocede" solo al
// siguiente más alto).
import { Prisma, PrismaClient, TipoMantenimientoVehiculo } from "@prisma/client";

export async function recalcularKilometrajeVehiculo(
  cliente: PrismaClient | Prisma.TransactionClient,
  vehiculoId: number
): Promise<void> {
  const [maxCarga, maxMantenimiento, maxUsoInicial, maxUsoFinal] = await Promise.all([
    cliente.cargaCombustible.aggregate({ where: { vehiculoId }, _max: { kilometraje: true } }),
    cliente.mantenimientoVehiculo.aggregate({ where: { vehiculoId }, _max: { kilometraje: true } }),
    cliente.usoVehiculo.aggregate({ where: { vehiculoId }, _max: { kilometrajeInicial: true } }),
    cliente.usoVehiculo.aggregate({ where: { vehiculoId }, _max: { kilometrajeFinal: true } }),
  ]);
  const maximo = Math.max(
    maxCarga._max.kilometraje ?? 0,
    maxMantenimiento._max.kilometraje ?? 0,
    maxUsoInicial._max.kilometrajeInicial ?? 0,
    maxUsoFinal._max.kilometrajeFinal ?? 0
  );

  await cliente.vehiculo.update({
    where: { id: vehiculoId },
    data: { kilometrajeActual: maximo > 0 ? maximo : null },
  });
}

export interface AlertaMantenimientoVehiculo {
  vehiculoId: number;
  placa: string;
  marca: string;
  modelo: string;
  tipo: TipoMantenimientoVehiculo;
  kilometrajeActual: number | null;
  proximoKilometraje: number;
  kmRestantes: number;
  estado: "VENCIDO" | "PROXIMO";
}

// Compara, para cada plan de mantenimiento ACTIVO que matchee "filtroVehiculo",
// el kilometraje actual del vehículo contra el próximo esperado de ese tipo
// (kilometraje del ÚLTIMO mantenimiento de ese tipo + intervaloKm del plan —
// o directamente intervaloKm si nunca se hizo ese mantenimiento) y devuelve
// SOLO los que ya están vencidos o por vencer (dentro de kmAvisoPrevio).
// Reusada por GET /vehiculos/alertas-mantenimiento (todos los vehículos
// activos, vista admin) y por GET /vehiculos/uso/mi-actual (un solo
// vehículo, el que el técnico tiene en uso — sin exigir el permiso
// "vehiculos", ver routes/vehiculos.ts).
export async function calcularAlertasMantenimiento(
  cliente: PrismaClient,
  filtroVehiculo: Prisma.VehiculoWhereInput = { activo: true }
): Promise<AlertaMantenimientoVehiculo[]> {
  const planes = await cliente.planMantenimientoVehiculo.findMany({
    where: { activo: true, vehiculo: filtroVehiculo },
    include: {
      vehiculo: { select: { id: true, placa: true, kilometrajeActual: true, marca: { select: { nombre: true } }, modelo: { select: { nombre: true } } } },
    },
  });

  const alertas = await Promise.all(
    planes.map(async (plan) => {
      const ultimo = await cliente.mantenimientoVehiculo.findFirst({
        where: { vehiculoId: plan.vehiculoId, tipo: plan.tipo },
        orderBy: { kilometraje: "desc" },
        select: { kilometraje: true },
      });
      const baseKilometraje = ultimo?.kilometraje ?? 0;
      const proximoKilometraje = baseKilometraje + plan.intervaloKm;
      const kilometrajeActual = plan.vehiculo.kilometrajeActual ?? 0;
      const kmRestantes = proximoKilometraje - kilometrajeActual;

      if (kmRestantes > plan.kmAvisoPrevio) return null; // todavía falta de sobra, no es una alerta

      const estado: AlertaMantenimientoVehiculo["estado"] = kmRestantes <= 0 ? "VENCIDO" : "PROXIMO";
      return {
        vehiculoId: plan.vehiculo.id,
        placa: plan.vehiculo.placa,
        marca: plan.vehiculo.marca.nombre,
        modelo: plan.vehiculo.modelo.nombre,
        tipo: plan.tipo,
        kilometrajeActual: plan.vehiculo.kilometrajeActual,
        proximoKilometraje,
        kmRestantes,
        estado,
      };
    })
  );

  const soloAlertas = alertas.filter((a): a is NonNullable<typeof a> => a !== null);
  // Vencidos primero, y dentro de cada grupo, los que tienen menos margen.
  soloAlertas.sort((a, b) => (a.estado === b.estado ? a.kmRestantes - b.kmRestantes : a.estado === "VENCIDO" ? -1 : 1));
  return soloAlertas;
}
