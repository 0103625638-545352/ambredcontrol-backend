-- CreateTable
CREATE TABLE "RetencionRecibida" (
    "id" SERIAL NOT NULL,
    "numeroComprobante" TEXT NOT NULL,
    "fechaEmision" TIMESTAMP(3) NOT NULL,
    "facturaId" INTEGER NOT NULL,
    "totalIva" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "totalRenta" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "total" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetencionRecibida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetencionRecibidaDetalle" (
    "id" SERIAL NOT NULL,
    "retencionRecibidaId" INTEGER NOT NULL,
    "tipoImpuesto" "TipoImpuestoRetenido" NOT NULL,
    "clasificacion" "ClasificacionRetencion" NOT NULL,
    "codigoRetencion" TEXT NOT NULL,
    "baseImponible" DECIMAL(10,2) NOT NULL,
    "porcentaje" DECIMAL(5,2) NOT NULL,
    "valorRetenido" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "RetencionRecibidaDetalle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RetencionRecibida_facturaId_key" ON "RetencionRecibida"("facturaId");

-- AddForeignKey
ALTER TABLE "RetencionRecibida" ADD CONSTRAINT "RetencionRecibida_facturaId_fkey" FOREIGN KEY ("facturaId") REFERENCES "Factura"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetencionRecibidaDetalle" ADD CONSTRAINT "RetencionRecibidaDetalle_retencionRecibidaId_fkey" FOREIGN KEY ("retencionRecibidaId") REFERENCES "RetencionRecibida"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
