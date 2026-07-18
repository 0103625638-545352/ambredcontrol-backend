-- AlterTable
ALTER TABLE "Usuario" ADD COLUMN     "codigoRecuperacionExpira" TIMESTAMP(3),
ADD COLUMN     "codigoRecuperacionHash" TEXT,
ADD COLUMN     "codigoRecuperacionIntentos" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "email" TEXT;
