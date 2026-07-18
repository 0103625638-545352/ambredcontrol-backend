-- Siembra el plan de cuentas inicial (simplificado, comercial/retail chico)
-- que usan los generadores automáticos de asientos (ver
-- backend/src/utils/contabilidad.ts) — sin esto, la primera venta/compra/pago
-- no tendría a qué cuenta apuntar. Todas quedan como cuentas "hoja"
-- (permiteMovimiento = true por default), sin jerarquía de agrupación
-- todavía — el campo cuentaPadreId queda listo para cuando haga falta.

INSERT INTO "CuentaContable" ("codigo", "nombre", "tipo", "naturaleza") VALUES
  ('1.1.01', 'Caja', 'ACTIVO', 'DEUDORA'),
  ('1.1.02', 'Bancos', 'ACTIVO', 'DEUDORA'),
  ('1.1.03', 'Cuentas por Cobrar Clientes', 'ACTIVO', 'DEUDORA'),
  ('1.1.04', 'Crédito Tributario IVA en Compras', 'ACTIVO', 'DEUDORA'),
  ('1.1.05', 'Retenciones IVA por Cobrar', 'ACTIVO', 'DEUDORA'),
  ('1.1.06', 'Inventario de Mercadería', 'ACTIVO', 'DEUDORA'),
  ('1.1.07', 'Retenciones Renta por Cobrar', 'ACTIVO', 'DEUDORA'),
  ('2.1.01', 'Cuentas por Pagar Proveedores', 'PASIVO', 'ACREEDORA'),
  ('2.1.02', 'IVA en Ventas por Pagar', 'PASIVO', 'ACREEDORA'),
  ('2.1.03', 'Retenciones IVA por Pagar al SRI', 'PASIVO', 'ACREEDORA'),
  ('2.1.04', 'Retenciones Renta por Pagar al SRI', 'PASIVO', 'ACREEDORA'),
  ('3.1.01', 'Capital Social', 'PATRIMONIO', 'ACREEDORA'),
  ('3.1.02', 'Utilidad/Pérdida del Ejercicio', 'PATRIMONIO', 'ACREEDORA'),
  ('4.1.01', 'Ventas', 'INGRESO', 'ACREEDORA'),
  ('4.1.02', 'Devoluciones en Ventas', 'INGRESO', 'ACREEDORA'),
  ('4.1.03', 'Otros Ingresos', 'INGRESO', 'ACREEDORA'),
  ('5.1.01', 'Costo de Ventas', 'COSTO', 'DEUDORA'),
  ('6.1.01', 'Gastos Operativos', 'GASTO', 'DEUDORA');
