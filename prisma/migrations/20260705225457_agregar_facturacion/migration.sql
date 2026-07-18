-- CreateEnum
CREATE TYPE "EstadoFactura" AS ENUM ('CREADA', 'ENVIADA', 'AUTORIZADA', 'RECHAZADA', 'ANULADA');

-- CreateTable
CREATE TABLE "Cliente" (
    "id" SERIAL NOT NULL,
    "tipoIdentificacion" TEXT NOT NULL DEFAULT 'CEDULA',
    "identificacion" TEXT NOT NULL,
    "razonSocial" TEXT NOT NULL,
    "direccion" TEXT,
    "email" TEXT,
    "telefono" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Factura" (
    "id" SERIAL NOT NULL,
    "secuencial" TEXT NOT NULL,
    "fechaEmision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clienteId" INTEGER NOT NULL,
    "subtotal0" DECIMAL(10,2) NOT NULL,
    "subtotal12" DECIMAL(10,2) NOT NULL,
    "iva" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "estado" "EstadoFactura" NOT NULL DEFAULT 'CREADA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Factura_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacturaDetalle" (
    "id" SERIAL NOT NULL,
    "facturaId" INTEGER NOT NULL,
    "productoId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "precioUnitario" DECIMAL(10,2) NOT NULL,
    "descuento" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "ivaValor" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "FacturaDetalle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Secuencial" (
    "id" SERIAL NOT NULL,
    "puntoVenta" TEXT NOT NULL DEFAULT '001',
    "establecimiento" TEXT NOT NULL DEFAULT '001',
    "ultimoNumero" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Secuencial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Cliente_identificacion_key" ON "Cliente"("identificacion");

-- CreateIndex
CREATE UNIQUE INDEX "Factura_secuencial_key" ON "Factura"("secuencial");

-- CreateIndex
CREATE UNIQUE INDEX "Secuencial_puntoVenta_establecimiento_key" ON "Secuencial"("puntoVenta", "establecimiento");

-- AddForeignKey
ALTER TABLE "Factura" ADD CONSTRAINT "Factura_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacturaDetalle" ADD CONSTRAINT "FacturaDetalle_facturaId_fkey" FOREIGN KEY ("facturaId") REFERENCES "Factura"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacturaDetalle" ADD CONSTRAINT "FacturaDetalle_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
