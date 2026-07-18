-- AlterTable
ALTER TABLE "Cliente" ADD COLUMN     "planInternetId" INTEGER,
ADD COLUMN     "usuarioPppoe" TEXT;

-- CreateTable
CREATE TABLE "PlanInternet" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "velocidadSubida" TEXT NOT NULL,
    "velocidadBajada" TEXT NOT NULL,
    "precio" DECIMAL(10,2) NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanInternet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Cliente_usuarioPppoe_key" ON "Cliente"("usuarioPppoe");

-- AddForeignKey
ALTER TABLE "Cliente" ADD CONSTRAINT "Cliente_planInternetId_fkey" FOREIGN KEY ("planInternetId") REFERENCES "PlanInternet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

