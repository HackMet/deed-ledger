-- Deed checks: every refusal, duplicate and claim verdict the order engine decides, one row each, for
-- the Deed screens (K20). IDs and codes only, never message text, names or phone numbers. Append-only:
-- the engine writes a row after its decision, best effort; nothing ever changes or removes one.
-- Conventions: see 0001_tenancy.sql and 0020_ledger.sql.

CREATE TABLE deed_checks (
  business_id TEXT NOT NULL REFERENCES businesses (id),
  id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,                  -- system time the decision was made
  source TEXT NOT NULL CHECK (source IN ('verify_claims', 'duplicate_key', 'stale_version', 'gate', 'not_allowed', 'not_found')),
  subject_fact_id TEXT,                    -- the fact the check was about, when the engine had it at hand
  order_id TEXT,                           -- the order the check was about; NULL when none resolved in this store
  claim_kind TEXT,                         -- verify_claims only: the claim's type, from the contract's list
  result TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
  reason_code TEXT,                        -- a code: the engine's reason, 'duplicate', or 'not_backed'; NULL on a pass
  deciding_fact_id TEXT,                   -- the fact that decided a refusal, when the engine had it at hand
  operation_key TEXT,                      -- the key the attempt carried (IDs and the action's name)
  PRIMARY KEY (business_id, id)
) STRICT;

CREATE INDEX deed_checks_by_time ON deed_checks (business_id, at_ms, id);
CREATE INDEX deed_checks_by_order ON deed_checks (business_id, order_id, at_ms);

CREATE TRIGGER deed_checks_are_never_updated BEFORE UPDATE ON deed_checks
BEGIN
  SELECT RAISE(ABORT, 'deed checks are append-only');
END;

CREATE TRIGGER deed_checks_are_never_deleted BEFORE DELETE ON deed_checks
BEGIN
  SELECT RAISE(ABORT, 'deed checks are append-only');
END;
