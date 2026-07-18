/*
  Warnings:

  - A unique constraint covering the columns `[claveAcceso]` on the table `Factura` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Factura" ADD COLUMN     "claveAcceso" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Factura_claveAcceso_key" ON "Factura"("claveAcceso");
