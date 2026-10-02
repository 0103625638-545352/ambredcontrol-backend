-- CreateEnum
CREATE TYPE "EstadoTicket" AS ENUM ('ABIERTO', 'EN_PROCESO', 'RESUELTO', 'CANCELADO');

-- AlterTable
ALTER TABLE "AsignacionMetraje" ADD COLUMN     "metrosDevueltosFisicos" INTEGER,
ADD COLUMN     "metrosFaltantes" INTEGER;

-- CreateTable
CREATE TABLE "LecturaSenalOnu" (
    "id" SERIAL NOT NULL,
    "oltOnuId" INTEGER NOT NULL,
    "rxPowerDbm" DECIMAL(6,2) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LecturaSenalOnu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertaRed" (
    "id" SERIAL NOT NULL,
    "tipo" TEXT NOT NULL,
    "oltId" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "puerto" INTEGER NOT NULL,
    "oltOnuId" INTEGER,
    "cantidadAfectadas" INTEGER NOT NULL DEFAULT 1,
    "mensaje" TEXT NOT NULL,
    "fechaInicio" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechaFin" TIMESTAMP(3),
    "cerradaManualmente" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AlertaRed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketSoporte" (
    "id" SERIAL NOT NULL,
    "clienteId" INTEGER,
    "nombreContacto" TEXT NOT NULL,
    "telefono" TEXT,
    "canal" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "prioridad" TEXT NOT NULL DEFAULT 'MEDIA',
    "asunto" TEXT NOT NULL,
    "estado" "EstadoTicket" NOT NULL DEFAULT 'ABIERTO',
    "asignadoEmpleadoId" INTEGER,
    "visitaTecnicaId" INTEGER,
    "alertaRedId" INTEGER,
    "solucion" TEXT,
    "creadoPorUsuarioId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechaPrimeraAtencion" TIMESTAMP(3),
    "fechaResolucion" TIMESTAMP(3),

    CONSTRAINT "TicketSoporte_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MensajeTicket" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "autor" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "usuarioId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MensajeTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EncuestaVisita" (
    "id" SERIAL NOT NULL,
    "visitaId" INTEGER NOT NULL,
    "telefono" TEXT NOT NULL,
    "enviadaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calificacion" INTEGER,
    "comentario" TEXT,
    "respondidaEn" TIMESTAMP(3),

    CONSTRAINT "EncuestaVisita_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventoServicioInternet" (
    "id" SERIAL NOT NULL,
    "clienteId" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "origen" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventoServicioInternet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LecturaSenalOnu_oltOnuId_fecha_idx" ON "LecturaSenalOnu"("oltOnuId", "fecha");

-- CreateIndex
CREATE INDEX "AlertaRed_oltId_slot_puerto_tipo_idx" ON "AlertaRed"("oltId", "slot", "puerto", "tipo");

-- CreateIndex
CREATE UNIQUE INDEX "TicketSoporte_visitaTecnicaId_key" ON "TicketSoporte"("visitaTecnicaId");

-- CreateIndex
CREATE INDEX "TicketSoporte_estado_idx" ON "TicketSoporte"("estado");

-- CreateIndex
CREATE INDEX "TicketSoporte_telefono_idx" ON "TicketSoporte"("telefono");

-- CreateIndex
CREATE UNIQUE INDEX "EncuestaVisita_visitaId_key" ON "EncuestaVisita"("visitaId");

-- CreateIndex
CREATE INDEX "EncuestaVisita_telefono_idx" ON "EncuestaVisita"("telefono");

-- CreateIndex
CREATE INDEX "EventoServicioInternet_clienteId_fecha_idx" ON "EventoServicioInternet"("clienteId", "fecha");

-- CreateIndex
CREATE INDEX "EventoServicioInternet_fecha_idx" ON "EventoServicioInternet"("fecha");

-- AddForeignKey
ALTER TABLE "LecturaSenalOnu" ADD CONSTRAINT "LecturaSenalOnu_oltOnuId_fkey" FOREIGN KEY ("oltOnuId") REFERENCES "OltOnu"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertaRed" ADD CONSTRAINT "AlertaRed_oltId_fkey" FOREIGN KEY ("oltId") REFERENCES "Olt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSoporte" ADD CONSTRAINT "TicketSoporte_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSoporte" ADD CONSTRAINT "TicketSoporte_asignadoEmpleadoId_fkey" FOREIGN KEY ("asignadoEmpleadoId") REFERENCES "Empleado"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSoporte" ADD CONSTRAINT "TicketSoporte_visitaTecnicaId_fkey" FOREIGN KEY ("visitaTecnicaId") REFERENCES "VisitaTecnica"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSoporte" ADD CONSTRAINT "TicketSoporte_alertaRedId_fkey" FOREIGN KEY ("alertaRedId") REFERENCES "AlertaRed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSoporte" ADD CONSTRAINT "TicketSoporte_creadoPorUsuarioId_fkey" FOREIGN KEY ("creadoPorUsuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MensajeTicket" ADD CONSTRAINT "MensajeTicket_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "TicketSoporte"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MensajeTicket" ADD CONSTRAINT "MensajeTicket_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EncuestaVisita" ADD CONSTRAINT "EncuestaVisita_visitaId_fkey" FOREIGN KEY ("visitaId") REFERENCES "VisitaTecnica"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventoServicioInternet" ADD CONSTRAINT "EventoServicioInternet_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
