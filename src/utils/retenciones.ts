// Cálculo del comprobante de retención (IVA y/o Renta retenidos a un
// proveedor). El % y el código de retención SIEMPRE se ingresan a mano al
// generar la retención (ver routes/retenciones.ts) — el SRI actualiza esas
// tablas periódicamente, así que mantener un catálogo interno acá sería un
// riesgo de compliance si queda desactualizado. Estas funciones solo hacen
// la aritmética, separada de la ruta para poder testearla sin base de datos
// (mismo criterio que estadoPago.ts/caja.ts).

import { Prisma } from "@prisma/client";

export function calcularValorRetenido(baseImponible: Prisma.Decimal, porcentaje: Prisma.Decimal): Prisma.Decimal {
  return baseImponible.mul(porcentaje).div(100);
}

export interface LineaRetenida {
  tipoImpuesto: "IVA" | "RENTA";
  valorRetenido: Prisma.Decimal;
}

export interface TotalesRetencion {
  totalIva: Prisma.Decimal;
  totalRenta: Prisma.Decimal;
  total: Prisma.Decimal;
}

export function calcularTotalesRetencion(lineas: LineaRetenida[]): TotalesRetencion {
  let totalIva = new Prisma.Decimal(0);
  let totalRenta = new Prisma.Decimal(0);

  for (const linea of lineas) {
    if (linea.tipoImpuesto === "IVA") totalIva = totalIva.add(linea.valorRetenido);
    else totalRenta = totalRenta.add(linea.valorRetenido);
  }

  return { totalIva, totalRenta, total: totalIva.add(totalRenta) };
}
