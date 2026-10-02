-- AlterTable
ALTER TABLE "EquipoDejadoVisita" ADD COLUMN     "numeroSerieProductoId" INTEGER;

-- AddForeignKey
ALTER TABLE "EquipoDejadoVisita" ADD CONSTRAINT "EquipoDejadoVisita_numeroSerieProductoId_fkey" FOREIGN KEY ("numeroSerieProductoId") REFERENCES "NumeroSerieProducto"("id") ON DELETE SET NULL ON UPDATE CASCADE;
