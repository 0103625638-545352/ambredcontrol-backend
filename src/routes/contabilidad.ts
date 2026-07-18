// Plan de cuentas + libro diario: contabilidad de partida doble. Los
// asientos por Factura/NotaVenta/NotaCredito/Compra/Pago/MovimientoCaja se
// generan solos desde sus rutas respectivas (ver utils/asientos.ts +
// wiring en cada una) — este router es para administrar el plan de cuentas
// y para todo lo que el sistema NO documenta solo (arriendo, sueldos,
// ajustes de fin de período), vía el asiento manual de POST /asientos.
import { Router, Request, Response } from "express";
import { prisma, empresaActiva, empresaActivaId } from "../db";
import { Prisma } from "@prisma/client";
import { requirePermiso } from "../middleware/auth";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerRangoFechas, fechaLocalDeString } from "../utils/rangoFechas";
import { registrarAuditoria } from "../utils/auditoria";
import { CUENTAS, validarAsientoCuadrado, LineaAsientoInput } from "../utils/contabilidad";
import { crearAsiento } from "../utils/asientos";
import { actualizarCierreContable } from "../utils/empresas";

export const contabilidadRouter = Router();

// "contabilidad" = solo ver (todos los GET); "contabilidad_editar" = crear/
// editar el plan de cuentas, asientos manuales y el cierre contable. Antes
// un único permiso cubría todo el router (ver plan de mejoras) — se separa
// acá, ruta por ruta, mismo patrón que ya usa facturas.ts para
// "facturas_anular"/"facturas_sri" dentro de un mismo router.
const puedeVer = requirePermiso("contabilidad");
const puedeEditar = requirePermiso("contabilidad_editar");

const CODIGOS_PROTEGIDOS = new Set<string>(Object.values(CUENTAS));

const INCLUDE_ASIENTO = {
  lineas: { include: { cuenta: true } },
  usuario: { select: { id: true, nombre: true } },
} as const;

// GET /contabilidad/plan-cuentas
contabilidadRouter.get("/plan-cuentas", puedeVer, async (req: Request, res: Response) => {
  try {
    const cuentas = await prisma.cuentaContable.findMany({ orderBy: { codigo: "asc" } });
    res.json(cuentas);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar el plan de cuentas" });
  }
});

interface CrearCuentaBody {
  codigo: string;
  nombre: string;
  tipo: string;
  naturaleza: string;
  cuentaPadreId?: number;
}

const TIPOS_VALIDOS = ["ACTIVO", "PASIVO", "PATRIMONIO", "INGRESO", "COSTO", "GASTO"];
const NATURALEZAS_VALIDAS = ["DEUDORA", "ACREEDORA"];

// Deriva de qué lado cuadra cada tipo — mismo mapeo que ya usa el frontend
// en ModalCrearCuenta.tsx, replicado acá porque el backend no puede confiar
// en que el cliente siempre lo mande bien (una llamada directa a la API
// podría mandar cualquier combinación).
const NATURALEZA_ESPERADA: Record<string, string> = {
  ACTIVO: "DEUDORA",
  COSTO: "DEUDORA",
  GASTO: "DEUDORA",
  PASIVO: "ACREEDORA",
  PATRIMONIO: "ACREEDORA",
  INGRESO: "ACREEDORA",
};

