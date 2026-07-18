/*
  Warnings:

  - Made the column `sucursalId` on table `Compra` required. This step will fail if there are existing NULL values in that column.
  - Made the column `sucursalId` on table `Factura` required. This step will fail if there are existing NULL values in that column.
  - Made the column `sucursalId` on table `NotaVenta` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "Compra" DROP CONSTRAINT "Compra_sucursalId_fkey";

-- DropForeignKey
ALTER TABLE "Factura" DROP CONSTRAINT "Factura_sucursalId_fkey";

-- DropForeignKey
ALTER TABLE "NotaVenta" DROP CONSTRAINT "NotaVenta_sucursalId_fkey";

-- AlterTable
ALTER TABLE "Compra" ALTER COLUMN "sucursalId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Factura" ALTER COLUMN "sucursalId" SET NOT NULL;

-- AlterTable
ALTER TABLE "NotaVenta" ALTER COLUMN "sucursalId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Factura" ADD CONSTRAINT "Factura_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "Sucursal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotaVenta" ADD CONSTRAINT "NotaVenta_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "Sucursal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "Sucursal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
