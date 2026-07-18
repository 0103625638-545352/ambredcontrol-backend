-- CreateEnum
CREATE TYPE "TipoMarcacion" AS ENUM ('ENTRADA', 'SALIDA');

-- AlterTable
ALTER TABLE "Empleado" ADD COLUMN     "bloqueadoHastaPin" TIMESTAMP(3),
ADD COLUMN     "horaEntradaEsperada" TEXT,
ADD COLUMN     "horaSalidaEsperada" TEXT,
ADD COLUMN     "intentosFallidosPin" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pinHash" TEXT;

-- AlterTable
ALTER TABLE "Sucursal" ADD COLUMN     "latitud" DECIMAL(9,6),
ADD COLUMN     "longitud" DECIMAL(9,6),
ADD COLUMN     "radioGeocercaMetros" INTEGER;

-- CreateTable
CREATE TABLE "Marcacion" (
    "id" SERIAL NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "tipo" "TipoMarcacion" NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitud" DECIMAL(9,6),
    "longitud" DECIMAL(9,6),
    "distanciaMetros" DECIMAL(10,2),
    "dentroDeGeocerca" BOOLEAN,
    "tardanza" BOOLEAN,
    "creadaManualmente" BOOLEAN NOT NULL DEFAULT false,
    "observacion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Marcacion_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Marcacion" ADD CONSTRAINT "Marcacion_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
