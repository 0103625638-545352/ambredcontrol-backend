/*
  Warnings:

  - You are about to drop the column `bancoOrigen` on the `Pago` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Pago" DROP COLUMN "bancoOrigen",
ADD COLUMN     "bancoOrigenId" INTEGER;

-- CreateTable
CREATE TABLE "Banco" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Banco_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Banco_nombre_key" ON "Banco"("nombre");

-- AddForeignKey
ALTER TABLE "Pago" ADD CONSTRAINT "Pago_bancoOrigenId_fkey" FOREIGN KEY ("bancoOrigenId") REFERENCES "Banco"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed: bancos ecuatorianos más comunes, para que el catálogo no arranque
-- vacío — el admin puede agregar/desactivar más desde Administración > Bancos.
INSERT INTO "Banco" ("nombre") VALUES
    ('Banco Pichincha'),
    ('Banco Guayaquil'),
    ('Banco del Pacífico'),
    ('Produbanco'),
    ('Banco Internacional'),
    ('Banco Bolivariano'),
    ('Banco del Austro'),
    ('Banco de Loja'),
    ('Banco General Rumiñahui'),
    ('Banco Solidario'),
    ('Banco ProCredit'),
    ('Banco Machala'),
    ('Cooperativa JEP'),
    ('Cooperativa Policía Nacional'),
    ('Cooperativa 29 de Octubre')
ON CONFLICT ("nombre") DO NOTHING;
