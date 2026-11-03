-- Order facts: every order transition is also a fact in the ledger (R2), and `orders` becomes the
-- read cache that keeps the fact ids it needs to draw the next edges. Conventions: see
-- 0001_tenancy.sql and 0020_ledger.sql. 0020–0022 are merged and may be applied remotely, so the
-- widened CHECKs are a rebuild here, never an edit there.

-- The current version's fact and the live confirm's fact. NULL: none yet (or written before this).
ALTER TABLE orders ADD COLUMN version_fact_id TEXT;
ALTER TABLE orders ADD COLUMN confirm_fact_id TEXT;

-- facts.kind gains the order kinds and business_info (written by K6; here so facts is rebuilt once).
-- No foreign key references facts or fact_evidence, so create, copy, drop and rename is safe.
-- actor_user_id has no foreign key: it holds a customer id or a member id.
CREATE TABLE facts_new (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'cancellation', 'price', 'order_version', 'order_confirm', 'order_cancel',
    'order_status', 'business_info')),
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
  FROM facts;
DROP TABLE facts;
ALTER TABLE facts_new RENAME TO facts;

-- fact_evidence.kind gains 'member' (who tapped on the console) and 'session' (the console session;
-- not written yet: MemberContext carries no session id).
CREATE TABLE fact_evidence_new (
  business_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('inbound_message', 'media_asset', 'confirmation', 'stock_movement', 'fact', 'member',
    'session')),
  ref_id TEXT NOT NULL,
  content_sha256 TEXT,                     -- media: the stored object's hash
  PRIMARY KEY (business_id, fact_id, kind, ref_id)
) STRICT;
INSERT INTO fact_evidence_new (business_id, fact_id, kind, ref_id, content_sha256)
  SELECT business_id, fact_id, kind, ref_id, content_sha256 FROM fact_evidence;
DROP TABLE fact_evidence;
ALTER TABLE fact_evidence_new RENAME TO fact_evidence;
