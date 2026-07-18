-- DropIndex
DROP INDEX "Cliente_usuarioPppoe_key";

-- AlterTable
ALTER TABLE "Cliente" DROP COLUMN "usuarioPppoe",
ADD COLUMN     "direccionIp" TEXT;

-- AlterTable
ALTER TABLE "PlanInternet" ADD COLUMN     "codigoMikrotik" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Cliente_direccionIp_key" ON "Cliente"("direccionIp");

-- CreateIndex
CREATE UNIQUE INDEX "PlanInternet_codigoMikrotik_key" ON "PlanInternet"("codigoMikrotik");

