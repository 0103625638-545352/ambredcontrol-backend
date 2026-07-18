-- AlterTable
ALTER TABLE "PlanInternet" ADD COLUMN     "productoId" INTEGER;

-- AlterTable
ALTER TABLE "Producto" ADD COLUMN     "esServicio" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "precioFijo" DECIMAL(10,2);

-- CreateIndex
CREATE UNIQUE INDEX "PlanInternet_productoId_key" ON "PlanInternet"("productoId");

-- AddForeignKey
ALTER TABLE "PlanInternet" ADD CONSTRAINT "PlanInternet_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

