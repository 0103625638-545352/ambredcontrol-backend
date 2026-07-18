-- AlterTable
ALTER TABLE "Cliente" ADD COLUMN     "tipoPrecioId" INTEGER;

-- CreateTable
CREATE TABLE "TipoPrecio" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "porcentajeGanancia" DECIMAL(5,2) NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TipoPrecio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TipoPrecio_nombre_key" ON "TipoPrecio"("nombre");

-- AddForeignKey
ALTER TABLE "Cliente" ADD CONSTRAINT "Cliente_tipoPrecioId_fkey" FOREIGN KEY ("tipoPrecioId") REFERENCES "TipoPrecio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
