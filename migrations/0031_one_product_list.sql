-- One product list: every store product has one ID in both `products` (the ledger's catalog, 0020)
-- and `store_products` (its name, other names, "No hay", how it's sold and current price, 0019).
-- `CatalogService` writes both from now on; this adds what's missing from before. Conventions: see
-- 0001_tenancy.sql.
--
-- Additive and idempotent (D-54): no table is rebuilt or dropped, no row is changed or deleted, and
-- running it again inserts nothing. Safe on an empty database.
--
-- 1. A `store_products` row with no `products` row gets one: same ID, same store, its name as the
--    canonical name. No price fact is written: a price typed on the old Tienda screen stays in
--    `store_products.price_centavos`, which the pretend engine and retrieval read; the order engine
--    has no fact for it, so it reads as unknown until the owner confirms it on Productos.
--    An ID already used by another store's product is skipped, never overwritten.
INSERT INTO products (id, business_id, canonical_name, created_at_ms)
SELECT sp.id, sp.business_id, sp.name, sp.created_at_ms
FROM store_products sp
WHERE NOT EXISTS (SELECT 1 FROM products pr WHERE pr.id = sp.id);

-- 2. The other way (a `products` row with no `store_products` row: an invoice's product, the
--    synthetic product of scripts/admin-create-store.mjs) is not done here: `store_products.name_key`
--    is `productNameKey` (accents stripped after Unicode NFD), which SQL can't compute. Code covers
--    it instead: `D1StoreSetupRepository` reads such a product by its canonical name with its live
--    confirmed price fact, and `D1CatalogStore` creates its `store_products` row on its first edit.
