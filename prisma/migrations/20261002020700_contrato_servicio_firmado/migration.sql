-- CreateTable
CREATE TABLE "ContratoServicio" (
    "id" SERIAL NOT NULL,
    "clienteId" INTEGER NOT NULL,
    "visitaId" INTEGER,
    "pdfUrl" TEXT NOT NULL,
    "nombreFirmante" TEXT NOT NULL,
    "cedulaFirmante" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "precioMensual" DECIMAL(10,2) NOT NULL,
    "vigenciaMeses" INTEGER,
    "latitud" DECIMAL(9,6),
    "longitud" DECIMAL(9,6),
    "registradoPorUsuarioId" INTEGER,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContratoServicio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContratoServicio_visitaId_key" ON "ContratoServicio"("visitaId");

-- CreateIndex
CREATE INDEX "ContratoServicio_clienteId_idx" ON "ContratoServicio"("clienteId");

-- AddForeignKey
ALTER TABLE "ContratoServicio" ADD CONSTRAINT "ContratoServicio_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContratoServicio" ADD CONSTRAINT "ContratoServicio_visitaId_fkey" FOREIGN KEY ("visitaId") REFERENCES "VisitaTecnica"("id") ON DELETE SET NULL ON UPDATE CASCADE;
