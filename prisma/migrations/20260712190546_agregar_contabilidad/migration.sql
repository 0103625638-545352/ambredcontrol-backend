-- CreateEnum
CREATE TYPE "TipoCuentaContable" AS ENUM ('ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'COSTO', 'GASTO');

-- CreateEnum
CREATE TYPE "NaturalezaCuenta" AS ENUM ('DEUDORA', 'ACREEDORA');

-- CreateEnum
CREATE TYPE "OrigenAsiento" AS ENUM ('FACTURA', 'NOTA_VENTA', 'NOTA_CREDITO', 'COMPRA', 'PAGO', 'MOVIMIENTO_CAJA', 'MANUAL');

-- CreateTable
CREATE TABLE "CuentaContable" (
    "id" SERIAL NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" "TipoCuentaContable" NOT NULL,
    "naturaleza" "NaturalezaCuenta" NOT NULL,
    "cuentaPadreId" INTEGER,
    "permiteMovimiento" BOOLEAN NOT NULL DEFAULT true,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CuentaContable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AsientoContable" (
    "id" SERIAL NOT NULL,
    "numero" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "descripcion" TEXT NOT NULL,
    "origen" "OrigenAsiento" NOT NULL,
    "origenId" INTEGER,
    "asientoRevertidoId" INTEGER,
    "usuarioId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AsientoContable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineaAsiento" (
    "id" SERIAL NOT NULL,
    "asientoId" INTEGER NOT NULL,
    "cuentaId" INTEGER NOT NULL,
    "debe" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "haber" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "glosa" TEXT,

    CONSTRAINT "LineaAsiento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CuentaContable_codigo_key" ON "CuentaContable"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "AsientoContable_numero_key" ON "AsientoContable"("numero");

-- CreateIndex
CREATE UNIQUE INDEX "AsientoContable_asientoRevertidoId_key" ON "AsientoContable"("asientoRevertidoId");

-- AddForeignKey
ALTER TABLE "CuentaContable" ADD CONSTRAINT "CuentaContable_cuentaPadreId_fkey" FOREIGN KEY ("cuentaPadreId") REFERENCES "CuentaContable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsientoContable" ADD CONSTRAINT "AsientoContable_asientoRevertidoId_fkey" FOREIGN KEY ("asientoRevertidoId") REFERENCES "AsientoContable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsientoContable" ADD CONSTRAINT "AsientoContable_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaAsiento" ADD CONSTRAINT "LineaAsiento_asientoId_fkey" FOREIGN KEY ("asientoId") REFERENCES "AsientoContable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaAsiento" ADD CONSTRAINT "LineaAsiento_cuentaId_fkey" FOREIGN KEY ("cuentaId") REFERENCES "CuentaContable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
