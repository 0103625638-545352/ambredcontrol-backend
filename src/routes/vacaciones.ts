// Vacaciones: saldo disponible calculado (nunca guardado como campo aparte,
// ver utils/vacaciones.ts) + registro de días tomados o pagados en dinero
// sin gozarlos.
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma, empresaActiva } from "../db";
import { calcularDiasVacacionesPorAntiguedad, calcularValorVacaciones } from "../utils/vacaciones";
import { fechaLocalDeString } from "../utils/rangoFechas";
import { generarComprobanteNominaPdf } from "../utils/generarComprobanteNominaPdf";
import { datosEmisorDeEmpresa } from "../utils/empresas";
import { registrarAuditoria } from "../utils/auditoria";
import { requirePermiso } from "../middleware/auth";
import { SELECT_EMPLEADO_SEGURO } from "../utils/empleados";

export const vacacionesRouter = Router();

const puedeVer = requirePermiso("nomina");
const puedeEditar = requirePermiso("nomina_editar");

// "select" (no "true" plano) para nunca traer pinHash/intentosFallidosPin/
// bloqueadoHastaPin de Empleado sin querer (ver utils/empleados.ts).
const INCLUDE_EMPLEADO = { empleado: { select: SELECT_EMPLEADO_SEGURO } } as const;

async function saldoDisponible(empleadoId: number): Promise<{ diasAcumulados: number; diasTomados: number; diasDisponibles: number }> {
  const empleado = await prisma.empleado.findUnique({ where: { id: empleadoId } });
  if (!empleado) throw new Error("EMPLEADO_NO_ENCONTRADO");

  const diasAcumulados = calcularDiasVacacionesPorAntiguedad(empleado.fechaIngreso, empleado.fechaSalida ?? new Date());
  const registros = await prisma.vacacion.findMany({ where: { empleadoId } });
  const diasTomados = registros.reduce((acc, r) => acc + r.diasTomados, 0);

  return { diasAcumulados, diasTomados, diasDisponibles: diasAcumulados - diasTomados };
}

// GET /nomina/vacaciones/:empleadoId/saldo
vacacionesRouter.get("/:empleadoId/saldo", puedeVer, async (req: Request, res: Response) => {
  try {
    const saldo = await saldoDisponible(Number(req.params.empleadoId));
    res.json(saldo);
  } catch (error: any) {
    if (error.message === "EMPLEADO_NO_ENCONTRADO") return res.status(404).json({ error: "Empleado no encontrado" });
    console.error(error);
    res.status(500).json({ error: "Error al calcular el saldo de vacaciones" });
  }
});

// GET /nomina/vacaciones (historial, opcional ?empleadoId=)
vacacionesRouter.get("/", puedeVer, async (req: Request, res: Response) => {
  try {
    const { empleadoId } = req.query;
    const where: Prisma.VacacionWhereInput = empleadoId ? { empleadoId: Number(empleadoId) } : {};
    const vacaciones = await prisma.vacacion.findMany({ where, include: INCLUDE_EMPLEADO, orderBy: { fechaInicio: "desc" } });
    res.json(vacaciones);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar vacaciones" });
  }
});

interface RegistrarVacacionBody {
  empleadoId: number;
  fechaInicio: string;
  fechaFin: string;
  diasTomados: number;
  pagarEnDinero?: boolean; // si true, calcula y guarda valorPagado en vez de asumir que las gozó
}

// POST /nomina/vacaciones
vacacionesRouter.post("/", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { empleadoId, fechaInicio, fechaFin, diasTomados, pagarEnDinero } = req.body as RegistrarVacacionBody;
    if (!empleadoId || !fechaInicio || !fechaFin || !diasTomados || diasTomados <= 0) {
      return res.status(400).json({ error: "empleadoId, fechaInicio, fechaFin y diasTomados (mayor a 0) son obligatorios" });
    }

    const empleado = await prisma.empleado.findUnique({ where: { id: empleadoId } });
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });

    const saldo = await saldoDisponible(empleadoId);
    if (diasTomados > saldo.diasDisponibles) {
      return res.status(400).json({ error: `Este empleado solo tiene ${saldo.diasDisponibles} día(s) de vacaciones disponibles` });
    }

    const valorPagado = pagarEnDinero ? calcularValorVacaciones(empleado.sueldoMensual, diasTomados) : null;

    const vacacion = await prisma.vacacion.create({
      data: {
        empleadoId,
        fechaInicio: fechaLocalDeString(fechaInicio, false),
        fechaFin: fechaLocalDeString(fechaFin, true),
        diasTomados,
        valorPagado,
      },
      include: INCLUDE_EMPLEADO,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "REGISTRAR_VACACION",
      entidad: "Vacacion",
      entidadId: vacacion.id,
      detalle: `${empleado.nombres} ${empleado.apellidos}: ${diasTomados} día(s)${valorPagado ? ` pagados ($${valorPagado.toFixed(2)})` : ""}`,
    });

    res.status(201).json(vacacion);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar las vacaciones" });
  }
});

// GET /nomina/vacaciones/:id/pdf — solo tiene sentido si se pagaron en dinero
vacacionesRouter.get("/:id/pdf", puedeVer, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const vacacion = await prisma.vacacion.findUnique({ where: { id }, include: INCLUDE_EMPLEADO });
    if (!vacacion) return res.status(404).json({ error: "Registro de vacaciones no encontrado" });
    if (!vacacion.valorPagado) return res.status(400).json({ error: "Esta vacación fue gozada, no pagada en dinero — no aplica un comprobante" });

    const pdfBytes = await generarComprobanteNominaPdf(
      "PAGO DE VACACIONES NO GOZADAS",
      `${vacacion.diasTomados} día(s)`,
      vacacion.empleado,
      [["Valor pagado", vacacion.valorPagado]],
      vacacion.valorPagado,
      "TOTAL A PAGAR",
      datosEmisorDeEmpresa(empresaActiva())
    );
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="vacaciones-${vacacion.empleado.cedula}-${id}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el PDF: " + error.message });
  }
});
