// Precio a cobrar según la categoría de precio del cliente (ver TipoPrecio
// en schema.prisma). Separado de las rutas para poder testearlo sin base de
// datos (mismo criterio que retenciones.ts/codigoBarras.ts). El precio
// SIEMPRE se calcula acá, del lado del servidor — ninguna ruta de creación
// de documentos acepta un precio que venga del frontend.
//
// A diferencia del esquema anterior (precios fijos por producto,
// precioUnitario/precioMayorista escritos a mano), acá el precio se calcula
// AL VUELO a partir del costo promedio ponderado del producto y el % de
// ganancia de la categoría del cliente — nunca se guarda ni se edita a mano.
import { Prisma } from "@prisma/client";

// null si el producto todavía no tiene costo conocido (nunca se compró) —
// sin costo no hay con qué calcular ningún precio, así que no se puede
// vender hasta su primera compra real.
//
// Excepción: si el producto trae precioFijo (ver Producto en schema.prisma
// — pensado para servicios como un plan de internet o una visita técnica,
// que no tienen "costo de compra" del que calcular margen), se devuelve tal
// cual, ignorando costoPromedioActual y la categoría de precio del cliente.
export function precioParaCliente(
  producto: { costoPromedioActual: Prisma.Decimal | null; precioFijo?: Prisma.Decimal | null },
  cliente: { tipoPrecio: { porcentajeGanancia: Prisma.Decimal } }
): Prisma.Decimal | null {
  if (producto.precioFijo) return producto.precioFijo;
  if (!producto.costoPromedioActual) return null;
  return producto.costoPromedioActual.mul(new Prisma.Decimal(1).add(cliente.tipoPrecio.porcentajeGanancia.div(100)));
}
