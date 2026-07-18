// Reparto de utilidades (Art. 97 Código del Trabajo): 15% de la utilidad
// líquida anual de la empresa, dividido en 10% (proporcional a días
// trabajados) + 5% (proporcional a cargas familiares). Funciones puras,
// mismo estilo que utils/iess.ts — la utilidad neta de la empresa se
// obtiene reusando el cálculo que ya existe en
// GET /contabilidad/estado-resultados (ver routes/utilidades.ts), esto
// solo reparte el monto ya calculado.
import { Prisma } from "@prisma/client";

const PORCENTAJE_UTILIDADES = 15;
const PORCENTAJE_POR_DIAS = 10;
const PORCENTAJE_POR_CARGAS = 5;

export interface EmpleadoParaReparto {
  empleadoId: number;
  diasTrabajados: number;
  cargasFamiliares: number;
}

export interface RepartoUtilidadEmpleado {
  empleadoId: number;
  diasTrabajados: number;
  valorPorDias: Prisma.Decimal;
  valorPorCargas: Prisma.Decimal;
  totalEmpleado: Prisma.Decimal;
}

// Días que un empleado trabajó DENTRO de un año calendario específico —
// recorta por fecha de ingreso/salida si cayeron dentro de ese año.
export function calcularDiasTrabajadosEnAnio(fechaIngreso: Date, fechaSalida: Date | null, anio: number): number {
  const inicioAnio = new Date(anio, 0, 1);
  const finAnio = new Date(anio, 11, 31);
  const desde = fechaIngreso > inicioAnio ? fechaIngreso : inicioAnio;
  const hasta = fechaSalida && fechaSalida < finAnio ? fechaSalida : finAnio;
  if (hasta < desde) return 0;
  const msPorDia = 24 * 60 * 60 * 1000;
  return Math.round((hasta.getTime() - desde.getTime()) / msPorDia) + 1;
}

export function calcularMonto15Porciento(utilidadNetaEmpresa: Prisma.Decimal): Prisma.Decimal {
  return utilidadNetaEmpresa.mul(PORCENTAJE_UTILIDADES).div(100);
}

// Reparte el 15% de la utilidad neta entre los empleados: 10% proporcional
// a los días trabajados en el año por TODOS los empleados juntos, 5%
// proporcional a las cargas familiares declaradas por TODOS los empleados
// juntos (si nadie tiene cargas familiares, ese 5% no se reparte a nadie —
// no hay una regla que lo redistribuya al 10%, así lo exige la fórmula
// legal de dos bolsas independientes).
export function repartirUtilidades(
  utilidadNetaEmpresa: Prisma.Decimal,
  empleados: EmpleadoParaReparto[]
): RepartoUtilidadEmpleado[] {
  const montoPorDias = utilidadNetaEmpresa.mul(PORCENTAJE_POR_DIAS).div(100);
  const montoPorCargas = utilidadNetaEmpresa.mul(PORCENTAJE_POR_CARGAS).div(100);

  const totalDias = empleados.reduce((acc, e) => acc + e.diasTrabajados, 0);
  const totalCargas = empleados.reduce((acc, e) => acc + e.cargasFamiliares, 0);

  return empleados.map((e) => {
    const valorPorDias = totalDias > 0 ? montoPorDias.mul(e.diasTrabajados).div(totalDias) : new Prisma.Decimal(0);
    const valorPorCargas = totalCargas > 0 ? montoPorCargas.mul(e.cargasFamiliares).div(totalCargas) : new Prisma.Decimal(0);
    return {
      empleadoId: e.empleadoId,
      diasTrabajados: e.diasTrabajados,
      valorPorDias,
      valorPorCargas,
      totalEmpleado: valorPorDias.add(valorPorCargas),
    };
  });
}
