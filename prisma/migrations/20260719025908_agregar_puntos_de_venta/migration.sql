-- Módulo de PUNTOS DE VENTA (cajas registradoras dentro de una sucursal).
-- A diferencia de Bodega, esto es enteramente OPCIONAL y nada se vuelve
-- obligatorio después — todo entra en una sola migración aditiva, sin
-- backfill ni endurecimiento posterior (ver comentario en schema.prisma).

-- CreateTable
CREATE TABLE "PuntoDeVenta" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "sucursalId" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PuntoDeVenta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PuntoDeVenta_sucursalId_nombre_key" ON "PuntoDeVenta"("sucursalId", "nombre");

-- AddForeignKey
ALTER TABLE "PuntoDeVenta" ADD CONSTRAINT "PuntoDeVenta_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "Sucursal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: puntoVentaId nullable PARA SIEMPRE en los 4 lugares — nunca se
-- endurece a NOT NULL (a diferencia de bodegaId en el rollout de Bodega).
ALTER TABLE "CajaSesion" ADD COLUMN "puntoVentaId" INTEGER;
ALTER TABLE "Factura" ADD COLUMN "puntoVentaId" INTEGER;
ALTER TABLE "NotaVenta" ADD COLUMN "puntoVentaId" INTEGER;
ALTER TABLE "Compra" ADD COLUMN "puntoVentaId" INTEGER;

-- AddForeignKey
ALTER TABLE "CajaSesion" ADD CONSTRAINT "CajaSesion_puntoVentaId_fkey" FOREIGN KEY ("puntoVentaId") REFERENCES "PuntoDeVenta"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Factura" ADD CONSTRAINT "Factura_puntoVentaId_fkey" FOREIGN KEY ("puntoVentaId") REFERENCES "PuntoDeVenta"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotaVenta" ADD CONSTRAINT "NotaVenta_puntoVentaId_fkey" FOREIGN KEY ("puntoVentaId") REFERENCES "PuntoDeVenta"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_puntoVentaId_fkey" FOREIGN KEY ("puntoVentaId") REFERENCES "PuntoDeVenta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Reemplaza el índice único parcial que garantizaba "como mucho una
-- CajaSesion ABIERTA por sucursal a la vez" por uno que garantiza "como
-- mucho una ABIERTA por (sucursal, punto de venta) a la vez". COALESCE(...,
-- 0) es necesario porque Postgres trata cada NULL como distinto en un
-- índice único — sin este truco, una sucursal que NO usa puntos de venta
-- podría terminar con varias cajas "sin punto de venta" abiertas a la vez,
-- rompiendo la garantía que ya existía para ese caso antes de este módulo.
DROP INDEX "CajaSesion_sucursal_abierta_unica";

CREATE UNIQUE INDEX "CajaSesion_sucursal_puntoVenta_abierta_unica"
  ON "CajaSesion"("sucursalId", COALESCE("puntoVentaId", 0))
  WHERE "estado" = 'ABIERTA';
