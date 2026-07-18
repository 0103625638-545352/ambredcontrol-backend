-- AlterEnum
ALTER TYPE "OrigenAsiento" ADD VALUE 'DEVOLUCION_COMPRA';

-- CreateTable
CREATE TABLE "DevolucionCompra" (
    "id" SERIAL NOT NULL,
    "secuencial" TEXT NOT NULL,
    "fechaEmision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "motivo" TEXT NOT NULL,
    "compraId" INTEGER NOT NULL,
    "subtotal0" DECIMAL(10,2) NOT NULL,
    "subtotal12" DECIMAL(10,2) NOT NULL,
    "iva" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevolucionCompra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevolucionCompraDetalle" (
    "id" SERIAL NOT NULL,
    "devolucionCompraId" INTEGER NOT NULL,
    "compraDetalleId" INTEGER NOT NULL,
    "productoId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "costoUnitario" DECIMAL(10,2) NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "ivaValor" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "DevolucionCompraDetalle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DevolucionCompra_secuencial_key" ON "DevolucionCompra"("secuencial");

-- AddForeignKey
ALTER TABLE "DevolucionCompra" ADD CONSTRAINT "DevolucionCompra_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "Compra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevolucionCompraDetalle" ADD CONSTRAINT "DevolucionCompraDetalle_devolucionCompraId_fkey" FOREIGN KEY ("devolucionCompraId") REFERENCES "DevolucionCompra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevolucionCompraDetalle" ADD CONSTRAINT "DevolucionCompraDetalle_compraDetalleId_fkey" FOREIGN KEY ("compraDetalleId") REFERENCES "CompraDetalle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevolucionCompraDetalle" ADD CONSTRAINT "DevolucionCompraDetalle_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