// POST /contabilidad/plan-cuentas
contabilidadRouter.post("/plan-cuentas", puedeEditar, async (req: Request, res: Response) => {
  const { codigo, nombre, tipo, naturaleza, cuentaPadreId } = req.body as CrearCuentaBody;

  if (!codigo || typeof codigo !== "string" || !codigo.trim()) {
    return res.status(400).json({ error: "codigo es obligatorio" });
  }
  if (!nombre || typeof nombre !== "string" || !nombre.trim()) {
    return res.status(400).json({ error: "nombre es obligatorio" });
  }
  if (!TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ error: `tipo debe ser uno de: ${TIPOS_VALIDOS.join(", ")}` });
  }
  if (!NATURALEZAS_VALIDAS.includes(naturaleza)) {
    return res.status(400).json({ error: `naturaleza debe ser uno de: ${NATURALEZAS_VALIDAS.join(", ")}` });
  }
  if (naturaleza !== NATURALEZA_ESPERADA[tipo]) {
    return res.status(400).json({ error: `Un tipo "${tipo}" siempre es de naturaleza "${NATURALEZA_ESPERADA[tipo]}"` });
  }

  try {
    if (cuentaPadreId) {
      const padre = await prisma.cuentaContable.findUnique({ where: { id: cuentaPadreId } });
      if (!padre) return res.status(404).json({ error: "La cuenta padre no existe" });
    }

    const cuenta = await prisma.cuentaContable.create({
      data: {
        codigo: codigo.trim(),
        nombre: nombre.trim(),
        tipo: tipo as Prisma.CuentaContableCreateInput["tipo"],
        naturaleza: naturaleza as Prisma.CuentaContableCreateInput["naturaleza"],
        cuentaPadreId: cuentaPadreId || undefined,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_CUENTA_CONTABLE",
      entidad: "CuentaContable",
      entidadId: cuenta.id,
      detalle: `${cuenta.codigo} - ${cuenta.nombre}`,
    });

    res.status(201).json(cuenta);
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe una cuenta con ese código" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear la cuenta contable" });
  }
});

// PATCH /contabilidad/plan-cuentas/:id
// Solo nombre/activa: tipo y naturaleza no se editan una vez creada la
// cuenta (cambiarlos rompería la interpretación de todo su histórico de
// líneas ya posteadas).
contabilidadRouter.patch("/plan-cuentas/:id", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre, activa } = req.body as { nombre?: string; activa?: boolean };

    const cuenta = await prisma.cuentaContable.findUnique({ where: { id } });
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada" });

    if (activa === false && CODIGOS_PROTEGIDOS.has(cuenta.codigo)) {
      return res.status(409).json({
        error: `La cuenta ${cuenta.codigo} la usan los generadores automáticos de asientos y no se puede desactivar`,
      });
    }

    const actualizada = await prisma.cuentaContable.update({
      where: { id },
      data: {
        nombre: nombre?.trim() || undefined,
        activa: typeof activa === "boolean" ? activa : undefined,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: activa === false ? "DESACTIVAR_CUENTA_CONTABLE" : "EDITAR_CUENTA_CONTABLE",
      entidad: "CuentaContable",
      entidadId: actualizada.id,
      detalle: `${actualizada.codigo} - ${actualizada.nombre}`,
    });

    res.json(actualizada);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar la cuenta contable" });
  }
});

// GET /contabilidad/libro-diario?desde=&hasta=&page=
contabilidadRouter.get("/libro-diario", puedeVer, async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.AsientoContableWhereInput = rango ? { fecha: rango } : {};
    const opciones = { where, include: INCLUDE_ASIENTO, orderBy: [{ fecha: "desc" as const }, { id: "desc" as const }] };

    if (!paginacion.aplica) {
      const asientos = await prisma.asientoContable.findMany(opciones);
      return res.json(asientos);
    }

    const [asientos, total] = await Promise.all([
      prisma.asientoContable.findMany({ ...opciones, skip: paginacion.skip, take: paginacion.take }),
      prisma.asientoContable.count({ where }),
    ]);
    res.json(respuestaPaginada(asientos, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar el libro diario" });
  }
});

// GET /contabilidad/asientos/:id
contabilidadRouter.get("/asientos/:id", puedeVer, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const asiento = await prisma.asientoContable.findUnique({ where: { id }, include: INCLUDE_ASIENTO });
    if (!asiento) return res.status(404).json({ error: "Asiento no encontrado" });
    res.json(asiento);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar el asiento" });
  }
});

