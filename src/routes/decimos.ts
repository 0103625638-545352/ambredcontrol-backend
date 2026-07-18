// Décimo tercer y décimo cuarto sueldo. No generan asiento contable
// automático al pagarse (ver Alcance en el plan de esta ronda) — se
// calculan y quedan listos; el asiento de su pago se registra con el
// asiento MANUAL que ya existe en Contabilidad.
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma, empresaActiva } from "../db";
import { calcularDecimoTercero, calcularDecimoCuarto, rangoDecimoCuarto, calcularMesesLaboradosEnRango, SBU_VIGENTE } from "../utils/decimos";
import { generarComprobanteNominaPdf } from "../utils/generarComprobanteNominaPdf";
import { datosEmisorDeEmpresa } from "../utils/empresas";
import { registrarAuditoria } from "../utils/auditoria";
import { requirePermiso } from "../middleware/auth";
import { SELECT_EMPLEADO_SEGURO } from "../utils/empleados";

export const decimosRouter = Router();

const puedeVer = requirePermiso("nomina");
const puedeEditar = requirePermiso("nomina_editar");

// "select" (no "true" plano) para nunca traer pinHash/intentosFallidosPin/
// bloqueadoHastaPin de Empleado sin querer (ver utils/empleados.ts).
const INCLUDE_EMPLEADO = { empleado: { select: SELECT_EMPLEADO_SEGURO } } as const;

// POST /nomina/decimos/tercero
// Body: { empleadoId, anio, mensualizado? }. anio = año en que se paga
// (período: dic del año anterior a nov de "anio").
decimosRouter.post("/tercero", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { empleadoId, anio, mensualizado } = req.body as { empleadoId: number; anio: number; mensualizado?: boolean };
    if (!empleadoId || !anio) return res.status(400).json({ error: "empleadoId y anio son obligatorios" });

    const empleado = await prisma.empleado.findUnique({ where: { id: empleadoId } });
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });

    const yaExiste = await prisma.decimoTercero.findUnique({ where: { empleadoId_anio: { empleadoId, anio } } });
    if (yaExiste) return res.status(409).json({ error: `Ya existe un décimo tercero calculado para este empleado en ${anio}` });

    // Meses del período dic(anio-1) a nov(anio): [ [anio-1,12], [anio,1]...[anio,11] ]
    const mesesDelPeriodo: { anio: number; mes: number }[] = [{ anio: anio - 1, mes: 12 }];
    for (let mes = 1; mes <= 11; mes++) mesesDelPeriodo.push({ anio, mes });

    const rolesDelPeriodo = await prisma.rolDePagos.findMany({
      where: { empleadoId, OR: mesesDelPeriodo.map((m) => ({ anio: m.anio, mes: m.mes })) },
    });
    const rolesPorClave = new Map(rolesDelPeriodo.map((r) => [`${r.anio}-${r.mes}`, r]));

    let totalIngresosPeriodo = new Prisma.Decimal(0);
    for (const { anio: a, mes } of mesesDelPeriodo) {
      const rol = rolesPorClave.get(`${a}-${mes}`);
      if (rol) {
        totalIngresosPeriodo = totalIngresosPeriodo.add(rol.totalIngresos);
        continue;
      }
      // Sin rol de pagos generado ese mes: usa el sueldo mensual SI el
      // empleado ya estaba activo ese mes (evita contar meses previos a su
      // ingreso o posteriores a su salida).
      const finDeEseMes = new Date(a, mes, 0);
      const inicioDeEseMes = new Date(a, mes - 1, 1);
      const estabaActivo = empleado.fechaIngreso <= finDeEseMes && (!empleado.fechaSalida || empleado.fechaSalida >= inicioDeEseMes);
      if (estabaActivo) totalIngresosPeriodo = totalIngresosPeriodo.add(empleado.sueldoMensual);
    }

    const valor = calcularDecimoTercero(totalIngresosPeriodo);

    const decimo = await prisma.decimoTercero.create({
      data: { empleadoId, anio, totalIngresosPeriodo, valor, mensualizado: mensualizado === true },
      include: INCLUDE_EMPLEADO,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CALCULAR_DECIMO_TERCERO",
      entidad: "DecimoTercero",
      entidadId: decimo.id,
      detalle: `Décimo tercero ${anio} de ${empleado.nombres} ${empleado.apellidos}: $${valor.toFixed(2)}`,
    });

    res.status(201).json(decimo);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al calcular el décimo tercero" });
  }
});

