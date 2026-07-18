-- AlterTable
ALTER TABLE "Producto" ADD COLUMN     "modelo" TEXT;

-- CreateTable
CREATE TABLE "ContadorProducto" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "ultimoNumero" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ContadorProducto_pkey" PRIMARY KEY ("id")
);
