-- DropForeignKey
ALTER TABLE "AlertaRed" DROP CONSTRAINT "AlertaRed_oltId_fkey";

-- AlterTable
ALTER TABLE "AlertaRed" ADD COLUMN     "nodoId" INTEGER,
ALTER COLUMN "oltId" DROP NOT NULL,
ALTER COLUMN "slot" DROP NOT NULL,
ALTER COLUMN "puerto" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ChequeoNodo" (
    "id" SERIAL NOT NULL,
    "nodoId" INTEGER NOT NULL,
    "enLinea" BOOLEAN NOT NULL,
    "latenciaMs" INTEGER,
    "error" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChequeoNodo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChequeoNodo_nodoId_fecha_idx" ON "ChequeoNodo"("nodoId", "fecha");

-- AddForeignKey
ALTER TABLE "AlertaRed" ADD CONSTRAINT "AlertaRed_oltId_fkey" FOREIGN KEY ("oltId") REFERENCES "Olt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertaRed" ADD CONSTRAINT "AlertaRed_nodoId_fkey" FOREIGN KEY ("nodoId") REFERENCES "NodoRed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChequeoNodo" ADD CONSTRAINT "ChequeoNodo_nodoId_fkey" FOREIGN KEY ("nodoId") REFERENCES "NodoRed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
