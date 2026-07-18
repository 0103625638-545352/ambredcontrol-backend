// Corte automático de clientes de internet que no pagaron a tiempo (y
// reconexión automática de los que sí) — ver utils/gestionServicioInternet.ts
// para la regla exacta (factura del plan PAGADA este mes, día límite
// configurable). Corre cada cierto tiempo, para TODAS las empresas
// registradas — mismo criterio multiempresa que jobs/reintentoAutorizacionSri.ts.
//
// A diferencia de esos jobs de SRI, acá no hace falta ningún "una vez por
// día" con caché de fecha: reconciliarClienteInternet() es idempotente
// (suspender/reactivar no hacen nada si el cliente ya está en ese estado),
// así que repetir el chequeo varias veces al día no tiene ningún efecto
// raro — solo hace que un router que estuvo apagado se ponga al día antes.
import { prisma, ejecutarConEmpresa } from "../db";
import { listarEmpresas } from "../utils/empresas";
import { reconciliarClienteInternet } from "../utils/gestionServicioInternet";

const UN_MINUTO_MS = 60_000;
const INTERVALO_MS = (Number(process.env.ISP_SUSPENSION_INTERVALO_MINUTOS) || 60) * UN_MINUTO_MS;

// Evita que dos corridas se pisen si una empresa con muchos clientes/routers
// lentos tarda más que el intervalo entre corridas.
let corriendoActualmente = false;

async function reconciliarClientesDeLaEmpresa() {
  // El "todavía muy nuevo, no se suspende en su propio primer ciclo" ya no
  // se filtra acá con una sola fecha para todos — cada cliente puede tener
  // su propio ciclo (ver Cliente.fechaContrato), así que esa decisión vive
  // adentro de reconciliarClienteInternet() (utils/gestionServicioInternet.ts).
  const clientes = await prisma.cliente.findMany({
    where: { planInternetId: { not: null }, nodoId: { not: null }, direccionIp: { not: null } },
    select: {
      id: true,
      razonSocial: true,
      nodoId: true,
      direccionIp: true,
      planInternet: { select: { productoId: true } },
      prorrogaHasta: true,
      fechaContrato: true,
      createdAt: true,
    },
  });

  for (const cliente of clientes) {
    const resultado = await reconciliarClienteInternet(cliente);
    if (resultado.accion === "SUSPENDIDO") {
      console.log(`[suspension-internet] ${cliente.razonSocial} suspendido por falta de pago.`);
    } else if (resultado.accion === "REACTIVADO") {
      console.log(`[suspension-internet] ${cliente.razonSocial} reactivado (ya pagó este mes).`);
    } else if (resultado.error) {
      console.error(`[suspension-internet] ${cliente.razonSocial}: ${resultado.error}`);
    }
  }
}

async function correrCicloDeSuspension() {
  if (corriendoActualmente) {
    console.log("[suspension-internet] La corrida anterior todavía no termina, se salta este ciclo.");
    return;
  }

  corriendoActualmente = true;
  try {
    for (const empresa of listarEmpresas()) {
      await ejecutarConEmpresa(empresa.id, reconciliarClientesDeLaEmpresa);
    }
  } catch (error: any) {
    console.error("[suspension-internet] Error inesperado en el ciclo de suspensión:", error.message);
  } finally {
    corriendoActualmente = false;
  }
}

export function iniciarSuspensionInternetPorFaltaPago(): void {
  const minutos = INTERVALO_MS / UN_MINUTO_MS;
  // El día límite ya no es un único valor global (antes venía de
  // ISP_DIA_LIMITE_PAGO en .env) — ahora es editable por empresa desde
  // Ajustes (ver utils/empresas.ts), así que acá ya no hay un solo número
  // que mostrar para todas.
  console.log(`[suspension-internet] Job activado: revisa pagos de internet cada ${minutos} minuto(s) (día límite editable por empresa desde Ajustes).`);

  correrCicloDeSuspension();
  setInterval(correrCicloDeSuspension, INTERVALO_MS);
}
