-- CreateEnum
CREATE TYPE "EstadoEgresoBodegaDetalle" AS ENUM ('EN_TRANSITO', 'ENTREGADO', 'DEVUELTO');

-- AlterEnum
ALTER TYPE "EstadoNumeroSerie" ADD VALUE 'EN_TRANSITO';

-- CreateTable
CREATE TABLE "EgresoBodega" (
    "id" SERIAL NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "clienteDestinoId" INTEGER,
    "usuarioId" INTEGER,
    "observaciones" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EgresoBodega_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EgresoBodegaDetalle" (
    "id" SERIAL NOT NULL,
    "egresoId" INTEGER NOT NULL,
    "numeroSerieProductoId" INTEGER NOT NULL,
    "estado" "EstadoEgresoBodegaDetalle" NOT NULL DEFAULT 'EN_TRANSITO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EgresoBodegaDetalle_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "EgresoBodega" ADD CONSTRAINT "EgresoBodega_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EgresoBodega" ADD CONSTRAINT "EgresoBodega_clienteDestinoId_fkey" FOREIGN KEY ("clienteDestinoId") REFERENCES "Cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EgresoBodega" ADD CONSTRAINT "EgresoBodega_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EgresoBodegaDetalle" ADD CONSTRAINT "EgresoBodegaDetalle_egresoId_fkey" FOREIGN KEY ("egresoId") REFERENCES "EgresoBodega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EgresoBodegaDetalle" ADD CONSTRAINT "EgresoBodegaDetalle_numeroSerieProductoId_fkey" FOREIGN KEY ("numeroSerieProductoId") REFERENCES "NumeroSerieProducto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