// GET /contabilidad/libro-mayor/:cuentaId?desde=&hasta=
// Movimientos de una cuenta específica + saldo acumulado corriendo. Si viene
// "desde", el saldo arranca desde lo acumulado ANTES de esa fecha (no desde
// cero), para que el saldo mostrado siga siendo el saldo real de la cuenta.
contabilidadRouter.get("/libro-mayor/:cuentaId", puedeVer, async (req: Request, res: Response) => {
  try {
    const cuentaId = Number(req.params.cuentaId);
    const cuenta = await prisma.cuentaContable.findUnique({ where: { id: cuentaId } });
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada" });

    const rango = leerRangoFechas(req);
    const esDeudora = cuenta.naturaleza === "DEUDORA";

    let saldoInicial = new Prisma.Decimal(0);
    if (rango?.gte) {
      const previas = await prisma.lineaAsiento.findMany({
        where: { cuentaId, asiento: { fecha: { lt: rango.gte } } },
        select: { debe: true, haber: true },
      });
      for (const l of previas) {
        saldoInicial = esDeudora ? saldoInicial.add(l.debe).sub(l.haber) : saldoInicial.add(l.haber).sub(l.debe);
      }
    }

    const lineas = await prisma.lineaAsiento.findMany({
      where: { cuentaId, ...(rango ? { asiento: { fecha: rango } } : {}) },
      include: { asiento: { select: { id: true, numero: true, fecha: true, descripcion: true, origen: true } } },
      orderBy: [{ asiento: { fecha: "asc" } }, { id: "asc" }],
    });

    let saldo = saldoInicial;
    const movimientos = lineas.map((l) => {
      saldo = esDeudora ? saldo.add(l.debe).sub(l.haber) : saldo.add(l.haber).sub(l.debe);
      return { ...l, saldoAcumulado: saldo.toFixed(2) };
    });

    res.json({ cuenta, saldoInicial: saldoInicial.toFixed(2), movimientos });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el libro mayor" });
  }
});

// GET /contabilidad/balance-comprobacion?hasta=
// Suma debe/haber de cada cuenta con movimiento hasta la fecha dada (o todo
// el histórico si no se especifica) y deriva el saldo según su naturaleza.
contabilidadRouter.get("/balance-comprobacion", puedeVer, async (req: Request, res: Response) => {
  try {
    const hasta = typeof req.query.hasta === "string" && req.query.hasta ? fechaLocalDeString(req.query.hasta, true) : undefined;

    const [cuentas, sumas] = await Promise.all([
      prisma.cuentaContable.findMany({ orderBy: { codigo: "asc" } }),
      prisma.lineaAsiento.groupBy({
        by: ["cuentaId"],
        _sum: { debe: true, haber: true },
        where: hasta ? { asiento: { fecha: { lte: hasta } } } : {},
      }),
    ]);

    const sumaPorCuenta = new Map(sumas.map((s) => [s.cuentaId, s._sum]));

    const filas = cuentas.map((cuenta) => {
      const suma = sumaPorCuenta.get(cuenta.id);
      const totalDebe = suma?.debe ?? new Prisma.Decimal(0);
      const totalHaber = suma?.haber ?? new Prisma.Decimal(0);
      const saldo = cuenta.naturaleza === "DEUDORA" ? totalDebe.sub(totalHaber) : totalHaber.sub(totalDebe);
      return {
        cuenta,
        totalDebe: totalDebe.toFixed(2),
        totalHaber: totalHaber.toFixed(2),
        saldo: saldo.toFixed(2),
      };
    });

    res.json(filas);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el balance de comprobación" });
  }
});

