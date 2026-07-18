-- AlterTable
ALTER TABLE "Cliente" ADD COLUMN     "nodoId" INTEGER;

-- CreateTable
CREATE TABLE "NodoRed" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "mikrotikHost" TEXT NOT NULL,
    "mikrotikPuerto" INTEGER NOT NULL DEFAULT 8728,
    "mikrotikUsuario" TEXT NOT NULL,
    "mikrotikPassword" TEXT NOT NULL,
    "rangoIpInicio" TEXT,
    "rangoIpFin" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodoRed_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Cliente" ADD CONSTRAINT "Cliente_nodoId_fkey" FOREIGN KEY ("nodoId") REFERENCES "NodoRed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

