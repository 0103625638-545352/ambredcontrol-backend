-- CreateEnum
CREATE TYPE "TipoCliente" AS ENUM ('MINORISTA', 'MAYORISTA');

-- AlterTable
ALTER TABLE "Cliente" ADD COLUMN "tipoCliente" "TipoCliente" NOT NULL DEFAULT 'MINORISTA';

-- AlterTable
ALTER TABLE "Producto" ADD COLUMN "precioMayorista" DECIMAL(10,2);
