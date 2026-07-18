-- AlterTable
ALTER TABLE "Usuario" ADD COLUMN     "bloqueadoHasta" TIMESTAMP(3),
ADD COLUMN     "debeCambiarPassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "intentosFallidos" INTEGER NOT NULL DEFAULT 0;
