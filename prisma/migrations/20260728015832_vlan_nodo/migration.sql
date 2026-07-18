-- AlterTable
ALTER TABLE "Cliente" ADD COLUMN     "vlanNodoId" INTEGER;

-- CreateTable
CREATE TABLE "VlanNodo" (
    "id" SERIAL NOT NULL,
    "nodoId" INTEGER NOT NULL,
    "nombre" TEXT NOT NULL,
    "vlanId" INTEGER NOT NULL,
    "interfaz" TEXT,
    "mascaraRed" INTEGER,
    "rangoIpInicio" TEXT,
    "rangoIpFin" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VlanNodo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VlanNodo_nodoId_vlanId_key" ON "VlanNodo"("nodoId", "vlanId");

-- AddForeignKey
ALTER TABLE "Cliente" ADD CONSTRAINT "Cliente_vlanNodoId_fkey" FOREIGN KEY ("vlanNodoId") REFERENCES "VlanNodo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VlanNodo" ADD CONSTRAINT "VlanNodo_nodoId_fkey" FOREIGN KEY ("nodoId") REFERENCES "NodoRed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
