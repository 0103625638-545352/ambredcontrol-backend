-- Paso 3 de 3 (destructivo/confirmar) del rollout de Bodega — se aplica
-- DESPUÉS de confirmar (por SQL de solo lectura) que el backfill del paso 2
-- dejó a TODOS los Compra/Factura/NotaVenta/Traslado existentes con un
-- bodegaId (y bodegaOrigenId/bodegaDestinoId) válido. Irreversible: hacer un
-- respaldo de la base antes de aplicarlo.

-- DropForeignKey (SET NULL temporales del paso 1)
ALTER TABLE "Compra" DROP CONSTRAINT "Compra_bodegaId_fkey";
ALTER TABLE "Factura" DROP CONSTRAINT "Factura_bodegaId_fkey";
ALTER TABLE "NotaVenta" DROP CONSTRAINT "NotaVenta_bodegaId_fkey";
ALTER TABLE "Traslado" DROP CONSTRAINT "Traslado_bodegaOrigenId_fkey";
ALTER TABLE "Traslado" DROP CONSTRAINT "Traslado_bodegaDestinoId_fkey";

-- AlterTable: bodegaId pasa a ser obligatorio.
ALTER TABLE "Compra" ALTER COLUMN "bodegaId" SET NOT NULL;
ALTER TABLE "Factura" ALTER COLUMN "bodegaId" SET NOT NULL;
ALTER TABLE "NotaVenta" ALTER COLUMN "bodegaId" SET NOT NULL;
ALTER TABLE "Traslado" ALTER COLUMN "bodegaOrigenId" SET NOT NULL;
ALTER TABLE "Traslado" ALTER COLUMN "bodegaDestinoId" SET NOT NULL;

-- AddForeignKey (RESTRICT definitivo, ya no se puede borrar una bodega
-- todavía referenciada por un documento).
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Factura" ADD CONSTRAINT "Factura_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotaVenta" ADD CONSTRAINT "NotaVenta_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Traslado" ADD CONSTRAINT "Traslado_bodegaOrigenId_fkey" FOREIGN KEY ("bodegaOrigenId") REFERENCES "Bodega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Traslado" ADD CONSTRAINT "Traslado_bodegaDestinoId_fkey" FOREIGN KEY ("bodegaDestinoId") REFERENCES "Bodega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- MovimientoInventario.bodegaId queda nullable para siempre — no se toca
-- acá (igual criterio que sucursalId).
