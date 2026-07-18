-- AlterTable
ALTER TABLE "MovimientoInventario" ADD COLUMN     "loteProductoId" INTEGER;

-- AlterTable
ALTER TABLE "Producto" ADD COLUMN     "fechaCaducidad" TIMESTAMP(3),
ADD COLUMN     "manejaLotes" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "LoteProducto" (
    "id" SERIAL NOT NULL,
    "productoId" INTEGER NOT NULL,
    "numeroLote" TEXT,
    "fechaCaducidad" TIMESTAMP(3) NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoteProducto_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "LoteProducto" ADD CONSTRAINT "LoteProducto_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_loteProductoId_fkey" FOREIGN KEY ("loteProductoId") REFERENCES "LoteProducto"("id") ON DELETE SET NULL ON UPDATE CASCADE;
