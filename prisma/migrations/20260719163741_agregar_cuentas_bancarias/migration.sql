-- AlterTable
ALTER TABLE "Pago" ADD COLUMN     "cuentaBancariaId" INTEGER;

-- CreateTable
CREATE TABLE "CuentaBancaria" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "banco" TEXT NOT NULL,
    "numeroCuenta" TEXT NOT NULL,
    "tipoCuenta" TEXT NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CuentaBancaria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CuentaBancaria_banco_numeroCuenta_key" ON "CuentaBancaria"("banco", "numeroCuenta");

-- AddForeignKey
ALTER TABLE "Pago" ADD CONSTRAINT "Pago_cuentaBancariaId_fkey" FOREIGN KEY ("cuentaBancariaId") REFERENCES "CuentaBancaria"("id") ON DELETE SET NULL ON UPDATE CASCADE;