// Cálculo del estado de resultados para un rango de fechas — extraído a
// función exportada para que también lo reuse el módulo de Nómina
// (utils/utilidades.ts necesita la utilidad neta anual para repartir el
// 15% de utilidades, ver routes/utilidades.ts) sin recalcular el estado de
// resultados desde cero ni hacer una llamada HTTP interna.
export async function calcularEstadoResultados(rango?: { gte?: Date; lte?: Date }) {
  const [cuentas, sumas] = await Promise.all([
    prisma.cuentaContable.findMany({
      where: { tipo: { in: ["INGRESO", "COSTO", "GASTO"] } },
      orderBy: { codigo: "asc" },
    }),
    prisma.lineaAsiento.groupBy({
      by: ["cuentaId"],
      _sum: { debe: true, haber: true },
      where: rango ? { asiento: { fecha: rango } } : {},
    }),
  ]);

  const sumaPorCuenta = new Map(sumas.map((s) => [s.cuentaId, s._sum]));
  const filaDeCuenta = (cuenta: (typeof cuentas)[number]) => {
    const suma = sumaPorCuenta.get(cuenta.id);
    const totalDebe = suma?.debe ?? new Prisma.Decimal(0);
    const totalHaber = suma?.haber ?? new Prisma.Decimal(0);
    const saldo = cuenta.naturaleza === "DEUDORA" ? totalDebe.sub(totalHaber) : totalHaber.sub(totalDebe);
    return { cuenta, saldo: saldo.toFixed(2), saldoDecimal: saldo };
  };

  const ingresos = cuentas.filter((c) => c.tipo === "INGRESO").map(filaDeCuenta);
  const costos = cuentas.filter((c) => c.tipo === "COSTO").map(filaDeCuenta);
  const gastos = cuentas.filter((c) => c.tipo === "GASTO").map(filaDeCuenta);

  const sumar = (filas: ReturnType<typeof filaDeCuenta>[]) =>
    filas.reduce((acc, f) => acc.add(f.saldoDecimal), new Prisma.Decimal(0));
  const totalIngresos = sumar(ingresos);
  const totalCostos = sumar(costos);
  const totalGastos = sumar(gastos);
  const utilidadNeta = totalIngresos.sub(totalCostos).sub(totalGastos);

  const sinDecimalInterno = (filas: ReturnType<typeof filaDeCuenta>[]) => filas.map(({ cuenta, saldo }) => ({ cuenta, saldo }));

  return {
    ingresos: sinDecimalInterno(ingresos),
    costos: sinDecimalInterno(costos),
    gastos: sinDecimalInterno(gastos),
    utilidadNetaDecimal: utilidadNeta,
    resumen: {
      totalIngresos: totalIngresos.toFixed(2),
      totalCostos: totalCostos.toFixed(2),
      totalGastos: totalGastos.toFixed(2),
      utilidadNeta: utilidadNeta.toFixed(2),
    },
  };
}

