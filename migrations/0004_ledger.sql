-- Ledger: drafts and their confirmations, the append-only fact log with its evidence, dependencies
-- and closures, and the stock movements and balances that facts post. Products are minimal until
-- the catalog exists (see spec §3).
-- Conventions: see 0001_tenancy.sql. Every precondition is a UNIQUE or CHECK, so a violation
-- fails the statement instead of matching zero rows.

-- Minimal product catalog: enough for stock movements to name a product.
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  canonical_name TEXT NOT NULL CHECK (length(canonical_name) BETWEEN 1 AND 120),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (business_id, id)
) STRICT;

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'price')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'cancelled', 'expired')),
  payload_json TEXT NOT NULL,              -- validated claim, never raw model text
  source_inbound_id TEXT NOT NULL,
  source_media_asset_id TEXT,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (business_id, id)
) STRICT;

-- One approval per draft, ever. A second tap is caught before the batch and answered from the stored fact.
CREATE TABLE draft_confirmations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL,
  inbound_id TEXT NOT NULL,                -- the WhatsApp message that confirmed
  created_at_ms INTEGER NOT NULL,
  UNIQUE (business_id, draft_id)
) STRICT;

-- Append-only: never updated, never deleted. One logical operation = one operation_key.
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'cancellation', 'price')),
  operation_key TEXT NOT NULL,             -- one logical operation = one key (FR-08)
  draft_id TEXT,
  draft_revision INTEGER,
  actor_user_id TEXT NOT NULL,
  valid_from_ms INTEGER NOT NULL,          -- business time
  recorded_at_ms INTEGER NOT NULL,         -- system time
  body_json TEXT NOT NULL,
  UNIQUE (business_id, operation_key),
  UNIQUE (business_id, id)
) STRICT;

CREATE TABLE fact_evidence (
  business_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('inbound_message', 'media_asset', 'confirmation', 'stock_movement', 'fact')),
  ref_id TEXT NOT NULL,
  content_sha256 TEXT,                     -- media: the stored object's hash
  PRIMARY KEY (business_id, fact_id, kind, ref_id)
) STRICT;

-- "Fact B was decided using fact A" (B → A). Liveness is derived from these edges, never cascaded.
CREATE TABLE fact_dependencies (
  business_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  depends_on_fact_id TEXT NOT NULL,
  PRIMARY KEY (business_id, fact_id, depends_on_fact_id),
  CHECK (fact_id <> depends_on_fact_id)
) STRICT;

-- PRIMARY KEY on fact_id: a fact closes once. A double cancel fails loudly.
CREATE TABLE fact_closures (
  business_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  closed_by_fact_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('cancelled', 'superseded')),
  closed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (business_id, fact_id)
) STRICT;

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli <> 0),   -- compensations are negative
  unit_cost_centavos INTEGER,              -- NULL = unknown, never 0 (non-negotiable 2)
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE stock_balances (
  business_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli >= 0),   -- verified stock never goes negative
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (business_id, product_id)
) STRICT;
