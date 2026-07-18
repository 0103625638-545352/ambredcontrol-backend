-- CreateTable
CREATE TABLE "RespaldoMikrotik" (
    "id" SERIAL NOT NULL,
    "nodoId" INTEGER NOT NULL,
    "contenido" JSONB NOT NULL,
    "totalInterfaceLists" INTEGER NOT NULL,
    "totalInterfaceListMembers" INTEGER NOT NULL,
    "totalReglasFiltro" INTEGER NOT NULL,
    "totalReglasNat" INTEGER NOT NULL,
    "totalEntradasAddressList" INTEGER NOT NULL,
    "usuarioId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RespaldoMikrotik_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "RespaldoMikrotik" ADD CONSTRAINT "RespaldoMikrotik_nodoId_fkey" FOREIGN KEY ("nodoId") REFERENCES "NodoRed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RespaldoMikrotik" ADD CONSTRAINT "RespaldoMikrotik_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
