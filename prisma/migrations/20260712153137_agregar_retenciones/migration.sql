-- CreateEnum
CREATE TYPE "TipoImpuestoRetenido" AS ENUM ('IVA', 'RENTA');

-- CreateEnum
CREATE TYPE "ClasificacionRetencion" AS ENUM ('BIEN', 'SERVICIO');

-- CreateTable
CREATE TABLE "Retencion" (
    "id" SERIAL NOT NULL,
    "secuencial" TEXT NOT NULL,
    "claveAcceso" TEXT,
    "fechaEmision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodoFiscal" TEXT NOT NULL,
    "compraId" INTEGER NOT NULL,
    "totalIva" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "totalRenta" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "total" DECIMAL(10,2) NOT NULL,
    "estado" "EstadoFactura" NOT NULL DEFAULT 'CREADA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Retencion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetencionDetalle" (
    "id" SERIAL NOT NULL,
    "retencionId" INTEGER NOT NULL,
    "tipoImpuesto" "TipoImpuestoRetenido" NOT NULL,
    "clasificacion" "ClasificacionRetencion" NOT NULL,
    "codigoRetencion" TEXT NOT NULL,
    "baseImponible" DECIMAL(10,2) NOT NULL,
    "porcentaje" DECIMAL(5,2) NOT NULL,
    "valorRetenido" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "RetencionDetalle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Retencion_secuencial_key" ON "Retencion"("secuencial");

-- CreateIndex
CREATE UNIQUE INDEX "Retencion_claveAcceso_key" ON "Retencion"("claveAcceso");

-- CreateIndex
CREATE UNIQUE INDEX "Retencion_compraId_key" ON "Retencion"("compraId");

-- AddForeignKey
ALTER TABLE "Retencion" ADD CONSTRAINT "Retencion_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "Compra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetencionDetalle" ADD CONSTRAINT "RetencionDetalle_retencionId_fkey" FOREIGN KEY ("retencionId") REFERENCES "Retencion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
