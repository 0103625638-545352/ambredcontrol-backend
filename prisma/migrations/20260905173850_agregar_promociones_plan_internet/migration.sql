-- CreateEnum
CREATE TYPE "AlcancePromocion" AS ENUM ('TODOS_LOS_CLIENTES', 'CLIENTES_NUEVOS');

-- CreateTable
CREATE TABLE "PromocionPlan" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "porcentajeDescuento" DECIMAL(5,2) NOT NULL,
    "fechaInicio" TIMESTAMP(3) NOT NULL,
    "fechaFin" TIMESTAMP(3),
    "alcance" "AlcancePromocion" NOT NULL DEFAULT 'TODOS_LOS_CLIENTES',
    "mesesDesdeContrato" INTEGER,
    "planInternetId" INTEGER,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromocionPlan_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "PromocionPlan" ADD CONSTRAINT "PromocionPlan_planInternetId_fkey" FOREIGN KEY ("planInternetId") REFERENCES "PlanInternet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
