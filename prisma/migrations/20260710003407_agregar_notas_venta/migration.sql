-- CreateEnum
CREATE TYPE "EstadoNotaVenta" AS ENUM ('CREADA', 'ANULADA');

-- CreateTable
CREATE TABLE "NotaVenta" (
    "id" SERIAL NOT NULL,
    "secuencial" TEXT NOT NULL,
    "fechaEmision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clienteId" INTEGER NOT NULL,
    "subtotal0" DECIMAL(10,2) NOT NULL,
    "subtotal12" DECIMAL(10,2) NOT NULL,
    "iva" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "estado" "EstadoNotaVenta" NOT NULL DEFAULT 'CREADA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotaVenta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotaVentaDetalle" (
    "id" SERIAL NOT NULL,
    "notaVentaId" INTEGER NOT NULL,
    "productoId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "precioUnitario" DECIMAL(10,2) NOT NULL,
    "descuento" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "ivaValor" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "NotaVentaDetalle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotaVenta_secuencial_key" ON "NotaVenta"("secuencial");

-- AddForeignKey
ALTER TABLE "NotaVenta" ADD CONSTRAINT "NotaVenta_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotaVentaDetalle" ADD CONSTRAINT "NotaVentaDetalle_notaVentaId_fkey" FOREIGN KEY ("notaVentaId") REFERENCES "NotaVenta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotaVentaDetalle" ADD CONSTRAINT "NotaVentaDetalle_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
