// Conciliación bancaria de los cobros de internet: se sube el extracto del
// banco (el navegador lo lee y manda las filas ya interpretadas), el sistema
// sugiere a qué cliente corresponde cada transferencia (ver
// utils/conciliacion.ts) y, con lo que la persona confirme, registra cada
// pago EXACTAMENTE igual que el botón "Registrar pago" de Facturación de
// Internet (registrarPagoDeFactura / registrarCobroSinFactura): misma
// reactivación del servicio, mismos asientos contables, misma auditoría.
// Gateado por el permiso "mikrotik" en index.ts (el mismo de Facturación de
// Internet).
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { conciliarMovimiento, referenciaDeMovimiento, interpretarMonto, type ClienteCandidato, type MovimientoBanco } from "../utils/conciliacion";
import { ventanaCicloActual, enPrimerCiclo } from "../utils/gestionServicioInternet";
import { registrarPagoDeFactura, registrarCobroSinFactura } from "./facturas";
import { promocionesVigentesHoy, descuentoParaCliente } from "./facturasInternet";
import { registrarAuditoria } from "../utils/auditoria";

export const conciliacionBancariaRouter = Router();

const MAX_MOVIMIENTOS = 2000;

function leerMovimientos(cuerpo: any): MovimientoBanco[] {
  const lista = Array.isArray(cuerpo?.movimientos) ? cuerpo.movimientos.slice(0, MAX_MOVIMIENTOS) : [];
  return lista
    .map((m: any, i: number) => ({
      fila: Number.isInteger(m?.fila) ? m.fila : i + 1,
      fecha: typeof m?.fecha === "string" && m.fecha.trim() ? m.fecha.trim().slice(0, 30) : null,
      descripcion: typeof m?.descripcion === "string" ? m.descripcion.slice(0, 500) : "",
      monto: interpretarMonto(m?.monto) ?? NaN,
      referencia: m?.referencia != null && String(m.referencia).trim() ? String(m.referencia).trim().slice(0, 80) : null,
    }))
    .filter((m: MovimientoBanco) => Number.isFinite(m.monto));
}

async function clientesCandidatos(): Promise<(ClienteCandidato & { telefono: string | null; plan: string })[]> {
  const clientes = await prisma.cliente.findMany({
    where: { activo: true, planInternetId: { not: null } },
    select: {
      id: true,
      razonSocial: true,
      identificacion: true,
      telefono: true,
      fechaContrato: true,
      createdAt: true,
      planInternet: { select: { id: true, nombre: true, precio: true, productoId: true } },
    },
  });
  const hoy = new Date();
  const promos = await promocionesVigentesHoy(hoy);

  // "¿Ya pagó este ciclo?" en lote — mismo criterio que pagoDeEsteCiclo
  // (utils/gestionServicioInternet.ts) pero con dos consultas en total.
  const desde = new Date(hoy.getTime() - 62 * 24 * 3600_000);
  const ids = clientes.map((c) => c.id);
  const [facturasPagadas, cobros] = await Promise.all([
    prisma.factura.findMany({
      where: { clienteId: { in: ids }, estadoPago: "PAGADA", fechaEmision: { gte: desde } },
      select: { clienteId: true, fechaEmision: true, detalles: { select: { productoId: true } } },
    }),
    prisma.pago.findMany({ where: { clienteId: { in: ids }, facturaId: null, fecha: { gte: desde } }, select: { clienteId: true, fecha: true } }),
  ]);

  return clientes.map((c) => {
    const plan = c.planInternet!;
    const { descuento } = descuentoParaCliente(promos, c, plan, hoy);
    const montos = [plan.precio.toNumber()];
    if (descuento) montos.push(plan.precio.sub(descuento).toNumber());
    const { inicio, fin } = ventanaCicloActual(c);
    const pagado =
      facturasPagadas.some((f) => f.clienteId === c.id && f.fechaEmision >= inicio && f.fechaEmision < fin && f.detalles.some((d) => d.productoId === plan.productoId)) ||
      cobros.some((p) => p.clienteId === c.id && p.fecha >= inicio && p.fecha < fin);
    return {
      id: c.id,
      razonSocial: c.razonSocial,
      identificacion: c.identificacion,
      telefono: c.telefono,
      plan: plan.nombre,
      montosEsperados: montos,
      pendienteEsteCiclo: !pagado && !enPrimerCiclo(c),
    };
  });
}

