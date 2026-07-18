// Rol de pagos mensual — un registro por empleado por mes. "Pagar" genera
// su propio asiento contable (partida doble), mismo criterio que ya usa
// Retención con crearPagoConAsiento. No es un comprobante SRI: es un
// documento interno de nómina.
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma, empresaActiva } from "../db";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { calcularAportePersonalIess, calcularAportePatronalIess, calcularFondoReserva, tieneDerechoAFondoReserva } from "../utils/iess";
import { calcularValorHorasSuplementarias, calcularValorHorasExtraordinarias } from "../utils/horasExtras";
import { lineasPorNomina } from "../utils/contabilidad";
import { crearAsiento } from "../utils/asientos";
import { generarRolDePagosPdf } from "../utils/generarRolDePagosPdf";
import { datosEmisorDeEmpresa } from "../utils/empresas";
import { registrarAuditoria } from "../utils/auditoria";
import { requirePermiso } from "../middleware/auth";
import { SELECT_EMPLEADO_SEGURO } from "../utils/empleados";

export const rolDePagosRouter = Router();

const puedeVer = requirePermiso("nomina");
const puedeEditar = requirePermiso("nomina_editar");

// "select" (no "true" plano) para nunca traer pinHash/intentosFallidosPin/
// bloqueadoHastaPin de Empleado sin querer (ver utils/empleados.ts).
const INCLUDE_ROL = { empleado: { select: SELECT_EMPLEADO_SEGURO } } as const;

// GET /nomina/rol-pagos
rolDePagosRouter.get("/", puedeVer, async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const { empleadoId, anio, mes } = req.query;
    const where: Prisma.RolDePagosWhereInput = {
      ...(empleadoId && { empleadoId: Number(empleadoId) }),
      ...(anio && { anio: Number(anio) }),
      ...(mes && { mes: Number(mes) }),
    };
    const opciones = { where, include: INCLUDE_ROL, orderBy: [{ anio: "desc" as const }, { mes: "desc" as const }] };

    if (!paginacion.aplica) {
      const roles = await prisma.rolDePagos.findMany(opciones);
      return res.json(roles);
    }

    const [roles, total] = await Promise.all([
      prisma.rolDePagos.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.rolDePagos.count({ where }),
    ]);
    res.json(respuestaPaginada(roles, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar roles de pago" });
  }
});

interface CrearRolDePagosBody {
  empleadoId: number;
  anio: number;
  mes: number;
  horasSuplementarias?: number;
  horasExtraordinarias?: number;
  otrosIngresos?: number;
  otrosDescuentos?: number;
  otrosDescuentosDetalle?: string;
}

// POST /nomina/rol-pagos
rolDePagosRouter.post("/", puedeEditar, async (req: Request, res: Response) => {
  const { empleadoId, anio, mes, horasSuplementarias, horasExtraordinarias, otrosIngresos, otrosDescuentos, otrosDescuentosDetalle } =
    req.body as CrearRolDePagosBody;

  if (!empleadoId || !anio || !mes || mes < 1 || mes > 12) {
    return res.status(400).json({ error: "empleadoId, anio y mes (1-12) son obligatorios" });
  }

  try {
    const empleado = await prisma.empleado.findUnique({ where: { id: empleadoId } });
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });

    const yaExiste = await prisma.rolDePagos.findUnique({
      where: { empleadoId_anio_mes: { empleadoId, anio, mes } },
    });
    if (yaExiste) return res.status(409).json({ error: `Ya existe un rol de pagos de ${empleado.nombres} ${empleado.apellidos} para ${mes}/${anio}` });

    const sueldoBase = empleado.sueldoMensual;
    const valorHorasSuplementarias = calcularValorHorasSuplementarias(sueldoBase, horasSuplementarias ?? 0);
    const valorHorasExtraordinarias = calcularValorHorasExtraordinarias(sueldoBase, horasExtraordinarias ?? 0);
    const otrosIngresosDecimal = new Prisma.Decimal(otrosIngresos ?? 0);

    // Fondo de reserva mensualizado: solo si el empleado lo eligió Y ya tiene
    // más de 1 año de servicio al último día de este período.
    const finDelPeriodo = new Date(anio, mes, 0);
    const fondoReservaValor =
      empleado.fondoReservaMensualizado && tieneDerechoAFondoReserva(empleado.fechaIngreso, finDelPeriodo)
        ? calcularFondoReserva(sueldoBase)
        : new Prisma.Decimal(0);

    const totalIngresos = sueldoBase.add(valorHorasSuplementarias).add(valorHorasExtraordinarias).add(otrosIngresosDecimal).add(fondoReservaValor);

    const aportePersonalIess = calcularAportePersonalIess(sueldoBase);
    const aportePatronalIess = calcularAportePatronalIess(sueldoBase);
    const otrosDescuentosDecimal = new Prisma.Decimal(otrosDescuentos ?? 0);
    const totalDescuentos = aportePersonalIess.add(otrosDescuentosDecimal);

    const netoAPagar = totalIngresos.sub(totalDescuentos);

    const rol = await prisma.rolDePagos.create({
      data: {
        empleadoId,
        anio,
        mes,
        sueldoBase,
        horasSuplementarias: horasSuplementarias ?? 0,
        horasExtraordinarias: horasExtraordinarias ?? 0,
        valorHorasSuplementarias,
        valorHorasExtraordinarias,
        otrosIngresos: otrosIngresosDecimal,
        fondoReservaValor,
        totalIngresos,
        aportePersonalIess,
        aportePatronalIess,
        otrosDescuentos: otrosDescuentosDecimal,
        otrosDescuentosDetalle: otrosDescuentosDetalle || null,
        totalDescuentos,
        netoAPagar,
      },
      include: INCLUDE_ROL,
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_ROL_DE_PAGOS",
      entidad: "RolDePagos",
      entidadId: rol.id,
      detalle: `Rol de pagos ${mes}/${anio} de ${empleado.nombres} ${empleado.apellidos}: neto $${netoAPagar.toFixed(2)}`,
    });

    res.status(201).json(rol);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el rol de pagos" });
  }
});

