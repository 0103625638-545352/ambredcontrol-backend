-- AlterTable
ALTER TABLE "Producto" ADD COLUMN "codigoBarras" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Producto_codigoBarras_key" ON "Producto"("codigoBarras");
