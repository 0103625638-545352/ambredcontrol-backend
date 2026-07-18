-- CreateTable
CREATE TABLE "GuiaRemision" (
    "id" SERIAL NOT NULL,
    "secuencial" TEXT NOT NULL,
    "claveAcceso" TEXT,
    "fechaEmision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "facturaId" INTEGER NOT NULL,
    "destinatarioTipoIdentificacion" TEXT NOT NULL,
    "destinatarioIdentificacion" TEXT NOT NULL,
    "destinatarioRazonSocial" TEXT NOT NULL,
    "destinatarioDireccion" TEXT NOT NULL,
    "motivoTraslado" TEXT NOT NULL,
    "ruta" TEXT,
    "dirPartida" TEXT NOT NULL,
    "transportistaTipoIdentificacion" TEXT NOT NULL,
    "transportistaIdentificacion" TEXT NOT NULL,
    "transportistaRazonSocial" TEXT NOT NULL,
    "placa" TEXT NOT NULL,
    "fechaIniTransporte" TIMESTAMP(3) NOT NULL,
    "fechaFinTransporte" TIMESTAMP(3) NOT NULL,
    "estado" "EstadoFactura" NOT NULL DEFAULT 'CREADA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuiaRemision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuiaRemisionDetalle" (
    "id" SERIAL NOT NULL,
    "guiaRemisionId" INTEGER NOT NULL,
    "productoId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "descripcion" TEXT NOT NULL,

    CONSTRAINT "GuiaRemisionDetalle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuiaRemision_secuencial_key" ON "GuiaRemision"("secuencial");

-- CreateIndex
CREATE UNIQUE INDEX "GuiaRemision_claveAcceso_key" ON "GuiaRemision"("claveAcceso");

-- AddForeignKey
ALTER TABLE "GuiaRemision" ADD CONSTRAINT "GuiaRemision_facturaId_fkey" FOREIGN KEY ("facturaId") REFERENCES "Factura"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuiaRemisionDetalle" ADD CONSTRAINT "GuiaRemisionDetalle_guiaRemisionId_fkey" FOREIGN KEY ("guiaRemisionId") REFERENCES "GuiaRemision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuiaRemisionDetalle" ADD CONSTRAINT "GuiaRemisionDetalle_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
