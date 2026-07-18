// Reparto anual de utilidades (15% de la utilidad neta de la empresa,
//10% por días trabajados + 5% por cargas familiares). Reusa el cálculo de
// utilidad neta de GET /contabilidad/estado-resultados en vez de
// recalcular el estado de resultados desde cero.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { calcularEstadoResultados } from "./contabilidad";
import { calcularDiasTrabajadosEnAnio, calcularMonto15Porciento, repartirUtilidades } from "../utils/utilidades";
import { registrarAuditoria } from "../utils/auditoria";
import { requirePermiso } from "../middleware/auth";
import { SELECT_EMPLEADO_SEGURO } from "../utils/empleados";

export const utilidadesRouter = Router();

const puedeVer = requirePermiso("nomina");
const puedeEditar = requirePermiso("nomina_editar");

// "select" (no "true" plano) para nunca traer pinHash/intentosFallidosPin/
// bloqueadoHastaPin de Empleado sin querer (ver utils/empleados.ts).
const INCLUDE_DETALLES = { detalles: { include: { empleado: { select: SELECT_EMPLEADO_SEGURO } } } } as const;

// POST /nomina/utilidades/calcular
// Body: { anio }. Reparte entre todos los empleados que trabajaron al
// menos un día dentro de "anio" (activos ese año, sin importar si siguen
// activos hoy).
utilidadesRouter.post("/calcular", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { anio } = req.body as { anio: number };
    if (!anio) return res.status(400).json({ error: "anio es obligatorio" });

    const yaExiste = await prisma.utilidad.findUnique({ where: { anio } });
    if (yaExiste) return res.status(409).json({ error: `Ya se calcularon las utilidades de ${anio}` });

    const inicioAnio = new Date(anio, 0, 1, 0, 0, 0, 0);
    const finAnio = new Date(anio, 11, 31, 23, 59, 59, 999);
    const { utilidadNetaDecimal } = await calcularEstadoResultados({ gte: inicioAnio, lte: finAnio });

    if (utilidadNetaDecimal.lte(0)) {
      return res.status(400).json({ error: `La utilidad neta de ${anio} no es positiva ($${utilidadNetaDecimal.toFixed(2)}) — no hay nada que repartir` });
    }

    // Empleados que trabajaron al menos un día dentro de "anio": ingresaron
    // antes de que termine el año Y (siguen activos o salieron durante/después de que empezó el año).
    const empleados = await prisma.empleado.findMany({
      where: { fechaIngreso: { lte: finAnio }, OR: [{ fechaSalida: null }, { fechaSalida: { gte: inicioAnio } }] },
    });

    const empleadosParaReparto = empleados.map((e) => ({
      empleadoId: e.id,
      diasTrabajados: calcularDiasTrabajadosEnAnio(e.fechaIngreso, e.fechaSalida, anio),
      cargasFamiliares: e.cargasFamiliares,
    }));

    const reparto = repartirUtilidades(utilidadNetaDecimal, empleadosParaReparto);
    const monto15Porciento = calcularMonto15Porciento(utilidadNetaDecimal);

    const utilidad = await prisma.utilidad.create({
      data: {
        anio,
        utilidadNetaEmpresa: utilidadNetaDecimal,
        monto15Porciento,
        detalles: {
          create: reparto.map((r) => ({
            empleadoId: r.empleadoId,
            diasTrabajados: r.diasTrabajados,
            valorPorDias: r.valorPorDias,
            valorPorCargas: r.valorPorCargas,
            totalEmpleado: r.totalEmpleado,
          })),
        },
      },
      include: INCLUDE_DETALLES,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CALCULAR_UTILIDADES",
      entidad: "Utilidad",
      entidadId: utilidad.id,
      detalle: `Utilidades ${anio}: $${monto15Porciento.toFixed(2)} repartidos entre ${reparto.length} empleado(s)`,
    });

    res.status(201).json(utilidad);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al calcular las utilidades" });
  }
});

// GET /nomina/utilidades/:anio
utilidadesRouter.get("/:anio", puedeVer, async (req: Request, res: Response) => {
  try {
    const anio = Number(req.params.anio);
    const utilidad = await prisma.utilidad.findUnique({
      where: { anio },
      include: INCLUDE_DETALLES,
    });
    if (!utilidad) return res.status(404).json({ error: "No se han calculado las utilidades de ese año" });
    res.json(utilidad);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar las utilidades" });
  }
});

// GET /nomina/utilidades — historial de años calculados
utilidadesRouter.get("/", puedeVer, async (_req: Request, res: Response) => {
  try {
    const utilidades = await prisma.utilidad.findMany({ orderBy: { anio: "desc" } });
    res.json(utilidades);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las utilidades" });
  }
});
