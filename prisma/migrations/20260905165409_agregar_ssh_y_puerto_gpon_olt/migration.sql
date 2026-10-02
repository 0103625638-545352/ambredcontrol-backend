-- AlterTable
ALTER TABLE "Olt" ADD COLUMN     "sshPassword" TEXT,
ADD COLUMN     "sshPuerto" INTEGER NOT NULL DEFAULT 22,
ADD COLUMN     "sshUsuario" TEXT;

-- AlterTable
ALTER TABLE "OltOnu" ADD COLUMN     "distanciaMetros" INTEGER,
ADD COLUMN     "frame" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ipGestion" TEXT,
ADD COLUMN     "temperaturaCelsius" DECIMAL(5,2);
