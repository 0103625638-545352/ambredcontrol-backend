-- CreateEnum
CREATE TYPE "EstadoCajaSesion" AS ENUM ('ABIERTA', 'CERRADA');

-- CreateEnum
CREATE TYPE "TipoMovimientoCaja" AS ENUM ('INGRESO', 'EGRESO');

-- CreateTable
CREATE TABLE "CajaSesion" (
    "id" SERIAL NOT NULL,
    "sucursalId" INTEGER NOT NULL,
    "estado" "EstadoCajaSesion" NOT NULL DEFAULT 'ABIERTA',
    "montoInicial" DECIMAL(10,2) NOT NULL,
    "abiertaPorId" INTEGER NOT NULL,
    "abiertaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cerradaPorId" INTEGER,
    "cerradaEn" TIMESTAMP(3),
    "montoContado" DECIMAL(10,2),
    "montoEsperado" DECIMAL(10,2),
    "diferencia" DECIMAL(10,2),
    "observacionesCierre" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CajaSesion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MovimientoCaja" (
    "id" SERIAL NOT NULL,
    "cajaSesionId" INTEGER NOT NULL,
    "tipo" "TipoMovimientoCaja" NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "motivo" TEXT NOT NULL,
    "usuarioId" INTEGER NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MovimientoCaja_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CajaSesion" ADD CONSTRAINT "CajaSesion_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "Sucursal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CajaSesion" ADD CONSTRAINT "CajaSesion_abiertaPorId_fkey" FOREIGN KEY ("abiertaPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CajaSesion" ADD CONSTRAINT "CajaSesion_cerradaPorId_fkey" FOREIGN KEY ("cerradaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovimientoCaja" ADD CONSTRAINT "MovimientoCaja_cajaSesionId_fkey" FOREIGN KEY ("cajaSesionId") REFERENCES "CajaSesion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovimientoCaja" ADD CONSTRAINT "MovimientoCaja_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariante de negocio: como mucho una CajaSesion ABIERTA por sucursal a la
-- vez. Prisma no soporta índices parciales en su DSL, así que se agrega a
-- mano acá (ver comentario en schema.prisma sobre CajaSesion).
CREATE UNIQUE INDEX "CajaSesion_sucursal_abierta_unica"
  ON "CajaSesion"("sucursalId") WHERE "estado" = 'ABIERTA';
