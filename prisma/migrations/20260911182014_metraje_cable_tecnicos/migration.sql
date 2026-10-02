-- AlterTable
ALTER TABLE "EquipoDejadoVisita" ADD COLUMN     "asignacionMetrajeId" INTEGER,
ADD COLUMN     "metrosUsados" INTEGER;

-- CreateTable
CREATE TABLE "AsignacionMetraje" (
    "id" SERIAL NOT NULL,
    "productoId" INTEGER NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "bodegaId" INTEGER NOT NULL,
    "metrosIniciales" INTEGER NOT NULL,
    "metrosRestantes" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AsignacionMetraje_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "AsignacionMetraje" ADD CONSTRAINT "AsignacionMetraje_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsignacionMetraje" ADD CONSTRAINT "AsignacionMetraje_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsignacionMetraje" ADD CONSTRAINT "AsignacionMetraje_bodegaId_fkey" FOREIGN KEY ("bodegaId") REFERENCES "Bodega"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipoDejadoVisita" ADD CONSTRAINT "EquipoDejadoVisita_asignacionMetrajeId_fkey" FOREIGN KEY ("asignacionMetrajeId") REFERENCES "AsignacionMetraje"("id") ON DELETE SET NULL ON UPDATE CASCADE;