// POST /nomina/rol-pagos/:id/pagar
// Body opcional: { formaPago?: "EFECTIVO" | "OTRO" } (default "OTRO" =
// Bancos, lo más común para pagar sueldos).
rolDePagosRouter.post("/:id/pagar", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const formaPago = req.body?.formaPago === "EFECTIVO" ? "EFECTIVO" : "OTRO";

    const rolPagado = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const rol = await tx.rolDePagos.findUnique({ where: { id }, include: INCLUDE_ROL });
      if (!rol) throw new Error("ROL_NO_ENCONTRADO");
      if (rol.estado !== "PENDIENTE") throw new Error("ROL_YA_PAGADO");

      await crearAsiento(tx, {
        origen: "NOMINA",
        origenId: rol.id,
        descripcion: `Rol de pagos ${rol.mes}/${rol.anio} - ${rol.empleado.nombres} ${rol.empleado.apellidos}`,
        lineas: lineasPorNomina({
          sueldoBase: rol.sueldoBase,
          valorHorasSuplementarias: rol.valorHorasSuplementarias,
          valorHorasExtraordinarias: rol.valorHorasExtraordinarias,
          otrosIngresos: rol.otrosIngresos,
          fondoReservaValor: rol.fondoReservaValor,
          aportePersonalIess: rol.aportePersonalIess,
          aportePatronalIess: rol.aportePatronalIess,
          otrosDescuentos: rol.otrosDescuentos,
          netoAPagar: rol.netoAPagar,
          formaPago,
        }),
        usuarioId: req.usuario!.usuarioId,
      });

      return tx.rolDePagos.update({ where: { id }, data: { estado: "PAGADO", fechaPago: new Date() }, include: INCLUDE_ROL });
    });

    res.json(rolPagado);
  } catch (error: any) {
    if (error.message === "ROL_NO_ENCONTRADO") return res.status(404).json({ error: "Rol de pagos no encontrado" });
    if (error.message === "ROL_YA_PAGADO") return res.status(409).json({ error: "Este rol de pagos ya fue pagado" });
    if (typeof error.message === "string" && error.message.startsWith("CUENTA_CONTABLE_NO_ENCONTRADA")) {
      const codigo = error.message.split(":")[1];
      return res.status(400).json({
        error: `Falta crear la cuenta contable ${codigo} en el Plan de Cuentas antes de poder pagar un rol de pagos (ver Contabilidad > Plan de Cuentas).`,
      });
    }
    if (error.message === "PERIODO_CERRADO") {
      return res.status(400).json({ error: "El período contable de esta fecha ya está cerrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al pagar el rol de pagos: " + error.message });
  }
});

// GET /nomina/rol-pagos/:id/pdf
rolDePagosRouter.get("/:id/pdf", puedeVer, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const rol = await prisma.rolDePagos.findUnique({ where: { id }, include: INCLUDE_ROL });
    if (!rol) return res.status(404).json({ error: "Rol de pagos no encontrado" });

    const pdfBytes = await generarRolDePagosPdf(rol, datosEmisorDeEmpresa(empresaActiva()));

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="rol-pagos-${rol.empleado.cedula}-${rol.anio}-${rol.mes}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el PDF: " + error.message });
  }
});
