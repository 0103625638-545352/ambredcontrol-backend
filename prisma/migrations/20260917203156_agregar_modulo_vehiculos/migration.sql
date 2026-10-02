-- CreateEnum
CREATE TYPE "TipoMantenimientoVehiculo" AS ENUM ('CAMBIO_ACEITE', 'CAMBIO_FILTRO_ACEITE', 'CAMBIO_FILTRO_AIRE', 'CAMBIO_PASTILLAS_FRENO', 'CAMBIO_LLANTAS', 'ALINEACION_BALANCEO', 'REVISION_GENERAL', 'OTRO');

-- CreateTable
CREATE TABLE "Vehiculo" (
    "id" SERIAL NOT NULL,
    "placa" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "anio" INTEGER,
    "color" TEXT,
    "responsableId" INTEGER,
    "sucursalId" INTEGER,
    "kilometrajeActual" INTEGER,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vehiculo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CargaCombustible" (
    "id" SERIAL NOT NULL,
    "vehiculoId" INTEGER NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kilometraje" INTEGER NOT NULL,
    "tipoCombustible" TEXT NOT NULL DEFAULT 'EXTRA',
    "galones" DECIMAL(8,2) NOT NULL,
    "costoTotal" DECIMAL(10,2) NOT NULL,
    "gasolinera" TEXT,
    "observaciones" TEXT,
    "usuarioId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CargaCombustible_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MantenimientoVehiculo" (
    "id" SERIAL NOT NULL,
    "vehiculoId" INTEGER NOT NULL,
    "tipo" "TipoMantenimientoVehiculo" NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kilometraje" INTEGER NOT NULL,
    "costo" DECIMAL(10,2),
    "taller" TEXT,
    "descripcion" TEXT,
    "proximoKilometraje" INTEGER,
    "usuarioId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MantenimientoVehiculo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vehiculo_placa_key" ON "Vehiculo"("placa");

-- AddForeignKey
ALTER TABLE "Vehiculo" ADD CONSTRAINT "Vehiculo_responsableId_fkey" FOREIGN KEY ("responsableId") REFERENCES "Empleado"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehiculo" ADD CONSTRAINT "Vehiculo_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "Sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CargaCombustible" ADD CONSTRAINT "CargaCombustible_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "Vehiculo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CargaCombustible" ADD CONSTRAINT "CargaCombustible_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MantenimientoVehiculo" ADD CONSTRAINT "MantenimientoVehiculo_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "Vehiculo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MantenimientoVehiculo" ADD CONSTRAINT "MantenimientoVehiculo_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
