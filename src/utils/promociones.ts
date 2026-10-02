// Selección y cálculo de la promoción aplicable a una factura de internet
// (ver PromocionPlan en schema.prisma, aplicado en routes/facturasInternet.ts).
// Separado de las rutas para poder testearlo sin base de datos, mismo
// criterio que utils/precios.ts / utils/estadoRedCliente.ts — el llamador
// hace la consulta a la BD (promociones vigentes por rango de fecha) y le
// pasa acá el resultado ya filtrado por fecha/activo.
import { Prisma } from "@prisma/client";

export interface PromocionCandidata {
  id: number;
  nombre: string;
  porcentajeDescuento: Prisma.Decimal;
  alcance: "TODOS_LOS_CLIENTES" | "CLIENTES_NUEVOS";
  mesesDesdeContrato: number | null;
  planInternetId: number | null;
}

// Meses completos transcurridos entre dos fechas — un cliente que firmó el
// 20/enero sigue "en su mes 0" hasta el 20/febrero, no cambia de mes a mitad
// de un ciclo de facturación. Puede dar negativo si "desde" es futura (no
// debería pasar en la práctica, se descarta en promocionAplicable).
function mesesEntre(desde: Date, hasta: Date): number {
  let meses = (hasta.getFullYear() - desde.getFullYear()) * 12 + (hasta.getMonth() - desde.getMonth());
  if (hasta.getDate() < desde.getDate()) meses -= 1;
  return meses;
}

// De TODAS las promociones ya filtradas por vigencia de fecha/activo (ver
// llamador), decide cuál aplica a este cliente/plan puntual — nunca se suman
// dos descuentos en la misma factura. Precedencia: primero la más
// ESPECÍFICA (atada a un plan puntual gana sobre una general para todos los
// planes), y entre promociones igual de específicas, la de mayor % de
// descuento (la más beneficiosa para el cliente).
export function promocionAplicable(
  candidatas: PromocionCandidata[],
  cliente: { fechaContrato: Date | null },
  planInternetId: number,
  hoy: Date = new Date()
): PromocionCandidata | null {
  const elegibles = candidatas.filter((p) => {
    if (p.planInternetId !== null && p.planInternetId !== planInternetId) return false;
    if (p.alcance === "CLIENTES_NUEVOS") {
      if (!cliente.fechaContrato || p.mesesDesdeContrato == null) return false;
      const meses = mesesEntre(cliente.fechaContrato, hoy);
      if (meses < 0 || meses >= p.mesesDesdeContrato) return false;
    }
    return true;
  });

  if (elegibles.length === 0) return null;

  elegibles.sort((a, b) => {
    const especificidadA = a.planInternetId !== null ? 0 : 1;
    const especificidadB = b.planInternetId !== null ? 0 : 1;
    if (especificidadA !== especificidadB) return especificidadA - especificidadB;
    return b.porcentajeDescuento.comparedTo(a.porcentajeDescuento);
  });

  return elegibles[0];
}

// Monto absoluto a restar (para FacturaDetalle.descuento) a partir del
// precio de lista y el % de la promoción — redondeado a 2 decimales, igual
// que cualquier otro monto monetario del sistema.
export function montoDescuentoPromocion(precioBase: Prisma.Decimal, promocion: PromocionCandidata): Prisma.Decimal {
  return precioBase.mul(promocion.porcentajeDescuento).div(100).toDecimalPlaces(2);
}
