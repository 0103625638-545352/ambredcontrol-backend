-- CreateEnum
CREATE TYPE "EstadoCuota" AS ENUM ('PENDIENTE', 'PAGADA');

-- AlterTable
ALTER TABLE "Pago" ADD COLUMN     "cuotaId" INTEGER;

-- CreateTable
CREATE TABLE "Cuota" (
    "id" SERIAL NOT NULL,
    "numero" INTEGER NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "fechaVencimiento" TIMESTAMP(3) NOT NULL,
    "estado" "EstadoCuota" NOT NULL DEFAULT 'PENDIENTE',
    "facturaId" INTEGER,
    "notaVentaId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cuota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Cuota_facturaId_numero_key" ON "Cuota"("facturaId", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "Cuota_notaVentaId_numero_key" ON "Cuota"("notaVentaId", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "Pago_cuotaId_key" ON "Pago"("cuotaId");

-- AddForeignKey
ALTER TABLE "Pago" ADD CONSTRAINT "Pago_cuotaId_fkey" FOREIGN KEY ("cuotaId") REFERENCES "Cuota"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cuota" ADD CONSTRAINT "Cuota_facturaId_fkey" FOREIGN KEY ("facturaId") REFERENCES "Factura"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cuota" ADD CONSTRAINT "Cuota_notaVentaId_fkey" FOREIGN KEY ("notaVentaId") REFERENCES "NotaVenta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

