-- Paso 1 de 3 (aditivo, no destructivo) del rollout de Bodega: subdivisión
-- de stock DENTRO de una sucursal. Solo agrega tablas/columnas nuevas, todas
-- nullable donde corresponde a una tabla preexistente — el backfill (paso 2)
-- y el endurecimiento a NOT NULL (paso 3) van en migraciones separadas, con
-- un checkpoint de solo lectura entre medio. Mismo patrón ya usado para el
-- rollout de Sucursal (ver 20260711175231_agregar_sucursales_base).

-- CreateTable
CREATE TABLE "Bodega" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "sucursalId" INTEGER NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bodega_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBodega" (
    "id" SERIAL NOT NULL,
    "productoId" INTEGER NOT NULL,
    "bodegaId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StockBodega_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Bodega_sucursalId_nombre_key" ON "Bodega"("sucursalId", "nombre");

-- CreateIndex
CREATE UNIQUE INDEX "StockBodega_productoId_bodegaId_key" ON "StockBodega"("productoId", "bodegaId");

-- AddForeignKey
ALTER TABLE "Bodega" ADD CONSTRAINT "Bodega_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "Sucursal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBodega" ADD CONSTRAINT "StockBodega_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBodega" ADD CONSTRAINT "StockBodega_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: bodegaId nullable por ahora en las 3 tablas de documentos —
-- se vuelve obligatorio recién en el paso 3, después del backfill.
ALTER TABLE "Compra" ADD COLUMN "bodegaId" INTEGER;
ALTER TABLE "Factura" ADD COLUMN "bodegaId" INTEGER;
ALTER TABLE "NotaVenta" ADD COLUMN "bodegaId" INTEGER;

-- AddForeignKey (SET NULL temporal, se recrea como RESTRICT en el paso 3)
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Factura" ADD CONSTRAINT "Factura_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotaVenta" ADD CONSTRAINT "NotaVenta_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: MovimientoInventario.bodegaId queda nullable PARA SIEMPRE
-- (igual criterio que sucursalId) — nunca se endurece en el paso 3.
ALTER TABLE "MovimientoInventario" ADD COLUMN "bodegaId" INTEGER;
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Traslado gana bodega origen/destino, nullable por ahora.
ALTER TABLE "Traslado" ADD COLUMN "bodegaOrigenId" INTEGER;
ALTER TABLE "Traslado" ADD COLUMN "bodegaDestinoId" INTEGER;
ALTER TABLE "Traslado" ADD CONSTRAINT "Traslado_bodegaOrigenId_fkey" FOREIGN KEY ("bodegaOrigenId") REFERENCES "Bodega"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Traslado" ADD CONSTRAINT "Traslado_bodegaDestinoId_fkey" FOREIGN KEY ("bodegaDestinoId") REFERENCES "Bodega"("id") ON DELETE SET NULL ON UPDATE CASCADE;
