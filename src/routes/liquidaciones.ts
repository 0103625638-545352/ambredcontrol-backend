// Liquidación (finiquito) al terminar la relación laboral — es una
// CALCULADORA/reporte, no dispara ningún pago ni asiento automático (ver
// utils/liquidacion.ts): los montos de indemnización/desahucio deben
// confirmarse con un profesional antes de pagarse de verdad.
import { Router, Request, Response } from "express";
import { prisma, empresaActiva } from "../db";
import { calcularDiasVacacionesPorAntiguedad, calcularValorVacaciones } from "../utils/vacaciones";
import { calcularDecimoTercero } from "../utils/decimos";
import { calcularIndemnizacionDespidoIntempestivo, calcularBonificacionDesahucio } from "../utils/liquidacion";
import { fechaLocalDeString } from "../utils/rangoFechas";
import { generarActaFiniquitoPdf } from "../utils/generarActaFiniquitoPdf";
import { datosEmisorDeEmpresa } from "../utils/empresas";
import { registrarAuditoria } from "../utils/auditoria";
import { Prisma } from "@prisma/client";
import { requirePermiso } from "../middleware/auth";
import { SELECT_EMPLEADO_SEGURO } from "../utils/empleados";

export const liquidacionesRouter = Router();

const puedeVer = requirePermiso("nomina");
const puedeEditar = requirePermiso("nomina_editar");

// "select" (no "true" plano) para nunca traer pinHash/intentosFallidosPin/
// bloqueadoHastaPin de Empleado sin querer (ver utils/empleados.ts).
const INCLUDE_EMPLEADO = { empleado: { select: SELECT_EMPLEADO_SEGURO } } as const;

const MOTIVOS_VALIDOS = ["DESPIDO_INTEMPESTIVO", "RENUNCIA_VOLUNTARIA", "MUTUO_ACUERDO", "VISTO_BUENO", "OTRO"];

interface CrearLiquidacionBody {
  empleadoId: number;
  fechaSalida: string;
  motivoSalida: string;
}

