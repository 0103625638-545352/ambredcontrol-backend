// Ciclo de pago↔servicio del ISP: un cliente de internet debe pagar la
// factura de SU PLAN dentro de su ciclo en curso — si no lo hace antes de su
// día límite, se suspende solo; si paga (aunque sea tarde), se reactiva
// solo. Reusa el MISMO mecanismo de siempre (address-list "Suspendido" en el
// Mikrotik de su nodo, ver utils/mikrotik.ts) — nada de esto reemplaza los
// botones manuales de Suspender/Reactivar de ClientesPage.tsx, que siguen
// funcionando igual (un admin puede suspender por cualquier otro motivo, o
// reactivar antes de que llegue el pago).
//
// El día límite YA NO es necesariamente el mismo para todos los clientes:
// si el cliente tiene Cliente.fechaContrato cargada, su ciclo se ancla al
// DÍA DEL MES de esa fecha (ej. firmó el 12 → se le valida/corta el 12 de
// cada mes), sin importar el día de corte general de la empresa. Un cliente
// SIN fechaContrato (el caso de los que ya existían antes de este cambio, o
// de cualquiera al que todavía no se le cargó) sigue exactamente con el
// comportamiento de siempre: el día de corte único de la empresa y el ciclo
// calendario (mes completo).
//
// Tanto suspenderClientePorIp como reactivarClientePorIp ya son IDEMPOTENTES
// (no hacen nada si el cliente ya está en el estado pedido) — por eso
// reconciliarClienteInternet() se puede llamar tantas veces como haga falta
// (cada pago, y además una vez por ciclo del job) sin ningún efecto raro.
import { prisma, empresaActiva } from "../db";
import { suspenderClientePorIp, reactivarClientePorIp } from "./mikrotik";
import { cicloCorteInternet } from "./empresas";

interface AncoraCiclo {
  fechaContrato: Date | null;
}

// "Día X del mes" con tope en el último día real de ese mes — evita que un
// cliente que firmó el 31 (o el 29/30) se corra sola al mes siguiente en
// febrero/abril/etc. por el desborde normal de JS Date.
function diaDelMesConTope(anio: number, mesIndice0: number, dia: number): Date {
  const ultimoDiaDelMes = new Date(anio, mesIndice0 + 1, 0).getDate();
  return new Date(anio, mesIndice0, Math.min(dia, ultimoDiaDelMes));
}

// Día del mes hasta el cual se tolera no haber pagado todavía — pasado este
// día, un cliente sin la factura de su plan PAGADA en su ciclo se suspende
// solo. Por cliente (fechaContrato) si está cargada; si no, el valor único
// editable por empresa desde Ajustes (ver PUT /configuracion/empresa).
function diaLimitePago(cliente: AncoraCiclo): number {
  if (cliente.fechaContrato) {
    // Mismo tope de diaDelMesConTope: un cliente que firmó el 31 tiene como
    // límite el último día real del mes en curso (ej. 30 en abril/junio/
    // septiembre/noviembre, 28/29 en febrero).
    const hoy = new Date();
    const ultimoDiaDelMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
    return Math.min(cliente.fechaContrato.getDate(), ultimoDiaDelMes);
  }
  return cicloCorteInternet(empresaActiva()).fin;
}

// La fecha (no solo el día del mes) del límite de pago EN EL MES EN CURSO —
// el mismo valor contra el que se compara "new Date().getDate() >
// diaLimitePago(cliente)" más abajo para decidir la suspensión, pero como
// Date completo para poder restarle la fecha de hoy (ver
// utils/vencimientos.ts) y saber cuántos días faltan. Usada por el
// recordatorio de vencimiento (jobs/recordatorioVencimientoInternet.ts) —
// nunca por la suspensión misma, que sigue comparando el número de día
// directamente.
export function fechaLimitePago(cliente: AncoraCiclo): Date {
  const hoy = new Date();
  return diaDelMesConTope(hoy.getFullYear(), hoy.getMonth(), diaLimitePago(cliente));
}

// Ventana [inicio, fin) del ciclo de pago EN CURSO para este cliente. Con
// fechaContrato: ancla en su día del mes — si hoy ya pasó ese día este mes,
// el ciclo abrió este mes ese día; si no, abrió el mes anterior ese día. Sin
// fechaContrato: el ciclo es el mes calendario completo (comportamiento de
// siempre).
export function ventanaCicloActual(cliente: AncoraCiclo): { inicio: Date; fin: Date } {
  const hoy = new Date();

  if (cliente.fechaContrato) {
    const diaCorte = cliente.fechaContrato.getDate();
    const inicio =
      hoy.getDate() >= diaCorte
        ? diaDelMesConTope(hoy.getFullYear(), hoy.getMonth(), diaCorte)
        : diaDelMesConTope(hoy.getFullYear(), hoy.getMonth() - 1, diaCorte);
    const fin = diaDelMesConTope(inicio.getFullYear(), inicio.getMonth() + 1, diaCorte);
    return { inicio, fin };
  }

  const inicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1);
  return { inicio, fin };
}

// Un cliente recién firmado no se suspende en su propio primer ciclo,
// aunque ya haya pasado su día de corte — todavía no tuvo su primera
// oportunidad real de facturación/pago (el admin recién lo está instalando).
// Con fechaContrato: hasta que pase un ciclo completo desde esa fecha. Sin
// ella: mismo criterio de siempre (creado este mes calendario).
export function enPrimerCiclo(cliente: AncoraCiclo & { createdAt: Date }): boolean {
  const hoy = new Date();
  if (cliente.fechaContrato) {
    const finPrimerCiclo = diaDelMesConTope(
      cliente.fechaContrato.getFullYear(),
      cliente.fechaContrato.getMonth() + 1,
      cliente.fechaContrato.getDate()
    );
    return hoy < finPrimerCiclo;
  }
  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  return cliente.createdAt >= inicioMes;
}

