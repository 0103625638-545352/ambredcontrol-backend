-- AlterTable
ALTER TABLE "NotaVenta" ADD COLUMN     "estadoPago" "EstadoPago" NOT NULL DEFAULT 'PENDIENTE',
ADD COLUMN     "montoPagado" DECIMAL(10,2) NOT NULL DEFAULT 0.00;

-- AlterTable
ALTER TABLE "Pago" ADD COLUMN     "notaVentaId" INTEGER;

-- AddForeignKey
ALTER TABLE "Pago" ADD CONSTRAINT "Pago_notaVentaId_fkey" FOREIGN KEY ("notaVentaId") REFERENCES "NotaVenta"("id") ON DELETE SET NULL ON UPDATE CASCADE;
