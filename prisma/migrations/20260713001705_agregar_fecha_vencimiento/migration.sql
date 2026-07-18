-- AlterTable
ALTER TABLE "Factura" ADD COLUMN "fechaVencimiento" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotaVenta" ADD COLUMN "fechaVencimiento" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Compra" ADD COLUMN "fechaVencimiento" TIMESTAMP(3);
