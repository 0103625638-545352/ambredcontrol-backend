-- CreateTable
CREATE TABLE "RecordatorioInternetEnviado" (
    "id" SERIAL NOT NULL,
    "clienteId" INTEGER NOT NULL,
    "cicloInicio" TIMESTAMP(3) NOT NULL,
    "canal" TEXT NOT NULL DEFAULT 'whatsapp',
    "enviadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordatorioInternetEnviado_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecordatorioInternetEnviado_clienteId_cicloInicio_key" ON "RecordatorioInternetEnviado"("clienteId", "cicloInicio");

-- AddForeignKey
ALTER TABLE "RecordatorioInternetEnviado" ADD CONSTRAINT "RecordatorioInternetEnviado_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
