-- Store setup (#40): each store's own products, prices, "No hay" marks, hours and delivery fee,
-- typed by the owner in the console. The pretend engine reads them per store until the real engine
-- has its own catalog. Conventions: see 0001_tenancy.sql.
--
-- TEMPORARY STAND-IN for the Monday pilot. The tech spec's catalog (products, product_names,
-- prices, availability_evidence), its store_settings and the spoken setup session live in the
-- teammate's engine and replace these tables once it's ready. Hence the names: store_products
-- and store_setup_settings, so nothing here takes a name the engine's tables use.
--
-- Absent means unknown: a product with no price has price_centavos NULL (the bot says "te lo
-- confirmo"), and an unmarked product is not "hay", only not marked "No hay".

CREATE TABLE store_products (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  -- What the store calls it, as the owner typed it.
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- The name with case, accents and spaces folded, so one store can't have "Azúcar" twice.
  name_key TEXT NOT NULL CHECK (length(name_key) >= 1),
  -- Other names customers use: a JSON array of strings.
  other_names_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(other_names_json) AND json_type(other_names_json) = 'array'),
  -- Integer centavos. NULL is "no price set"; never zero.
  price_centavos INTEGER CHECK (price_centavos IS NULL OR price_centavos > 0),
  -- 1 when the owner marked it "No hay".
  no_hay INTEGER NOT NULL DEFAULT 0 CHECK (no_hay IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (business_id, id),
  UNIQUE (business_id, name_key)
) STRICT;

-- One row per store, written the first time the owner saves hours or the fee.
CREATE TABLE store_setup_settings (
  business_id TEXT PRIMARY KEY REFERENCES businesses (id),
  -- StoreHours as JSON (src/domain/contract/outcomes.ts), validated before it's written and again
  -- when read. NULL is "hours not set".
  hours_json TEXT CHECK (hours_json IS NULL OR (json_valid(hours_json) AND json_type(hours_json) = 'array')),
  -- Integer centavos. NULL is "not set"; 0 is free delivery, set on purpose.
  delivery_fee_centavos INTEGER CHECK (delivery_fee_centavos IS NULL OR delivery_fee_centavos >= 0),
  updated_at_ms INTEGER NOT NULL
) STRICT;
