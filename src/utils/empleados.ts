// Selección segura de Empleado para cuando aparece como relación ANIDADA
// dentro de otro documento (RolDePagos, DecimoTercero/Cuarto, Vacacion,
// Utilidad, Liquidacion, Marcacion) — a diferencia de routes/empleados.ts
// (que sí necesita pinHash internamente para derivar "tienePin"), estos
// lugares solo muestran nombre/cargo/etc. y NUNCA deben poder filtrar
// pinHash/intentosFallidosPin/bloqueadoHastaPin sin querer por un simple
// "include: { empleado: true }" (que trae TODOS los campos escalares del
// modelo, pin incluido). Usar siempre "include: { empleado: { select:
// SELECT_EMPLEADO_SEGURO } } }" en vez de "include: { empleado: true }".
export const SELECT_EMPLEADO_SEGURO = {
  id: true,
  cedula: true,
  nombres: true,
  apellidos: true,
  cargo: true,
  fechaIngreso: true,
  fechaSalida: true,
  sueldoMensual: true,
  sucursalId: true,
  // Necesaria para comparar visualmente la ubicación de una marcación
  // contra la geocerca de la sucursal del empleado (ver GET /marcaciones y
  // components/MapaMarcacion.tsx en el frontend) — no es información
  // sensible, a diferencia del pin.
  sucursal: true,
  cargasFamiliares: true,
  fondoReservaMensualizado: true,
  horaEntradaEsperada: true,
  horaSalidaEsperada: true,
  activo: true,
  createdAt: true,
} as const;