// POST /conciliacion-bancaria/analizar
// Body: { movimientos: [{ fila, fecha, descripcion, monto, referencia }] }
conciliacionBancariaRouter.post("/analizar", async (req: Request, res: Response) => {
  try {
    const movimientos = leerMovimientos(req.body);
    if (movimientos.length === 0) return res.status(400).json({ error: "No llegó ningún movimiento con monto válido" });

    const clientes = await clientesCandidatos();
    const porId = new Map(clientes.map((c) => [c.id, c]));

    const referencias = movimientos.map(referenciaDeMovimiento);
    const yaRegistrados = await prisma.pago.findMany({ where: { referencia: { in: referencias } }, select: { referencia: true, clienteId: true, fecha: true } });
    const registradoPorReferencia = new Map(yaRegistrados.map((p) => [p.referencia, p]));

    const resumen = (id: number) => {
      const c = porId.get(id)!;
      return { id: c.id, razonSocial: c.razonSocial, identificacion: c.identificacion, plan: c.plan, montosEsperados: c.montosEsperados, pendienteEsteCiclo: c.pendienteEsteCiclo };
    };

    res.json(
      movimientos.map((m, i) => {
        const referencia = referencias[i];
        const previo = registradoPorReferencia.get(referencia);
        if (previo) {
          return { ...m, referenciaPago: referencia, estado: "YA_REGISTRADO", sugerido: null, candidatos: [], registradoEl: previo.fecha };
        }
        const r = conciliarMovimiento(m, clientes);
        return {
          ...m,
          referenciaPago: referencia,
          estado: r.estado,
          sugerido: r.sugerido ? { ...r.sugerido, cliente: resumen(r.sugerido.clienteId) } : null,
          candidatos: r.candidatos.map((c) => ({ ...c, cliente: resumen(c.clienteId) })),
        };
      })
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al analizar el extracto" });
  }
});

// POST /conciliacion-bancaria/registrar
// Body: { cuentaBancariaId, pagos: [{ fila, clienteId, monto, referenciaPago }] }
// Registra uno por uno; un error en una fila no detiene las demás.
conciliacionBancariaRouter.post("/registrar", async (req: Request, res: Response) => {
  const cuentaBancariaId = req.body.cuentaBancariaId ? Number(req.body.cuentaBancariaId) : undefined;
  const pagos: any[] = Array.isArray(req.body.pagos) ? req.body.pagos.slice(0, MAX_MOVIMIENTOS) : [];
  if (pagos.length === 0) return res.status(400).json({ error: "No hay pagos para registrar" });
  if (!cuentaBancariaId) return res.status(400).json({ error: "Elegí la cuenta bancaria a la que llegaron las transferencias" });

  const resultados: { fila: number; ok: boolean; mensaje: string }[] = [];
  for (const p of pagos) {
    const fila = Number(p.fila) || 0;
    const clienteId = Number(p.clienteId);
    const monto = Number(p.monto);
    const referencia = typeof p.referenciaPago === "string" ? p.referenciaPago.slice(0, 120) : undefined;
    try {
      if (!clienteId || !(monto > 0)) throw new Error("Cliente o monto inválido");
      if (referencia && (await prisma.pago.findFirst({ where: { referencia }, select: { id: true } }))) {
        resultados.push({ fila, ok: false, mensaje: "Este movimiento ya estaba registrado" });
        continue;
      }
      const cliente = await prisma.cliente.findUnique({ where: { id: clienteId }, include: { planInternet: true } });
      if (!cliente?.planInternet) throw new Error("El cliente no tiene plan de internet");

      const facturaPendiente = cliente.planInternet.productoId
        ? await prisma.factura.findFirst({
            where: { clienteId, detalles: { some: { productoId: cliente.planInternet.productoId } }, estadoPago: { not: "PAGADA" }, estado: { not: "ANULADA" } },
            orderBy: { fechaEmision: "desc" },
          })
        : null;
      const datos = { monto, formaPago: "TRANSFERENCIA", referencia, cuentaBancariaId };
      const resultado = facturaPendiente
        ? await registrarPagoDeFactura(facturaPendiente.id, datos, req.usuario!.usuarioId)
        : await registrarCobroSinFactura(clienteId, datos, req.usuario!.usuarioId);
      const aviso = (resultado as any).avisoInternet;
      resultados.push({ fila, ok: true, mensaje: `${cliente.razonSocial}: $${new Prisma.Decimal(monto).toFixed(2)} registrado${aviso ? ` (${aviso})` : ""}` });
    } catch (error: any) {
      resultados.push({ fila, ok: false, mensaje: error?.message || "No se pudo registrar" });
    }
  }

  const registrados = resultados.filter((r) => r.ok).length;
  await registrarAuditoria(prisma, {
    usuarioId: req.usuario!.usuarioId,
    accion: "CONCILIACION_BANCARIA",
    entidad: "Pago",
    detalle: `${registrados} de ${pagos.length} transferencia(s) registradas desde el extracto bancario`,
  });
  res.json({ registrados, resultados });
});
