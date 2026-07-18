-- AlterTable
ALTER TABLE "VisitaTecnica" ADD COLUMN     "descripcionTrabajo" TEXT,
ADD COLUMN     "fotoTrabajoUrl" TEXT,
ADD COLUMN     "fotoViviendaUrl" TEXT;

-- CreateTable
CREATE TABLE "EquipoDejadoVisita" (
    "id" SERIAL NOT NULL,
    "visitaId" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "modelo" TEXT,
    "serial" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipoDejadoVisita_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "EquipoDejadoVisita" ADD CONSTRAINT "EquipoDejadoVisita_visitaId_fkey" FOREIGN KEY ("visitaId") REFERENCES "VisitaTecnica"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
