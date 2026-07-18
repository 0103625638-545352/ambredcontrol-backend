-- CreateEnum
CREATE TYPE "CategoriaSinonimoBusqueda" AS ENUM ('ACTIVOS', 'SUSPENDIDOS', 'PAGARON', 'NO_PAGARON', 'VENTAS', 'CLIENTES');

-- CreateTable
CREATE TABLE "SinonimoBusqueda" (
    "id" SERIAL NOT NULL,
    "categoria" "CategoriaSinonimoBusqueda" NOT NULL,
    "palabra" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SinonimoBusqueda_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SinonimoBusqueda_categoria_palabra_key" ON "SinonimoBusqueda"("categoria", "palabra");
