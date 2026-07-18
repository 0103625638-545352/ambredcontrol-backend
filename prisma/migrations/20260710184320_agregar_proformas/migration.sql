-- CreateEnum
CREATE TYPE "EstadoProforma" AS ENUM ('CREADA', 'ANULADA', 'CONVERTIDA');

-- CreateTable
CREATE TABLE "Proforma" (
    "id" SERIAL NOT NULL,
    "secuencial" TEXT NOT NULL,
    "fechaEmision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validaHasta" TIMESTAMP(3),
    "clienteId" INTEGER NOT NULL,
    "subtotal0" DECIMAL(10,2) NOT NULL,
    "subtotal12" DECIMAL(10,2) NOT NULL,
    "iva" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "estado" "EstadoProforma" NOT NULL DEFAULT 'CREADA',
    "facturaConvertidaId" INTEGER,
    "notaVentaConvertidaId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Proforma_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProformaDetalle" (
    "id" SERIAL NOT NULL,
    "proformaId" INTEGER NOT NULL,
    "productoId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "precioUnitario" DECIMAL(10,2) NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "ivaValor" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "ProformaDetalle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Proforma_secuencial_key" ON "Proforma"("secuencial");

-- CreateIndex
CREATE UNIQUE INDEX "Proforma_facturaConvertidaId_key" ON "Proforma"("facturaConvertidaId");

-- CreateIndex
CREATE UNIQUE INDEX "Proforma_notaVentaConvertidaId_key" ON "Proforma"("notaVentaConvertidaId");

-- AddForeignKey
ALTER TABLE "Proforma" ADD CONSTRAINT "Proforma_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proforma" ADD CONSTRAINT "Proforma_facturaConvertidaId_fkey" FOREIGN KEY ("facturaConvertidaId") REFERENCES "Factura"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proforma" ADD CONSTRAINT "Proforma_notaVentaConvertidaId_fkey" FOREIGN KEY ("notaVentaConvertidaId") REFERENCES "NotaVenta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProformaDetalle" ADD CONSTRAINT "ProformaDetalle_proformaId_fkey" FOREIGN KEY ("proformaId") REFERENCES "Proforma"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProformaDetalle" ADD CONSTRAINT "ProformaDetalle_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
