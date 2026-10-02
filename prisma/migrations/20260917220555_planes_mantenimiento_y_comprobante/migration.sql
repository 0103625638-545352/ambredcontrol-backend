-- AlterTable
ALTER TABLE "MantenimientoVehiculo" ADD COLUMN     "comprobanteUrl" TEXT,
ADD COLUMN     "numeroFactura" TEXT;

-- CreateTable
CREATE TABLE "PlanMantenimientoVehiculo" (
    "id" SERIAL NOT NULL,
    "vehiculoId" INTEGER NOT NULL,
    "tipo" "TipoMantenimientoVehiculo" NOT NULL,
    "intervaloKm" INTEGER NOT NULL,
    "kmAvisoPrevio" INTEGER NOT NULL DEFAULT 500,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanMantenimientoVehiculo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanMantenimientoVehiculo_vehiculoId_tipo_key" ON "PlanMantenimientoVehiculo"("vehiculoId", "tipo");

-- AddForeignKey
ALTER TABLE "PlanMantenimientoVehiculo" ADD CONSTRAINT "PlanMantenimientoVehiculo_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "Vehiculo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
