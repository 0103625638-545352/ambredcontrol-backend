-- CreateTable
CREATE TABLE "SwitchCliente" (
    "id" SERIAL NOT NULL,
    "clienteId" INTEGER NOT NULL,
    "direccionIp" TEXT NOT NULL,
    "modelo" TEXT,
    "cantidadPuertos" INTEGER NOT NULL DEFAULT 8,
    "snmpPuerto" INTEGER NOT NULL DEFAULT 161,
    "snmpVersion" TEXT NOT NULL DEFAULT '2c',
    "snmpComunidad" TEXT DEFAULT 'public',
    "snmpUsuario" TEXT,
    "snmpAuthProtocolo" TEXT,
    "snmpAuthPassword" TEXT,
    "snmpPrivProtocolo" TEXT,
    "snmpPrivPassword" TEXT,
    "ultimaConexionExitosa" TIMESTAMP(3),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SwitchCliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SwitchPuerto" (
    "id" SERIAL NOT NULL,
    "switchId" INTEGER NOT NULL,
    "numeroPuerto" INTEGER NOT NULL,
    "estado" TEXT,
    "velocidadMbps" INTEGER,
    "contadorEntradaBytes" BIGINT,
    "contadorSalidaBytes" BIGINT,
    "trafficEntradaBps" INTEGER,
    "trafficSalidaBps" INTEGER,
    "poePotenciaWatts" DECIMAL(5,2),
    "ultimaLectura" TIMESTAMP(3),

    CONSTRAINT "SwitchPuerto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SwitchEvento" (
    "id" SERIAL NOT NULL,
    "switchId" INTEGER NOT NULL,
    "switchPuertoId" INTEGER,
    "tipo" TEXT NOT NULL,
    "mensaje" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SwitchEvento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SwitchCliente_clienteId_key" ON "SwitchCliente"("clienteId");

-- CreateIndex
CREATE UNIQUE INDEX "SwitchPuerto_switchId_numeroPuerto_key" ON "SwitchPuerto"("switchId", "numeroPuerto");

-- AddForeignKey
ALTER TABLE "SwitchCliente" ADD CONSTRAINT "SwitchCliente_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SwitchPuerto" ADD CONSTRAINT "SwitchPuerto_switchId_fkey" FOREIGN KEY ("switchId") REFERENCES "SwitchCliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SwitchEvento" ADD CONSTRAINT "SwitchEvento_switchId_fkey" FOREIGN KEY ("switchId") REFERENCES "SwitchCliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SwitchEvento" ADD CONSTRAINT "SwitchEvento_switchPuertoId_fkey" FOREIGN KEY ("switchPuertoId") REFERENCES "SwitchPuerto"("id") ON DELETE SET NULL ON UPDATE CASCADE;
