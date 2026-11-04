-- The agent that made a customer's claim (C11): the 8 hex characters of the agent configuration's hash,
-- stamped by the runtime on each customer fact (order_version, order_confirm, order_cancel, change_request).
-- NULL on every fact no agent claimed: staff taps, owner answers and status changes. Never supplied by a
-- model. Append-only like the rest of facts: nothing updates a row, so the column is written once.
-- Conventions: see 0001_tenancy.sql and 0020_ledger.sql.

ALTER TABLE facts ADD COLUMN agent_id TEXT CHECK (agent_id IS NULL OR (length(agent_id) = 8 AND agent_id NOT GLOB '*[^0-9a-f]*'));
