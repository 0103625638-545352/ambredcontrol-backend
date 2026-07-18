-- CreateEnum
CREATE TYPE "EstadoNumeroSerie" AS ENUM ('EN_BODEGA', 'ENTREGADO');

-- AlterTable
ALTER TABLE "Producto" ADD COLUMN     "controlaNumeroSerie" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "NumeroSerieProducto" (
    "id" SERIAL NOT NULL,
    "productoId" INTEGER NOT NULL,
    "numeroSerie" TEXT NOT NULL,
    "compraDetalleId" INTEGER,
    "estado" "EstadoNumeroSerie" NOT NULL DEFAULT 'EN_BODEGA',
    "clienteId" INTEGER,
    "referenciaDocumento" TEXT,
    "fechaEntrega" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NumeroSerieProducto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NumeroSerieProducto_productoId_numeroSerie_key" ON "NumeroSerieProducto"("productoId", "numeroSerie");

-- AddForeignKey
ALTER TABLE "NumeroSerieProducto" ADD CONSTRAINT "NumeroSerieProducto_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumeroSerieProducto" ADD CONSTRAINT "NumeroSerieProducto_compraDetalleId_fkey" FOREIGN KEY ("compraDetalleId") REFERENCES "CompraDetalle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumeroSerieProducto" ADD CONSTRAINT "NumeroSerieProducto_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;
