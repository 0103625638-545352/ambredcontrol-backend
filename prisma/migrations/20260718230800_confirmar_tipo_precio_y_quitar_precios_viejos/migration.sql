-- Segundo (y destructivo) paso del reemplazo de tipoCliente + precios fijos
-- por categorías de precio configurables — se aplica DESPUÉS de confirmar
-- (por SQL de solo lectura) que la migración anterior dejó a todos los
-- Cliente existentes con un tipoPrecioId válido. Este paso es irreversible:
-- hacer un respaldo de la base antes de aplicarlo.

-- Cliente.tipoPrecioId pasa a ser obligatorio. La llave foránea ya existe
-- desde la migración anterior (Prisma la crea junto con la columna, con
-- "ON DELETE SET NULL" porque en ese momento la columna todavía era
-- nullable) — se recrea con "ON DELETE RESTRICT" ahora que es obligatoria,
-- para que sea imposible borrar una categoría de precio todavía referenciada
-- por algún cliente (en vez de dejarlo con un tipoPrecioId nulo, lo que
-- violaría el NOT NULL de todas formas).
ALTER TABLE "Cliente" ALTER COLUMN "tipoPrecioId" SET NOT NULL;
ALTER TABLE "Cliente" DROP CONSTRAINT "Cliente_tipoPrecioId_fkey";
ALTER TABLE "Cliente" ADD CONSTRAINT "Cliente_tipoPrecioId_fkey"
  FOREIGN KEY ("tipoPrecioId") REFERENCES "TipoPrecio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El esquema fijo de 2 niveles queda completamente reemplazado.
ALTER TABLE "Cliente" DROP COLUMN "tipoCliente";
DROP TYPE "TipoCliente";

-- Los precios fijos por producto ya no existen: todo precio de venta se
-- calcula al vuelo desde costoPromedioActual × tipoPrecio.porcentajeGanancia
-- (ver utils/precios.ts) — y como todo porcentaje de categoría es >= 0, ya
-- no hace falta ningún piso de margen mínimo por producto.
ALTER TABLE "Producto" DROP COLUMN "precioUnitario";
ALTER TABLE "Producto" DROP COLUMN "precioMayorista";
ALTER TABLE "Producto" DROP COLUMN "margenMinimoPorcentaje";
