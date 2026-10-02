-- AlterTable
ALTER TABLE "NodoRed" ADD COLUMN     "latitud" DECIMAL(10,7),
ADD COLUMN     "longitud" DECIMAL(10,7);

-- CreateTable
CREATE TABLE "CajaFibra" (
    "id" SERIAL NOT NULL,
    "codigo" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "latitud" DECIMAL(10,7) NOT NULL,
    "longitud" DECIMAL(10,7) NOT NULL,
    "capacidadPuertos" INTEGER,
    "descripcion" TEXT,
    "nodoId" INTEGER,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CajaFibra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TendidoFibra" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT,
    "tipo" TEXT NOT NULL,
    "trazado" JSONB NOT NULL,
    "origenCajaId" INTEGER,
    "destinoCajaId" INTEGER,
    "nodoId" INTEGER,
    "estado" TEXT NOT NULL DEFAULT 'ACTIVO',
    "colorHex" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TendidoFibra_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CajaFibra" ADD CONSTRAINT "CajaFibra_nodoId_fkey" FOREIGN KEY ("nodoId") REFERENCES "NodoRed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TendidoFibra" ADD CONSTRAINT "TendidoFibra_origenCajaId_fkey" FOREIGN KEY ("origenCajaId") REFERENCES "CajaFibra"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TendidoFibra" ADD CONSTRAINT "TendidoFibra_destinoCajaId_fkey" FOREIGN KEY ("destinoCajaId") REFERENCES "CajaFibra"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TendidoFibra" ADD CONSTRAINT "TendidoFibra_nodoId_fkey" FOREIGN KEY ("nodoId") REFERENCES "NodoRed"("id") ON DELETE SET NULL ON UPDATE CASCADE;
