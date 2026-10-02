// Catálogo fijo de permisos configurables por usuario no-ADMIN. Un ADMIN
// siempre tiene acceso total y este catálogo no aplica a su cuenta.
//
// OJO: si en el futuro se agrega una clave nueva que gatee una ruta que HOY
// está abierta a cualquier usuario autenticado, hay que rellenar "permisos"
// para los usuarios existentes — el default [] solo es seguro mientras cada
// clave nueva de este catálogo mapea a algo que ya era admin-only antes.
// "categoria" agrupa la casilla en el formulario de Usuarios (ver
// CasillasPermisos en frontend/src/pages/UsuariosPage.tsx) — mismo orden que
// los grupos del menú lateral (Sidebar.tsx), para que sea obvio qué pantalla
// destraba cada permiso. No todo permiso mapea a una pestaña completa (ej.
// "Envío al SRI" es una acción dentro de Facturas), así que la categoría
// sigue el criterio temático, no una pestaña 1 a 1.
export const PERMISOS = [
  { clave: "caja", etiqueta: "Manejo de caja", descripcion: "Abrir/cerrar caja, registrar movimientos y ver el historial de arqueos", categoria: "Comprobantes" },
  { clave: "notas_credito", etiqueta: "Notas de crédito", descripcion: "Acceso a todas las notas de crédito", categoria: "Comprobantes" },
  { clave: "guias_remision", etiqueta: "Guías de remisión", descripcion: "Generar guías de remisión desde una factura autorizada, enviarlas al SRI y descargar el RIDE", categoria: "Comprobantes" },
  { clave: "facturas_anular", etiqueta: "Anular comprobantes", descripcion: "Anular facturas y notas de venta", categoria: "Comprobantes" },
  { clave: "ventas", etiqueta: "Punto de Venta", descripcion: "Acceso a Punto de Venta, Facturas, Notas de Venta y Proformas — vender y ver esos comprobantes", categoria: "Comprobantes" },
  { clave: "compras", etiqueta: "Compras", descripcion: "Ver y registrar compras a proveedores", categoria: "Compras" },
  { clave: "devoluciones_compra", etiqueta: "Devoluciones a proveedor", descripcion: "Registrar devoluciones parciales de mercadería a un proveedor", categoria: "Compras" },
  { clave: "productos", etiqueta: "Productos y categorías", descripcion: "Ver y administrar productos y categorías; subir imagen", categoria: "Catálogo" },
  { clave: "clientes", etiqueta: "Clientes", descripcion: "Ver y administrar la lista de clientes", categoria: "Catálogo" },
  { clave: "proveedores", etiqueta: "Proveedores", descripcion: "Ver y administrar la lista de proveedores", categoria: "Catálogo" },
  { clave: "inventario", etiqueta: "Ajustes de inventario", descripcion: "Registrar ajustes manuales de stock (entradas, salidas, conteos) — separado de traslados a propósito, es más sensible", categoria: "Catálogo" },
  { clave: "traslados", etiqueta: "Traslados entre bodegas", descripcion: "Mover stock entre bodegas o sucursales (no permite ajustar cantidades por su cuenta)", categoria: "Catálogo" },
  { clave: "contabilidad", etiqueta: "Contabilidad (ver)", descripcion: "Ver plan de cuentas, libro diario, libro mayor, balance de comprobación, balance general y estado de resultados", categoria: "Contabilidad" },
  { clave: "contabilidad_editar", etiqueta: "Contabilidad (editar)", descripcion: "Crear/editar cuentas del plan, crear asientos manuales y fijar el cierre contable", categoria: "Contabilidad" },
  { clave: "facturas_sri", etiqueta: "Envío al SRI", descripcion: "Enviar al SRI, descargar XML, consultar autorización", categoria: "Contabilidad" },
  { clave: "retenciones", etiqueta: "Retenciones", descripcion: "Generar comprobantes de retención, enviarlos al SRI y descargar el RIDE", categoria: "Contabilidad" },
  { clave: "nomina", etiqueta: "Nómina (ver)", descripcion: "Ver empleados, roles de pago, décimos, vacaciones, utilidades y liquidaciones", categoria: "Personal Técnico" },
  { clave: "nomina_editar", etiqueta: "Nómina (editar)", descripcion: "Crear/editar empleados, generar y pagar roles de pago, calcular décimos/vacaciones/utilidades/liquidaciones", categoria: "Personal Técnico" },
  { clave: "vehiculos", etiqueta: "Vehículos (ver)", descripcion: "Ver el catálogo de vehículos de la empresa, quién tiene cada uno en uso hoy y su historial de uso diario, cargas de combustible y mantenimientos", categoria: "Personal Técnico" },
  { clave: "vehiculos_editar", etiqueta: "Vehículos (editar)", descripcion: "Crear/editar vehículos y su catálogo de marca/modelo, configurar los planes de mantenimiento preventivo, corregir/eliminar cargas y mantenimientos ya registrados, y forzar el cierre de un uso diario si el técnico se olvidó — registrar una carga o un mantenimiento nuevo no exige este permiso, cualquier técnico puede hacerlo desde el celular", categoria: "Personal Técnico" },
  { clave: "visitas", etiqueta: "Visitas técnicas (ver)", descripcion: "Ver todas las rutas de visita planificadas", categoria: "Personal Técnico" },
  { clave: "visitas_editar", etiqueta: "Visitas técnicas (editar)", descripcion: "Planificar rutas de visita para el personal técnico", categoria: "Personal Técnico" },
  { clave: "reportes", etiqueta: "Reportes", descripcion: "Acceso a todos los reportes", categoria: "Reportes" },
  { clave: "auditoria", etiqueta: "Auditoría", descripcion: "Ver la bitácora de auditoría", categoria: "Administración" },
  { clave: "configuracion", etiqueta: "Configuración de la empresa", descripcion: "Logo, respaldo de comprobantes, datos de empresa, certificado", categoria: "Administración" },
  { clave: "mikrotik", etiqueta: "Control de red (Mikrotik)", descripcion: "Ver clientes conectados, suspender/reactivar acceso, gestionar cuentas PPPoE, planes de ancho de banda y el catálogo de planes de internet", categoria: "Red / ISP" },
  { clave: "olt", etiqueta: "Control de OLT", descripcion: "Ver el catálogo de OLT Huawei, sincronizar su tabla de ONUs por SNMP, consultar un puerto GPON puntual por SSH (señal, temperatura, distancia) y vincular ONUs con clientes", categoria: "Red / ISP" },
  { clave: "mapa_red", etiqueta: "Mapa de Red", descripcion: "Ver el mapa de clientes con su estado de conexión (ping, OLT, nodo) — pensado para la sala de soporte técnico", categoria: "Red / ISP" },
  { clave: "ubicacion_tecnicos", etiqueta: "Localización de Técnicos", descripcion: "Ver el mapa en vivo de dónde está cada técnico (según el GPS de su celular), qué vehículo tiene en uso y el recorrido del día", categoria: "Red / ISP" },
  { clave: "switches", etiqueta: "Switches TP-Link (clientes)", descripcion: "Ver el switch TP-Link instalado en el domicilio de cada cliente, sincronizar el estado de sus puertos por SNMP (up/down, tráfico, PoE)", categoria: "Red / ISP" },
  { clave: "red_fisica", etiqueta: "Red Física (ver)", descripcion: "Ver el mapa de trazado de fibra: cajas/NAP y los tramos de cable entre ellas", categoria: "Red / ISP" },
  { clave: "centro_control", etiqueta: "Centro de Control", descripcion: "Ver alertas de red (cortes masivos, señal degradada), visitas sospechosas, cuadre de material por técnico, equipos sin recuperar, anomalías de combustible, indicadores del negocio y encuestas de satisfacción", categoria: "Red / ISP" },
  { clave: "tickets", etiqueta: "Tickets de soporte", descripcion: "Atender los reclamos de clientes (llamadas, WhatsApp): crear, asignar, responder, agendar visita y resolver tickets", categoria: "Red / ISP" },
  { clave: "red_fisica_editar", etiqueta: "Red Física (editar)", descripcion: "Dibujar/editar cajas y tramos de fibra en el mapa de Red Física", categoria: "Red / ISP" },
] as const;

export type PermisoClave = (typeof PERMISOS)[number]["clave"];
export const CLAVES_VALIDAS: string[] = PERMISOS.map((p) => p.clave);
