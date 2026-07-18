-- CreateEnum
CREATE TYPE "EstadoVisita" AS ENUM ('PENDIENTE', 'COMPLETADA', 'OMITIDA');

-- AlterTable
ALTER TABLE "Usuario" ADD COLUMN     "empleadoId" INTEGER;

-- CreateTable
CREATE TABLE "RutaVisita" (
    "id" SERIAL NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RutaVisita_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitaTecnica" (
    "id" SERIAL NOT NULL,
    "rutaVisitaId" INTEGER NOT NULL,
    "clienteId" INTEGER,
    "nombreContacto" TEXT NOT NULL,
    "direccion" TEXT,
    "latitud" DECIMAL(9,6) NOT NULL,
    "longitud" DECIMAL(9,6) NOT NULL,
    "orden" INTEGER NOT NULL,
    "estado" "EstadoVisita" NOT NULL DEFAULT 'PENDIENTE',
    "fechaLlegadaReal" TIMESTAMP(3),
    "latitudLlegada" DECIMAL(9,6),
    "longitudLlegada" DECIMAL(9,6),
    "distanciaAlPunto" DECIMAL(10,2),
    "observaciones" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitaTecnica_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Usuario_empleadoId_key" ON "Usuario"("empleadoId");

-- CreateIndex
CREATE UNIQUE INDEX "RutaVisita_empleadoId_fecha_key" ON "RutaVisita"("empleadoId", "fecha");

-- AddForeignKey
ALTER TABLE "Usuario" ADD CONSTRAINT "Usuario_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RutaVisita" ADD CONSTRAINT "RutaVisita_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitaTecnica" ADD CONSTRAINT "VisitaTecnica_rutaVisitaId_fkey" FOREIGN KEY ("rutaVisitaId") REFERENCES "RutaVisita"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitaTecnica" ADD CONSTRAINT "VisitaTecnica_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;
