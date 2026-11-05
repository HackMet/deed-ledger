-- The public demo: each visitor who taps "Try the demo" gets a store of their own, made up from
-- scratch (src/application/demo-store.ts). A demo store's ID starts with "demo-" and its WhatsApp
-- number ID with "0", which Meta never issues, so the channel can refuse it without a lookup.
-- Demo stores expire; nothing in them is real.

CREATE TABLE demo_stores (
  business_id TEXT PRIMARY KEY REFERENCES businesses (id) CHECK (business_id GLOB 'demo-*'),
  -- The synthetic customer the visitor plays on the demo's phone. Digits only, starts with "0".
  customer_phone TEXT NOT NULL CHECK (customer_phone GLOB '0*' AND customer_phone NOT GLOB '*[^0-9]*'),
  -- A keyed hash of the visitor's IP, for the hourly limit on new stores. Never the IP itself.
  visitor_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX demo_stores_by_visitor ON demo_stores (visitor_hash, created_at_ms);
CREATE INDEX demo_stores_by_created ON demo_stores (created_at_ms);

-- Every demo store's model spend is pooled under this one row, so the demo has one daily cap
-- however many stores visitors open (model_spend.business_id references businesses).
INSERT INTO businesses (id, name, created_at_ms) VALUES ('demo-pool', 'Demo model budget', 0);
