-- AlterTable
ALTER TABLE "Usuario" ADD COLUMN     "permisos" TEXT[] DEFAULT ARRAY[]::TEXT[];
