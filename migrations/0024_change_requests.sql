-- Change requests: after confirming, a customer's change is a request the owner or staff approve or
-- decline with a reason (K12). Conventions: see 0001_tenancy.sql and 0020_ledger.sql. 0020–0023 may be
-- applied remotely, so the widened CHECK is a rebuild here, never an edit there.

-- facts.kind gains change_request, change_review and receipt_review (written by K14; here so facts is
-- rebuilt once). fact_evidence keeps its CHECK: a request rests on an inbound_message, a review on a member.
-- No foreign key references facts, so create, copy, drop and rename is safe. Every row is kept.
CREATE TABLE facts_new (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'cancellation', 'price', 'order_version', 'order_confirm', 'order_cancel',
    'order_status', 'business_info', 'change_request', 'change_review', 'receipt_review')),
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
INSERT INTO facts_new (id, business_id, kind, operation_key, draft_id, draft_revision, actor_user_id, valid_from_ms,
    recorded_at_ms, body_json)
  SELECT id, business_id, kind, operation_key, draft_id, draft_revision, actor_user_id, valid_from_ms, recorded_at_ms, body_json
  FROM facts ORDER BY rowid;
DROP TABLE facts;
ALTER TABLE facts_new RENAME TO facts;
