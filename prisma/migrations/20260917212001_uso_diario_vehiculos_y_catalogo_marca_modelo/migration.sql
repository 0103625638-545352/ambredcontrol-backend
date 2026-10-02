-- Reemplaza "responsable fijo" del vehículo por uso diario (UsoVehiculo,
-- abre/cierra el día como una CajaSesion) y "marca"/"modelo" de texto libre
-- por catálogo (MarcaVehiculo/ModeloVehiculo) — ver comentarios en
-- schema.prisma. Escrita a mano (no generada por "migrate dev") porque hace
-- falta migrar los datos existentes de Vehiculo.marca/modelo (texto) al
-- catálogo nuevo antes de poder poner marcaId/modeloId como NOT NULL.

-- CreateEnum
CREATE TYPE "EstadoUsoVehiculo" AS ENUM ('EN_USO', 'FINALIZADO');

-- DropForeignKey (ya no existe "responsable fijo")
ALTER TABLE "Vehiculo" DROP CONSTRAINT "Vehiculo_responsableId_fkey";

-- CreateTable: catálogo de marcas
CREATE TABLE "MarcaVehiculo" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarcaVehiculo_pkey" PRIMARY KEY ("id")
);

-- CreateTable: catálogo de modelos, siempre bajo una marca
CREATE TABLE "ModeloVehiculo" (
    "id" SERIAL NOT NULL,
    "marcaId" INTEGER NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModeloVehiculo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarcaVehiculo_nombre_key" ON "MarcaVehiculo"("nombre");
CREATE UNIQUE INDEX "ModeloVehiculo_marcaId_nombre_key" ON "ModeloVehiculo"("marcaId", "nombre");
ALTER TABLE "ModeloVehiculo" ADD CONSTRAINT "ModeloVehiculo_marcaId_fkey" FOREIGN KEY ("marcaId") REFERENCES "MarcaVehiculo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: primero se agregan marcaId/modeloId NULLABLE (todavía no se
-- puede exigir NOT NULL — hay que rellenarlos desde los datos existentes)
ALTER TABLE "Vehiculo" DROP COLUMN "responsableId",
ADD COLUMN     "marcaId" INTEGER,
ADD COLUMN     "modeloId" INTEGER;

-- Migración de datos: una fila de MarcaVehiculo por cada "marca" distinta
-- que ya existía en Vehiculo (mayúsculas, igual que ya las guardaba el
-- formulario), y una de ModeloVehiculo por cada combinación (marca, modelo)
-- distinta — después se enlaza cada Vehiculo a la fila que le corresponde.
INSERT INTO "MarcaVehiculo" ("nombre")
SELECT DISTINCT "marca" FROM "Vehiculo" WHERE "marca" IS NOT NULL;

INSERT INTO "ModeloVehiculo" ("marcaId", "nombre")
SELECT DISTINCT mv."id", v."modelo"
FROM "Vehiculo" v
JOIN "MarcaVehiculo" mv ON mv."nombre" = v."marca"
WHERE v."modelo" IS NOT NULL;

UPDATE "Vehiculo" v
SET "marcaId" = mv."id",
    "modeloId" = mo."id"
FROM "MarcaVehiculo" mv, "ModeloVehiculo" mo
WHERE mv."nombre" = v."marca"
  AND mo."marcaId" = mv."id"
  AND mo."nombre" = v."modelo";

-- Ahora sí, con todas las filas existentes ya migradas, se puede exigir
-- NOT NULL y borrar las columnas de texto libre viejas.
ALTER TABLE "Vehiculo" ALTER COLUMN "marcaId" SET NOT NULL,
ALTER COLUMN "modeloId" SET NOT NULL;
ALTER TABLE "Vehiculo" DROP COLUMN "marca",
DROP COLUMN "modelo";

ALTER TABLE "Vehiculo" ADD CONSTRAINT "Vehiculo_marcaId_fkey" FOREIGN KEY ("marcaId") REFERENCES "MarcaVehiculo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Vehiculo" ADD CONSTRAINT "Vehiculo_modeloId_fkey" FOREIGN KEY ("modeloId") REFERENCES "ModeloVehiculo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: uso diario (abrir/cerrar) — reemplaza el "responsable fijo"
CREATE TABLE "UsoVehiculo" (
    "id" SERIAL NOT NULL,
    "vehiculoId" INTEGER NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "kilometrajeInicial" INTEGER NOT NULL,
    "fechaInicio" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kilometrajeFinal" INTEGER,
    "fechaFin" TIMESTAMP(3),
    "estado" "EstadoUsoVehiculo" NOT NULL DEFAULT 'EN_USO',
    "observaciones" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsoVehiculo_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "UsoVehiculo" ADD CONSTRAINT "UsoVehiculo_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "Vehiculo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UsoVehiculo" ADD CONSTRAINT "UsoVehiculo_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariante de negocio (mismo criterio que CajaSesion_sucursal_abierta_unica
-- — Prisma no soporta índices parciales en su DSL, se agregan a mano): como
-- mucho un UsoVehiculo EN_USO por vehículo a la vez, y como mucho uno
-- EN_USO por técnico a la vez.
CREATE UNIQUE INDEX "UsoVehiculo_vehiculo_en_uso_unica"
  ON "UsoVehiculo"("vehiculoId") WHERE "estado" = 'EN_USO';
CREATE UNIQUE INDEX "UsoVehiculo_empleado_en_uso_unica"
  ON "UsoVehiculo"("empleadoId") WHERE "estado" = 'EN_USO';
