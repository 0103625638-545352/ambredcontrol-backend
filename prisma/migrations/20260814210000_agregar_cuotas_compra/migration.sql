-- AlterTable
ALTER TABLE "Cuota" ADD COLUMN     "compraId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Cuota_compraId_numero_key" ON "Cuota"("compraId", "numero");

-- AddForeignKey
ALTER TABLE "Cuota" ADD CONSTRAINT "Cuota_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "Compra"("id") ON DELETE SET NULL ON UPDATE CASCADE;

