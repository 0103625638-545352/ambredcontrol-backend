-- AlterTable
ALTER TABLE "Cliente" ADD COLUMN     "activo" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "fechaBaja" TIMESTAMP(3),
ADD COLUMN     "fechaInicioServicio" TIMESTAMP(3),
ADD COLUMN     "motivoBaja" TEXT,
ADD COLUMN     "vigenciaContratoMeses" INTEGER;
