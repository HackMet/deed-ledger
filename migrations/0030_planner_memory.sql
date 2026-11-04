-- The planner's conversation memory on the Deed engine (PlannedDeedEngine): per customer, what the
-- conversation keeps between messages that isn't a ledger fact. The question last shown and its
-- numbered options, the customer's words per line, the lines the planner picked, the order still
-- being put together before its readback. Orders, versions, confirmations and cancels stay in the
-- order engine's own tables; this is read beside them and never instead of them.
-- Written only through a version compare-and-swap in the caller's batch. Additive: no existing table
-- changes. Conventions: see 0001_tenancy.sql.

CREATE TABLE planner_memory (
  business_id TEXT NOT NULL REFERENCES businesses (id),
  customer_id TEXT NOT NULL,
  -- The order the conversation is about: a ledger order's id, or a draft's not saved there yet.
  order_id TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (business_id, customer_id)
) STRICT;

CREATE INDEX planner_memory_order ON planner_memory (business_id, order_id);