// POST /nomina/liquidaciones
liquidacionesRouter.post("/", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { empleadoId, fechaSalida, motivoSalida } = req.body as CrearLiquidacionBody;
    if (!empleadoId || !fechaSalida || !motivoSalida) {
      return res.status(400).json({ error: "empleadoId, fechaSalida y motivoSalida son obligatorios" });
    }
    if (!MOTIVOS_VALIDOS.includes(motivoSalida)) {
      return res.status(400).json({ error: `motivoSalida debe ser uno de: ${MOTIVOS_VALIDOS.join(", ")}` });
    }

    const yaExiste = await prisma.liquidacion.findUnique({ where: { empleadoId } });
    if (yaExiste) return res.status(409).json({ error: "Este empleado ya tiene una liquidación calculada" });

    const empleado = await prisma.empleado.findUnique({ where: { id: empleadoId } });
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });

    const fechaSalidaDate = fechaLocalDeString(fechaSalida, false);
    const msPorAnio = 365.25 * 24 * 60 * 60 * 1000;
    const aniosServicioNum = (fechaSalidaDate.getTime() - empleado.fechaIngreso.getTime()) / msPorAnio;
    const aniosServicio = new Prisma.Decimal(Math.max(aniosServicioNum, 0).toFixed(2));

    // Vacaciones pendientes: mismo cálculo que el saldo disponible normal,
    // acotado a la fecha de salida.
    const diasAcumulados = calcularDiasVacacionesPorAntiguedad(empleado.fechaIngreso, fechaSalidaDate);
    const registrosVacaciones = await prisma.vacacion.findMany({ where: { empleadoId } });
    const diasTomados = registrosVacaciones.reduce((acc, r) => acc + r.diasTomados, 0);
    const vacacionesPendientesDias = Math.max(diasAcumulados - diasTomados, 0);
    const vacacionesPendientesValor = calcularValorVacaciones(empleado.sueldoMensual, vacacionesPendientesDias);

    // Décimo tercero proporcional: se aproxima con el sueldo mensual × meses
    // transcurridos desde el 1-dic anterior (no exige que existan roles de
    // pago previos, a diferencia del cálculo anual completo de decimos.ts).
    const anioActual = fechaSalidaDate.getFullYear();
    const inicioPeriodoDecimoTercero = fechaSalidaDate.getMonth() === 11 ? new Date(anioActual, 11, 1) : new Date(anioActual - 1, 11, 1);
    const desdeDecimoTercero = empleado.fechaIngreso > inicioPeriodoDecimoTercero ? empleado.fechaIngreso : inicioPeriodoDecimoTercero;
    const mesesDecimoTercero = Math.max(
      (fechaSalidaDate.getFullYear() - desdeDecimoTercero.getFullYear()) * 12 + (fechaSalidaDate.getMonth() - desdeDecimoTercero.getMonth()),
      0
    );
    const totalIngresosPeriodoAproximado = empleado.sueldoMensual.mul(mesesDecimoTercero);
    const decimoTerceroProporcional = calcularDecimoTercero(totalIngresosPeriodoAproximado);

    // Décimo cuarto proporcional: NO se calcula automáticamente en esta
    // ronda — a diferencia del décimo tercero (que solo necesita meses
    // transcurridos), el décimo cuarto depende de la región de la sucursal
    // del empleado (ver utils/decimos.ts:rangoDecimoCuarto) y de si ya se
    // le pagó el de este período vía routes/decimos.ts. Se deja en 0 acá
    // para no duplicar esa lógica con datos potencialmente desincronizados;
    // quien calcule la liquidación debe revisar aparte en Décimos si el
    // décimo cuarto del período vigente ya se pagó, y sumarlo a mano al
    // total si no.
    const decimoCuartoProporcional = new Prisma.Decimal(0);

    let indemnizacion = new Prisma.Decimal(0);
    let bonificacionDesahucio = new Prisma.Decimal(0);
    if (motivoSalida === "DESPIDO_INTEMPESTIVO") {
      indemnizacion = calcularIndemnizacionDespidoIntempestivo(empleado.sueldoMensual, aniosServicioNum);
      bonificacionDesahucio = calcularBonificacionDesahucio(empleado.sueldoMensual, aniosServicioNum);
    }

    const totalLiquidacion = vacacionesPendientesValor
      .add(decimoTerceroProporcional)
      .add(decimoCuartoProporcional)
      .add(indemnizacion)
      .add(bonificacionDesahucio);

    const liquidacion = await prisma.liquidacion.create({
      data: {
        empleadoId,
        fechaSalida: fechaSalidaDate,
        motivoSalida,
        aniosServicio,
        vacacionesPendientesDias,
        vacacionesPendientesValor,
        decimoTerceroProporcional,
        decimoCuartoProporcional,
        indemnizacion,
        bonificacionDesahucio,
        totalLiquidacion,
      },
      include: INCLUDE_EMPLEADO,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CALCULAR_LIQUIDACION",
      entidad: "Liquidacion",
      entidadId: liquidacion.id,
      detalle: `Liquidación de ${empleado.nombres} ${empleado.apellidos} (${motivoSalida}): $${totalLiquidacion.toFixed(2)} — PRELIMINAR, verificar antes de pagar`,
    });

    res.status(201).json(liquidacion);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al calcular la liquidación" });
  }
});

// GET /nomina/liquidaciones/:id
liquidacionesRouter.get("/:id", puedeVer, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const liquidacion = await prisma.liquidacion.findUnique({ where: { id }, include: INCLUDE_EMPLEADO });
    if (!liquidacion) return res.status(404).json({ error: "Liquidación no encontrada" });
    res.json(liquidacion);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar la liquidación" });
  }
});

// GET /nomina/liquidaciones — historial
liquidacionesRouter.get("/", puedeVer, async (_req: Request, res: Response) => {
  try {
    const liquidaciones = await prisma.liquidacion.findMany({ include: INCLUDE_EMPLEADO, orderBy: { fechaSalida: "desc" } });
    res.json(liquidaciones);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar liquidaciones" });
  }
});

// GET /nomina/liquidaciones/:id/pdf
liquidacionesRouter.get("/:id/pdf", puedeVer, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const liquidacion = await prisma.liquidacion.findUnique({ where: { id }, include: INCLUDE_EMPLEADO });
    if (!liquidacion) return res.status(404).json({ error: "Liquidación no encontrada" });

    const pdfBytes = await generarActaFiniquitoPdf(liquidacion, datosEmisorDeEmpresa(empresaActiva()));
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="finiquito-${liquidacion.empleado.cedula}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el PDF: " + error.message });
  }
});