// POST /nomina/decimos/cuarto
// Body: { empleadoId, anio, mensualizado? }. anio = año en que se paga —
// el período/región se toma de la sucursal del empleado.
decimosRouter.post("/cuarto", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { empleadoId, anio, mensualizado } = req.body as { empleadoId: number; anio: number; mensualizado?: boolean };
    if (!empleadoId || !anio) return res.status(400).json({ error: "empleadoId y anio son obligatorios" });

    const empleado = await prisma.empleado.findUnique({ where: { id: empleadoId }, include: { sucursal: true } });
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });

    const yaExiste = await prisma.decimoCuarto.findUnique({ where: { empleadoId_anio: { empleadoId, anio } } });
    if (yaExiste) return res.status(409).json({ error: `Ya existe un décimo cuarto calculado para este empleado en ${anio}` });

    const region = empleado.sucursal?.region ?? "SIERRA_ORIENTE";
    const { desde, hasta } = rangoDecimoCuarto(anio, region);
    const mesesLaborados = calcularMesesLaboradosEnRango(empleado.fechaIngreso, empleado.fechaSalida, desde, hasta);
    const valor = calcularDecimoCuarto(SBU_VIGENTE, mesesLaborados);

    const decimo = await prisma.decimoCuarto.create({
      data: { empleadoId, anio, region, mesesLaborados, valor, mensualizado: mensualizado === true },
      include: INCLUDE_EMPLEADO,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CALCULAR_DECIMO_CUARTO",
      entidad: "DecimoCuarto",
      entidadId: decimo.id,
      detalle: `Décimo cuarto ${anio} de ${empleado.nombres} ${empleado.apellidos}: $${valor.toFixed(2)}`,
    });

    res.status(201).json(decimo);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al calcular el décimo cuarto" });
  }
});

// GET /nomina/decimos/tercero (historial, opcional ?empleadoId=&anio=)
decimosRouter.get("/tercero", puedeVer, async (req: Request, res: Response) => {
  try {
    const { empleadoId, anio } = req.query;
    const where: Prisma.DecimoTerceroWhereInput = {
      ...(empleadoId && { empleadoId: Number(empleadoId) }),
      ...(anio && { anio: Number(anio) }),
    };
    const decimos = await prisma.decimoTercero.findMany({ where, include: INCLUDE_EMPLEADO, orderBy: { anio: "desc" } });
    res.json(decimos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar décimos terceros" });
  }
});

// GET /nomina/decimos/cuarto (historial, opcional ?empleadoId=&anio=)
decimosRouter.get("/cuarto", puedeVer, async (req: Request, res: Response) => {
  try {
    const { empleadoId, anio } = req.query;
    const where: Prisma.DecimoCuartoWhereInput = {
      ...(empleadoId && { empleadoId: Number(empleadoId) }),
      ...(anio && { anio: Number(anio) }),
    };
    const decimos = await prisma.decimoCuarto.findMany({ where, include: INCLUDE_EMPLEADO, orderBy: { anio: "desc" } });
    res.json(decimos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar décimos cuartos" });
  }
});

// POST /nomina/decimos/tercero/:id/pagar
decimosRouter.post("/tercero/:id/pagar", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const decimo = await prisma.decimoTercero.findUnique({ where: { id } });
    if (!decimo) return res.status(404).json({ error: "Décimo tercero no encontrado" });
    if (decimo.estado === "PAGADO") return res.status(409).json({ error: "Ya fue pagado" });
    const actualizado = await prisma.decimoTercero.update({ where: { id }, data: { estado: "PAGADO", fechaPago: new Date() } });
    res.json(actualizado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al marcar el décimo tercero como pagado" });
  }
});

// POST /nomina/decimos/cuarto/:id/pagar
decimosRouter.post("/cuarto/:id/pagar", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const decimo = await prisma.decimoCuarto.findUnique({ where: { id } });
    if (!decimo) return res.status(404).json({ error: "Décimo cuarto no encontrado" });
    if (decimo.estado === "PAGADO") return res.status(409).json({ error: "Ya fue pagado" });
    const actualizado = await prisma.decimoCuarto.update({ where: { id }, data: { estado: "PAGADO", fechaPago: new Date() } });
    res.json(actualizado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al marcar el décimo cuarto como pagado" });
  }
});

// GET /nomina/decimos/tercero/:id/pdf
decimosRouter.get("/tercero/:id/pdf", puedeVer, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const decimo = await prisma.decimoTercero.findUnique({ where: { id }, include: INCLUDE_EMPLEADO });
    if (!decimo) return res.status(404).json({ error: "Décimo tercero no encontrado" });

    const pdfBytes = await generarComprobanteNominaPdf(
      "DÉCIMO TERCER SUELDO",
      `Período ${decimo.anio - 1}-12 a ${decimo.anio}-11`,
      decimo.empleado,
      [["Total percibido en el período", decimo.totalIngresosPeriodo], ["Décimo tercero (÷12)", decimo.valor]],
      decimo.valor,
      "TOTAL A PAGAR",
      datosEmisorDeEmpresa(empresaActiva())
    );
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="decimo-tercero-${decimo.empleado.cedula}-${decimo.anio}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el PDF: " + error.message });
  }
});

// GET /nomina/decimos/cuarto/:id/pdf
decimosRouter.get("/cuarto/:id/pdf", puedeVer, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const decimo = await prisma.decimoCuarto.findUnique({ where: { id }, include: INCLUDE_EMPLEADO });
    if (!decimo) return res.status(404).json({ error: "Décimo cuarto no encontrado" });

    const pdfBytes = await generarComprobanteNominaPdf(
      "DÉCIMO CUARTO SUELDO",
      `Año ${decimo.anio} — ${decimo.mesesLaborados} mes(es) laborados — Región: ${decimo.region}`,
      decimo.empleado,
      [["Décimo cuarto proporcional", decimo.valor]],
      decimo.valor,
      "TOTAL A PAGAR",
      datosEmisorDeEmpresa(empresaActiva())
    );
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="decimo-cuarto-${decimo.empleado.cedula}-${decimo.anio}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el PDF: " + error.message });
  }
});
