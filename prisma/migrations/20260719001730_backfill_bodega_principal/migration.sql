-- Paso 2 de 3 (puro DML) del rollout de Bodega. Siembra una "Bodega
-- Principal" por cada sucursal ya existente y le atribuye todo lo que ya
-- existía (StockSucursal, documentos, movimientos, traslados) — antes de
-- este rollout cada sucursal tenía, de hecho, un solo espacio de
-- almacenamiento, así que esto es un hecho verdadero, no una suposición
-- (a diferencia de Usuario.sucursalId en el rollout de Sucursal, que se
-- dejó NULL a propósito porque ahí sí había ambigüedad real).

INSERT INTO "Bodega" ("nombre", "sucursalId", "activa", "createdAt")
SELECT 'Bodega Principal', id, true, now() FROM "Sucursal";

-- Reparte StockSucursal.cantidad en StockBodega — join 1:1 porque en este
-- instante cada sucursal tiene exactamente una bodega recién creada.
INSERT INTO "StockBodega" ("productoId", "bodegaId", "cantidad")
SELECT ss."productoId", b.id, ss.cantidad
FROM "StockSucursal" ss
JOIN "Bodega" b ON b."sucursalId" = ss."sucursalId";

UPDATE "Factura" f SET "bodegaId" = b.id
FROM "Bodega" b WHERE b."sucursalId" = f."sucursalId" AND f."bodegaId" IS NULL;

UPDATE "NotaVenta" nv SET "bodegaId" = b.id
FROM "Bodega" b WHERE b."sucursalId" = nv."sucursalId" AND nv."bodegaId" IS NULL;

UPDATE "Compra" c SET "bodegaId" = b.id
FROM "Bodega" b WHERE b."sucursalId" = c."sucursalId" AND c."bodegaId" IS NULL;

-- Movimientos con sucursalId NULL (productos con lote) quedan con bodegaId
-- NULL también — correcto, no aplica.
UPDATE "MovimientoInventario" m SET "bodegaId" = b.id
FROM "Bodega" b
WHERE b."sucursalId" = m."sucursalId" AND m."sucursalId" IS NOT NULL AND m."bodegaId" IS NULL;

UPDATE "Traslado" t SET "bodegaOrigenId" = bo.id, "bodegaDestinoId" = bd.id
FROM "Bodega" bo, "Bodega" bd
WHERE bo."sucursalId" = t."sucursalOrigenId"
  AND bd."sucursalId" = t."sucursalDestinoId"
  AND t."bodegaOrigenId" IS NULL;