// GET /contabilidad/estado-resultados?desde=&hasta=
// Ingresos - Costos - Gastos del período — mismo criterio de rango que el
// resto de reportes (leerRangoFechas), agrupando manualmente en memoria
// (mismo estilo que /balance-comprobacion, pero acotado a los 3 tipos que
// entran al estado de resultados).
contabilidadRouter.get("/estado-resultados", puedeVer, async (req: Request, res: Response) => {
  try {
    const rango = leerRangoFechas(req);
    const { utilidadNetaDecimal, ...resultado } = await calcularEstadoResultados(rango);
    res.json(resultado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el estado de resultados" });
  }
});

// GET /contabilidad/balance-general?hasta=
// Activo/Pasivo/Patrimonio con saldo acumulado hasta la fecha (mismo cálculo
// que /balance-comprobacion), más una línea sintética "Utilidad del
// ejercicio" dentro de Patrimonio — el sistema no tiene un asiento de cierre
// de período que traslade Ingresos-Costos-Gastos a Patrimonio (mismo
// espíritu que el costeo periódico de antes), así que se calcula al vuelo
// como acumulado DESDE SIEMPRE hasta "hasta". Como todo asiento en el
// sistema siempre cuadra (ver validarAsientoCuadrado), Activo siempre debe
// dar igual a Pasivo + Patrimonio + Utilidad del ejercicio.
contabilidadRouter.get("/balance-general", puedeVer, async (req: Request, res: Response) => {
  try {
    const hasta = typeof req.query.hasta === "string" && req.query.hasta ? fechaLocalDeString(req.query.hasta, true) : undefined;
    const whereFecha = hasta ? { asiento: { fecha: { lte: hasta } } } : {};

    const [cuentas, sumas] = await Promise.all([
      prisma.cuentaContable.findMany({ orderBy: { codigo: "asc" } }),
      prisma.lineaAsiento.groupBy({ by: ["cuentaId"], _sum: { debe: true, haber: true }, where: whereFecha }),
    ]);

    const sumaPorCuenta = new Map(sumas.map((s) => [s.cuentaId, s._sum]));
    const saldoDe = (cuenta: (typeof cuentas)[number]) => {
      const suma = sumaPorCuenta.get(cuenta.id);
      const totalDebe = suma?.debe ?? new Prisma.Decimal(0);
      const totalHaber = suma?.haber ?? new Prisma.Decimal(0);
      return cuenta.naturaleza === "DEUDORA" ? totalDebe.sub(totalHaber) : totalHaber.sub(totalDebe);
    };

    const filaDeCuenta = (cuenta: (typeof cuentas)[number]) => ({ cuenta, saldo: saldoDe(cuenta).toFixed(2) });

    const activos = cuentas.filter((c) => c.tipo === "ACTIVO").map(filaDeCuenta);
    const pasivos = cuentas.filter((c) => c.tipo === "PASIVO").map(filaDeCuenta);
    const patrimonio = cuentas.filter((c) => c.tipo === "PATRIMONIO").map(filaDeCuenta);

    const sumarSaldos = (tipos: string[]) =>
      cuentas.filter((c) => tipos.includes(c.tipo)).reduce((acc, c) => acc.add(saldoDe(c)), new Prisma.Decimal(0));

    const totalActivo = sumarSaldos(["ACTIVO"]);
    const totalPasivo = sumarSaldos(["PASIVO"]);
    const totalPatrimonio = sumarSaldos(["PATRIMONIO"]);
    // Ingreso/Ingreso son acreedoras (restan al revés) y Costo/Gasto deudoras
    // — sumarSaldos ya respeta la naturaleza de cada una, así que restando
    // directo se obtiene Ingresos - Costos - Gastos.
    const utilidadEjercicio = sumarSaldos(["INGRESO"]).sub(sumarSaldos(["COSTO"])).sub(sumarSaldos(["GASTO"]));

    const totalPasivoMasPatrimonio = totalPasivo.add(totalPatrimonio).add(utilidadEjercicio);

    res.json({
      activos,
      pasivos,
      patrimonio,
      utilidadEjercicio: utilidadEjercicio.toFixed(2),
      totales: {
        activo: totalActivo.toFixed(2),
        pasivoMasPatrimonio: totalPasivoMasPatrimonio.toFixed(2),
        cuadrado: totalActivo.sub(totalPasivoMasPatrimonio).abs().lt(0.01),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al generar el balance general" });
  }
});

// GET /contabilidad/cierre — fecha de cierre contable actual (o null si nada cerrado).
contabilidadRouter.get("/cierre", puedeVer, async (_req: Request, res: Response) => {
  res.json({ cierreContableHasta: empresaActiva().cierreContableHasta ?? null });
});

// PATCH /contabilidad/cierre — fija (o quita, con null) la fecha de cierre.
// No valida contra el pasado/futuro a propósito: un ADMIN puede necesitar
// reabrir un período ya cerrado para corregir algo puntual.
contabilidadRouter.patch("/cierre", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { cierreContableHasta } = req.body as { cierreContableHasta: string | null };
    if (cierreContableHasta !== null && (typeof cierreContableHasta !== "string" || !cierreContableHasta.trim())) {
      return res.status(400).json({ error: "cierreContableHasta debe ser una fecha (YYYY-MM-DD) o null" });
    }

    const empresa = actualizarCierreContable(empresaActivaId(), cierreContableHasta);

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "FIJAR_CIERRE_CONTABLE",
      entidad: "Empresa",
      detalle: cierreContableHasta ? `Cerrado hasta ${cierreContableHasta}` : "Cierre contable removido",
    });

    res.json({ cierreContableHasta: empresa.cierreContableHasta ?? null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar el cierre contable" });
  }
});

interface LineaAsientoManualBody {
  cuentaId: number;
  debe: number;
  haber: number;
  glosa?: string;
}

// POST /contabilidad/asientos
// Asiento manual: para todo lo que el sistema no documenta solo (arriendo,
// sueldos, servicios, aportes de capital, ajustes de fin de período).
contabilidadRouter.post("/asientos", puedeEditar, async (req: Request, res: Response) => {
  const { fecha, descripcion, lineas } = req.body as {
    fecha?: string;
    descripcion: string;
    lineas: LineaAsientoManualBody[];
  };

  if (!descripcion || typeof descripcion !== "string" || !descripcion.trim()) {
    return res.status(400).json({ error: "descripcion es obligatoria" });
  }
  if (!Array.isArray(lineas) || lineas.length < 2) {
    return res.status(400).json({ error: "El asiento necesita al menos 2 líneas" });
  }

  try {
    const cuentaIds = [...new Set(lineas.map((l) => l.cuentaId))];
    const cuentas = await prisma.cuentaContable.findMany({ where: { id: { in: cuentaIds } } });
    const cuentaPorId = new Map(cuentas.map((c) => [c.id, c]));

    for (const l of lineas) {
      const cuenta = cuentaPorId.get(l.cuentaId);
      if (!cuenta) return res.status(404).json({ error: `Cuenta ${l.cuentaId} no encontrada` });
      if (!cuenta.activa) return res.status(400).json({ error: `La cuenta ${cuenta.codigo} está inactiva` });
      if (!cuenta.permiteMovimiento) return res.status(400).json({ error: `La cuenta ${cuenta.codigo} es de agrupación, no admite movimientos` });
      if (typeof l.debe !== "number" || typeof l.haber !== "number" || l.debe < 0 || l.haber < 0) {
        return res.status(400).json({ error: "Cada línea necesita debe y haber numéricos mayores o iguales a 0" });
      }
    }

    const lineasInput: LineaAsientoInput[] = lineas.map((l) => ({
      cuentaCodigo: cuentaPorId.get(l.cuentaId)!.codigo,
      debe: new Prisma.Decimal(l.debe),
      haber: new Prisma.Decimal(l.haber),
      glosa: l.glosa?.trim() || undefined,
    }));

    if (!validarAsientoCuadrado(lineasInput)) {
      return res.status(400).json({ error: "El asiento no cuadra: la suma del Debe debe ser igual a la suma del Haber" });
    }

    const asiento = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const creado = await crearAsiento(tx, {
        origen: "MANUAL",
        descripcion: descripcion.trim(),
        lineas: lineasInput,
        usuarioId: req.usuario!.usuarioId,
        fecha: fecha ? new Date(fecha) : undefined,
      });

      await registrarAuditoria(tx, {
        usuarioId: req.usuario!.usuarioId,
        accion: "CREAR_ASIENTO_MANUAL",
        entidad: "AsientoContable",
        entidadId: creado.id,
        detalle: descripcion.trim(),
      });

      return creado;
    });

    res.status(201).json(asiento);
  } catch (error: any) {
    if (error.message === "PERIODO_CERRADO") {
      return res.status(400).json({ error: "La fecha del asiento cae en un período contable ya cerrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear el asiento manual" });
  }
});
