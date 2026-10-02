-- CreateTable
CREATE TABLE "Olt" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "direccionIp" TEXT NOT NULL,
    "snmpPuerto" INTEGER NOT NULL DEFAULT 161,
    "snmpVersion" TEXT NOT NULL DEFAULT '2c',
    "snmpComunidad" TEXT,
    "snmpUsuario" TEXT,
    "snmpAuthProtocolo" TEXT,
    "snmpAuthPassword" TEXT,
    "snmpPrivProtocolo" TEXT,
    "snmpPrivPassword" TEXT,
    "ubicacion" TEXT,
    "nodoId" INTEGER,
    "ultimaConexionExitosa" TIMESTAMP(3),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Olt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OltOnu" (
    "id" SERIAL NOT NULL,
    "oltId" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "puerto" INTEGER NOT NULL,
    "onuIndex" INTEGER NOT NULL,
    "serial" TEXT NOT NULL,
    "descripcion" TEXT,
    "clienteId" INTEGER,
    "estado" TEXT,
    "rxPowerDbm" DECIMAL(6,2),
    "txPowerDbm" DECIMAL(6,2),
    "ultimaLectura" TIMESTAMP(3),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OltOnu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OltEvento" (
    "id" SERIAL NOT NULL,
    "oltId" INTEGER NOT NULL,
    "oltOnuId" INTEGER,
    "tipo" TEXT NOT NULL,
    "mensaje" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OltEvento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OltOnu_oltId_slot_puerto_onuIndex_key" ON "OltOnu"("oltId", "slot", "puerto", "onuIndex");

-- AddForeignKey
ALTER TABLE "Olt" ADD CONSTRAINT "Olt_nodoId_fkey" FOREIGN KEY ("nodoId") REFERENCES "NodoRed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OltOnu" ADD CONSTRAINT "OltOnu_oltId_fkey" FOREIGN KEY ("oltId") REFERENCES "Olt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OltOnu" ADD CONSTRAINT "OltOnu_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OltEvento" ADD CONSTRAINT "OltEvento_oltId_fkey" FOREIGN KEY ("oltId") REFERENCES "Olt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OltEvento" ADD CONSTRAINT "OltEvento_oltOnuId_fkey" FOREIGN KEY ("oltOnuId") REFERENCES "OltOnu"("id") ON DELETE SET NULL ON UPDATE CASCADE;