// "Pagó este ciclo" cubre DOS casos, a propósito (ver la conversación que
// llevó a esto: con miles de clientes no es viable facturar antes de poder
// cobrar) — o bien:
//  (a) ya existe la factura del plan Y está PAGADA (el flujo de siempre:
//      Facturar, después Registrar pago), o
//  (b) todavía no existe la factura, pero YA se registró el cobro por
//      adelantado (Pago.clienteId puesto, facturaId todavía null — ver
//      POST /facturas-internet/:clienteId/pago) — el servicio se reactiva
//      con el cobro, sin esperar a que alguien pase por "Facturar a todos
//      los pagados" unos días después.
export async function pagoDeEsteCiclo(clienteId: number, productoId: number, cliente: AncoraCiclo): Promise<boolean> {
  const { inicio, fin } = ventanaCicloActual(cliente);

  const facturaPagada = await prisma.factura.findFirst({
    where: {
      clienteId,
      detalles: { some: { productoId } },
      estadoPago: "PAGADA",
      fechaEmision: { gte: inicio, lt: fin },
    },
    select: { id: true },
  });
  if (facturaPagada) return true;

  const cobroAdelantado = await prisma.pago.findFirst({
    where: { clienteId, facturaId: null, fecha: { gte: inicio, lt: fin } },
    select: { id: true },
  });
  return cobroAdelantado !== null;
}

// Historial de suspensiones/reactivaciones (ver EventoServicioInternet en
// schema.prisma) — best-effort: si falla el registro, nunca debe deshacer ni
// bloquear el cambio que ya se hizo en el router.
export async function registrarEventoServicioInternet(clienteId: number, tipo: "SUSPENDIDO" | "REACTIVADO", origen: "AUTOMATICO" | "MANUAL"): Promise<void> {
  try {
    await prisma.eventoServicioInternet.create({ data: { clienteId, tipo, origen } });
  } catch (error: any) {
    console.error(`[servicio-internet] No se pudo registrar el evento ${tipo} del cliente ${clienteId}:`, error.message);
  }
}

export type AccionReconciliacion = "REACTIVADO" | "SUSPENDIDO" | "SIN_CAMBIOS" | "NO_APLICA";

export interface ResultadoReconciliacion {
  accion: AccionReconciliacion;
  error?: string;
}

// Cliente mínimo que hace falta para reconciliar — el llamador decide cómo
// lo carga (con o sin el resto de campos de Cliente).
interface ClienteParaReconciliar {
  id: number;
  razonSocial: string;
  nodoId: number | null;
  direccionIp: string | null;
  planInternet: { productoId: number | null } | null;
  prorrogaHasta: Date | null;
  fechaContrato: Date | null;
  createdAt: Date;
}

export async function reconciliarClienteInternet(cliente: ClienteParaReconciliar): Promise<ResultadoReconciliacion> {
  // Sin nodo/IP/producto del plan no hay a qué router sincronizar — nada
  // que hacer (ej. cliente recién creado, todavía sin datos de instalación).
  if (!cliente.nodoId || !cliente.direccionIp || !cliente.planInternet?.productoId) {
    return { accion: "NO_APLICA" };
  }

  try {
    const pagado = await pagoDeEsteCiclo(cliente.id, cliente.planInternet.productoId, cliente);

    if (pagado) {
      // La prórroga ya cumplió su propósito — se limpia para que no quede
      // una fecha vieja dando vueltas en la ficha del cliente el ciclo que
      // viene (sin efecto real, porque ya habrá quedado en el pasado, pero
      // confunde si alguien la mira).
      if (cliente.prorrogaHasta) {
        await prisma.cliente.update({ where: { id: cliente.id }, data: { prorrogaHasta: null } });
      }
      const cambio = await reactivarClientePorIp(cliente.nodoId, cliente.direccionIp);
      if (cambio) await registrarEventoServicioInternet(cliente.id, "REACTIVADO", "AUTOMATICO");
      return { accion: "REACTIVADO" };
    }

    if (enPrimerCiclo(cliente)) {
      return { accion: "NO_APLICA" };
    }

    const enProrroga = cliente.prorrogaHasta && cliente.prorrogaHasta >= new Date();
    if (!enProrroga && new Date().getDate() > diaLimitePago(cliente)) {
      const cambio = await suspenderClientePorIp(cliente.nodoId, cliente.direccionIp, `Suspensión automática por falta de pago — ${cliente.razonSocial}`);
      if (cambio) await registrarEventoServicioInternet(cliente.id, "SUSPENDIDO", "AUTOMATICO");
      return { accion: "SUSPENDIDO" };
    }

    return { accion: "SIN_CAMBIOS" };
  } catch (error: any) {
    // Best-effort: un router apagado/inalcanzable no debe tumbar el registro
    // del pago (ver routes/facturas.ts) ni el resto del ciclo del job (ver
    // jobs/suspensionInternetPorFaltaPago.ts) — se reintenta solo la próxima
    // vez que corra cualquiera de los dos.
    return { accion: "NO_APLICA", error: error?.message || "No se pudo sincronizar con el Mikrotik" };
  }
}
