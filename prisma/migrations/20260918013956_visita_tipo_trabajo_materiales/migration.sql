-- CreateEnum
CREATE TYPE "TipoTrabajoVisita" AS ENUM ('INSTALACION_NUEVA', 'MEJORA_EXISTENTE');

-- AlterTable
ALTER TABLE "VisitaTecnica" ADD COLUMN     "tipoTrabajo" "TipoTrabajoVisita";

-- CreateTable
CREATE TABLE "MaterialUtilizadoVisita" (
    "id" SERIAL NOT NULL,
    "visitaId" INTEGER NOT NULL,
    "descripcion" TEXT NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "unidad" TEXT NOT NULL DEFAULT 'UNIDAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialUtilizadoVisita_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "MaterialUtilizadoVisita" ADD CONSTRAINT "MaterialUtilizadoVisita_visitaId_fkey" FOREIGN KEY ("visitaId") REFERENCES "VisitaTecnica"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
