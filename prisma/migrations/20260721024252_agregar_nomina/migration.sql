-- AlterTable
ALTER TABLE "Sucursal" ADD COLUMN     "region" TEXT NOT NULL DEFAULT 'SIERRA_ORIENTE';

-- CreateTable
CREATE TABLE "Empleado" (
    "id" SERIAL NOT NULL,
    "cedula" TEXT NOT NULL,
    "nombres" TEXT NOT NULL,
    "apellidos" TEXT NOT NULL,
    "cargo" TEXT NOT NULL,
    "fechaIngreso" TIMESTAMP(3) NOT NULL,
    "fechaSalida" TIMESTAMP(3),
    "sueldoMensual" DECIMAL(10,2) NOT NULL,
    "sucursalId" INTEGER,
    "cargasFamiliares" INTEGER NOT NULL DEFAULT 0,
    "fondoReservaMensualizado" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Empleado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolDePagos" (
    "id" SERIAL NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "anio" INTEGER NOT NULL,
    "mes" INTEGER NOT NULL,
    "sueldoBase" DECIMAL(10,2) NOT NULL,
    "horasSuplementarias" INTEGER NOT NULL DEFAULT 0,
    "horasExtraordinarias" INTEGER NOT NULL DEFAULT 0,
    "valorHorasSuplementarias" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "valorHorasExtraordinarias" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "otrosIngresos" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "fondoReservaValor" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "totalIngresos" DECIMAL(10,2) NOT NULL,
    "aportePersonalIess" DECIMAL(10,2) NOT NULL,
    "aportePatronalIess" DECIMAL(10,2) NOT NULL,
    "otrosDescuentos" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "otrosDescuentosDetalle" TEXT,
    "totalDescuentos" DECIMAL(10,2) NOT NULL,
    "netoAPagar" DECIMAL(10,2) NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "fechaPago" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolDePagos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecimoTercero" (
    "id" SERIAL NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "anio" INTEGER NOT NULL,
    "totalIngresosPeriodo" DECIMAL(10,2) NOT NULL,
    "valor" DECIMAL(10,2) NOT NULL,
    "mensualizado" BOOLEAN NOT NULL DEFAULT false,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "fechaPago" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecimoTercero_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecimoCuarto" (
    "id" SERIAL NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "anio" INTEGER NOT NULL,
    "region" TEXT NOT NULL,
    "mesesLaborados" INTEGER NOT NULL,
    "valor" DECIMAL(10,2) NOT NULL,
    "mensualizado" BOOLEAN NOT NULL DEFAULT false,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "fechaPago" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecimoCuarto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vacacion" (
    "id" SERIAL NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "fechaInicio" TIMESTAMP(3) NOT NULL,
    "fechaFin" TIMESTAMP(3) NOT NULL,
    "diasTomados" INTEGER NOT NULL,
    "valorPagado" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vacacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Utilidad" (
    "id" SERIAL NOT NULL,
    "anio" INTEGER NOT NULL,
    "utilidadNetaEmpresa" DECIMAL(10,2) NOT NULL,
    "monto15Porciento" DECIMAL(10,2) NOT NULL,
    "fechaCalculo" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Utilidad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UtilidadDetalle" (
    "id" SERIAL NOT NULL,
    "utilidadId" INTEGER NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "diasTrabajados" INTEGER NOT NULL,
    "valorPorDias" DECIMAL(10,2) NOT NULL,
    "valorPorCargas" DECIMAL(10,2) NOT NULL,
    "totalEmpleado" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "UtilidadDetalle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Liquidacion" (
    "id" SERIAL NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "fechaSalida" TIMESTAMP(3) NOT NULL,
    "motivoSalida" TEXT NOT NULL,
    "aniosServicio" DECIMAL(5,2) NOT NULL,
    "vacacionesPendientesDias" INTEGER NOT NULL,
    "vacacionesPendientesValor" DECIMAL(10,2) NOT NULL,
    "decimoTerceroProporcional" DECIMAL(10,2) NOT NULL,
    "decimoCuartoProporcional" DECIMAL(10,2) NOT NULL,
    "indemnizacion" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "bonificacionDesahucio" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "totalLiquidacion" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Liquidacion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Empleado_cedula_key" ON "Empleado"("cedula");

-- CreateIndex
CREATE UNIQUE INDEX "RolDePagos_empleadoId_anio_mes_key" ON "RolDePagos"("empleadoId", "anio", "mes");

-- CreateIndex
CREATE UNIQUE INDEX "DecimoTercero_empleadoId_anio_key" ON "DecimoTercero"("empleadoId", "anio");

-- CreateIndex
CREATE UNIQUE INDEX "DecimoCuarto_empleadoId_anio_key" ON "DecimoCuarto"("empleadoId", "anio");

-- CreateIndex
CREATE UNIQUE INDEX "Utilidad_anio_key" ON "Utilidad"("anio");

-- CreateIndex
CREATE UNIQUE INDEX "UtilidadDetalle_utilidadId_empleadoId_key" ON "UtilidadDetalle"("utilidadId", "empleadoId");

-- CreateIndex
CREATE UNIQUE INDEX "Liquidacion_empleadoId_key" ON "Liquidacion"("empleadoId");

-- AddForeignKey
ALTER TABLE "Empleado" ADD CONSTRAINT "Empleado_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "Sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolDePagos" ADD CONSTRAINT "RolDePagos_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecimoTercero" ADD CONSTRAINT "DecimoTercero_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecimoCuarto" ADD CONSTRAINT "DecimoCuarto_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vacacion" ADD CONSTRAINT "Vacacion_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilidadDetalle" ADD CONSTRAINT "UtilidadDetalle_utilidadId_fkey" FOREIGN KEY ("utilidadId") REFERENCES "Utilidad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilidadDetalle" ADD CONSTRAINT "UtilidadDetalle_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liquidacion" ADD CONSTRAINT "Liquidacion_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
