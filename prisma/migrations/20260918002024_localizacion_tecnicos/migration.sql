-- CreateTable
CREATE TABLE "UbicacionTecnico" (
    "id" SERIAL NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "latitud" DECIMAL(9,6) NOT NULL,
    "longitud" DECIMAL(9,6) NOT NULL,
    "precisionMetros" DECIMAL(8,2),
    "fecha" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UbicacionTecnico_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UbicacionTecnico_empleadoId_fecha_idx" ON "UbicacionTecnico"("empleadoId", "fecha");

-- AddForeignKey
ALTER TABLE "UbicacionTecnico" ADD CONSTRAINT "UbicacionTecnico_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
