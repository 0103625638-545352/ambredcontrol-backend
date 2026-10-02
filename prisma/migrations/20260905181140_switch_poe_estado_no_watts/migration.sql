/*
  Warnings:

  - You are about to drop the column `poePotenciaWatts` on the `SwitchPuerto` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "SwitchPuerto" DROP COLUMN "poePotenciaWatts",
ADD COLUMN     "poeEstado" TEXT;
