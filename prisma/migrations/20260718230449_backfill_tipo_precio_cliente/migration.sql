-- Semilla las 4 categorías de precio iniciales y migra cada Cliente
-- existente de tipoCliente (enum fijo, MINORISTA/MAYORISTA) a tipoPrecioId
-- (referencia a la nueva tabla configurable) — así ningún cliente real
-- queda sin categoría antes de forzar la columna a NOT NULL en el próximo
-- paso.

INSERT INTO "TipoPrecio" ("nombre", "porcentajeGanancia", "activo", "createdAt") VALUES
  ('Mayorista', 10.00, true, now()),
  ('Minorista A', 15.00, true, now()),
  ('Minorista B', 20.00, true, now()),
  ('Consumidor Final', 25.00, true, now());

UPDATE "Cliente"
SET "tipoPrecioId" = (SELECT id FROM "TipoPrecio" WHERE nombre = 'Mayorista')
WHERE "tipoCliente" = 'MAYORISTA';

UPDATE "Cliente"
SET "tipoPrecioId" = (SELECT id FROM "TipoPrecio" WHERE nombre = 'Minorista A')
WHERE "tipoCliente" = 'MINORISTA';
