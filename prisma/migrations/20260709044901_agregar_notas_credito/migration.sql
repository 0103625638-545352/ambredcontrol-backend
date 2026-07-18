/*
  Warnings:

  - A unique constraint covering the columns `[puntoVenta,establecimiento,tipoComprobante]` on the table `Secuencial` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Secuencial_puntoVenta_establecimiento_key";

-- AlterTable
ALTER TABLE "Secuencial" ADD COLUMN     "tipoComprobante" TEXT NOT NULL DEFAULT '01';

-- CreateTable
CREATE TABLE "NotaCredito" (
    "id" SERIAL NOT NULL,
    "secuencial" TEXT NOT NULL,
    "claveAcceso" TEXT,
    "fechaEmision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "motivo" TEXT NOT NULL,
    "facturaId" INTEGER NOT NULL,
    "subtotal0" DECIMAL(10,2) NOT NULL,
    "subtotal12" DECIMAL(10,2) NOT NULL,
    "iva" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "estado" "EstadoFactura" NOT NULL DEFAULT 'CREADA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotaCredito_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotaCreditoDetalle" (
    "id" SERIAL NOT NULL,
    "notaCreditoId" INTEGER NOT NULL,
    "productoId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "precioUnitario" DECIMAL(10,2) NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "ivaValor" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "NotaCreditoDetalle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotaCredito_secuencial_key" ON "NotaCredito"("secuencial");

-- CreateIndex
CREATE UNIQUE INDEX "NotaCredito_claveAcceso_key" ON "NotaCredito"("claveAcceso");

-- CreateIndex
CREATE UNIQUE INDEX "Secuencial_puntoVenta_establecimiento_tipoComprobante_key" ON "Secuencial"("puntoVenta", "establecimiento", "tipoComprobante");

-- AddForeignKey
ALTER TABLE "NotaCredito" ADD CONSTRAINT "NotaCredito_facturaId_fkey" FOREIGN KEY ("facturaId") REFERENCES "Factura"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotaCreditoDetalle" ADD CONSTRAINT "NotaCreditoDetalle_notaCreditoId_fkey" FOREIGN KEY ("notaCreditoId") REFERENCES "NotaCredito"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotaCreditoDetalle" ADD CONSTRAINT "NotaCreditoDetalle_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
