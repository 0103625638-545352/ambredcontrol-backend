-- AlterTable
ALTER TABLE "Cliente" ADD COLUMN     "pingUltimaMedicion" TIMESTAMP(3),
ADD COLUMN     "pingUltimoEstado" TEXT,
ADD COLUMN     "pingUltimoMs" INTEGER;
