-- Siembra la sucursal que ya existía implícitamente antes de que el sistema
-- manejara varios locales, y le atribuye todo lo que ya existía (stock,
-- documentos, movimientos) — así ningún dato real se pierde ni queda huérfano.

INSERT INTO "Sucursal" ("nombre", "activa", "createdAt")
VALUES ('Sucursal Principal', true, now());

-- Reparte Producto.stockActual en StockSucursal para productos SIN lote — de
-- ahí en adelante StockSucursal es el desglose por ubicación de ese mismo
-- total (ver el comentario en Producto.stockActual del schema).
INSERT INTO "StockSucursal" ("productoId", "sucursalId", "cantidad")
SELECT p.id, s.id, p."stockActual"
FROM "Producto" p, "Sucursal" s
WHERE p."manejaLotes" = false;

-- Los movimientos de productos SIN lote quedan atribuidos a esa sucursal; los
-- de productos con lote quedan con sucursalId NULL (su stock sigue siendo
-- global, sin cambios).
UPDATE "MovimientoInventario" m
SET "sucursalId" = s.id
FROM "Producto" p, "Sucursal" s
WHERE m."productoId" = p.id AND p."manejaLotes" = false;

UPDATE "Factura" SET "sucursalId" = (SELECT id FROM "Sucursal" LIMIT 1) WHERE "sucursalId" IS NULL;
UPDATE "NotaVenta" SET "sucursalId" = (SELECT id FROM "Sucursal" LIMIT 1) WHERE "sucursalId" IS NULL;
UPDATE "Compra" SET "sucursalId" = (SELECT id FROM "Sucursal" LIMIT 1) WHERE "sucursalId" IS NULL;

-- Los usuarios existentes quedan SIN sucursal asignada a propósito — hay que
-- asignarlos a mano (vía la nueva pantalla, o un UPDATE puntual) antes de que
-- puedan vender/comprar/hacer traslados, ver Usuario.sucursalId en el schema.
