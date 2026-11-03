-- Learned aliases and how each product is sold (D-49, planner contract §2.4 and §6 item 6).
-- Conventions: see 0001_tenancy.sql.
--
-- Numbered 0011 (our gap) but it extends store_products, which 0019 creates. A fresh database runs
-- 0011 first, so nothing here alters store_products: both tables are new and point at it. SQLite
-- resolves a foreign key when a row is written, not when the table is created, so the order of
-- creation doesn't matter. A database that already has 0019 simply runs this one later.
--
-- TEMPORARY like store_products: the teammate's catalog replaces both once it's ready.

-- How the owner says a product is sold, and the amount most customers take. One row per product,
-- written when the owner sets either on the Tienda screen. No row is "not said": both unknown.
CREATE TABLE store_product_selling (
  business_id TEXT NOT NULL REFERENCES businesses (id),
  product_id TEXT NOT NULL,
  -- 'unit' (one at a time) or 'weight' (by the pound). NULL: the owner hasn't said.
  sold_by TEXT CHECK (sold_by IS NULL OR sold_by IN ('unit', 'weight')),
  -- The usual amount in integer thousandths (1 is 1000; half a pound is 500). NULL: none set.
  usual_quantity_milli INTEGER CHECK (usual_quantity_milli IS NULL OR usual_quantity_milli > 0),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (business_id, product_id),
  FOREIGN KEY (business_id, product_id) REFERENCES store_products (business_id, id) ON DELETE CASCADE
) STRICT;

-- Words a store's customers use for one of its products ("catsup" for "Salsa de tomate Naturas
-- 400 g"). Proposed when a customer confirms an order the planner matched; only an approved one
-- matches, as exactly as the product's own name. A rejected one stays, so the same words for the
-- same product aren't proposed again.
CREATE TABLE store_aliases (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  -- The words as retrieval compares them (src/domain/retrieval.ts aliasWords): lowercase, no
  -- accents, no filler words, unit words folded. One alias per words per store.
  words TEXT NOT NULL CHECK (length(words) BETWEEN 1 AND 80),
  -- The same words as the customer wrote them, for the owner's Pendientes card.
  said TEXT NOT NULL CHECK (length(said) BETWEEN 1 AND 80),
  product_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed', 'approved', 'rejected')),
  -- 'order': proposed from a confirmed order (source_order_id). 'staff': taught by a person, who
  -- is also the one who decided.
  source TEXT NOT NULL CHECK (source IN ('order', 'staff')),
  source_order_id TEXT CHECK (source_order_id IS NULL OR length(source_order_id) BETWEEN 1 AND 100),
  proposed_at_ms INTEGER NOT NULL,
  -- Who approved or rejected it, and when. Both or neither; neither only while proposed.
  decided_at_ms INTEGER,
  decided_by_user_id TEXT,
  UNIQUE (business_id, id),
  UNIQUE (business_id, words),
  -- A product the store removes takes its aliases with it.
  FOREIGN KEY (business_id, product_id) REFERENCES store_products (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, decided_by_user_id) REFERENCES memberships (business_id, user_id),
  CHECK ((source = 'order') = (source_order_id IS NOT NULL)),
  CHECK ((decided_at_ms IS NULL) = (decided_by_user_id IS NULL)),
  CHECK ((state = 'proposed') = (decided_at_ms IS NULL))
) STRICT;

CREATE INDEX store_aliases_by_state ON store_aliases (business_id, state, proposed_at_ms);
