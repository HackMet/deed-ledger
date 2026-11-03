-- Dispatch (K13): a ready delivery order goes out with a courier of the store, `en_camino`, before it
-- is delivered. Each step is an order_status fact (no new fact kind); this migration exists only
-- because orders.state's CHECK has no `en_camino`, and 0021 may be applied remotely, so the widened
-- CHECK is a rebuild here, never an edit there. Conventions: see 0001_tenancy.sql.
-- order_versions keeps its CHECK: a version is written in por_confirmar (or the state an approved
-- change kept), never en_camino. No foreign key or trigger references orders, so create, copy,
-- drop and rename is safe. Every row is kept, in order.
CREATE TABLE orders_new (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  customer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('por_confirmar', 'confirmado', 'preparando', 'armando', 'listo', 'en_camino', 'entregado',
    'cancelado')),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  first_confirmed_at_ms INTEGER,
  ready_at_ms INTEGER,
  delivered_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  version_fact_id TEXT,
  confirm_fact_id TEXT,
  UNIQUE (business_id, id)
) STRICT;
INSERT INTO orders_new (id, business_id, customer_id, state, current_version, first_confirmed_at_ms, ready_at_ms, delivered_at_ms,
    created_at_ms, version_fact_id, confirm_fact_id)
  SELECT id, business_id, customer_id, state, current_version, first_confirmed_at_ms, ready_at_ms, delivered_at_ms, created_at_ms,
    version_fact_id, confirm_fact_id
  FROM orders ORDER BY rowid;
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;
