-- Orders: the order header, its immutable versions and lines, the operations table that anchors
-- idempotency, and the audit trail. Conventions: see 0001_tenancy.sql and 0004_ledger.sql.
-- A version is never updated: a change writes a new order_versions row. An unknown quantity or
-- price is NULL, never 0 (non-negotiable 2).

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  customer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('por_confirmar', 'confirmado', 'preparando', 'armando', 'listo', 'entregado', 'cancelado')),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  first_confirmed_at_ms INTEGER,
  ready_at_ms INTEGER,
  delivered_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (business_id, id)
) STRICT;

CREATE TABLE order_versions (
  business_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN ('por_confirmar', 'confirmado', 'preparando', 'armando', 'listo', 'entregado', 'cancelado')),
  total_centavos INTEGER CHECK (total_centavos IS NULL OR total_centavos >= 0),                  -- NULL = unknown, never 0
  fulfillment_mode TEXT CHECK (fulfillment_mode IS NULL OR fulfillment_mode IN ('pickup', 'delivery')),  -- NULL = not asked yet
  place_id TEXT,
  place_text TEXT,
  delivery_fee_centavos INTEGER CHECK (delivery_fee_centavos IS NULL OR delivery_fee_centavos >= 0),  -- NULL = unknown, never 0
  created_at_ms INTEGER NOT NULL,
  CHECK (COALESCE(fulfillment_mode, '') = 'delivery' OR (place_id IS NULL AND place_text IS NULL AND delivery_fee_centavos IS NULL)),
  UNIQUE (business_id, order_id, version)
) STRICT;

CREATE TABLE order_lines (
  business_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  product_id TEXT,                         -- NULL until code or staff matched the catalog
  customer_text TEXT NOT NULL,             -- the customer's own words, always kept
  qty_milli INTEGER CHECK (qty_milli IS NULL OR qty_milli > 0),  -- NULL = unknown, never 0
  unit_price_centavos INTEGER CHECK (unit_price_centavos IS NULL OR unit_price_centavos >= 0),  -- NULL = unknown, never 0
  excluded_from_total INTEGER NOT NULL CHECK (excluded_from_total IN (0, 1)),
  note TEXT,
  UNIQUE (business_id, order_id, version, line_no)
) STRICT;

-- The single idempotency anchor: one row per operation key, holding the first outcome so a
-- repeated key is answered without rebuilding it. facts.operation_key carries the same key.
CREATE TABLE operations (
  business_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (business_id, operation_key)
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  actor_id TEXT,
  at_ms INTEGER NOT NULL,
  detail_json TEXT NOT NULL
) STRICT;
