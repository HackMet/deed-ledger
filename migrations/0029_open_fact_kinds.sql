-- Open fact kinds: facts.kind and fact_evidence.kind lose their CHECK lists. The store's policy
-- (src/domain/store-policy.ts) now decides which kinds exist: the batch's post-guard refuses a kind
-- it doesn't name, so nothing is written. Conventions: see 0001_tenancy.sql and 0020_ledger.sql. 0020–0028
-- may be applied remotely, so the rebuild is here, never an edit there.

-- facts has no triggers and no indexes beyond its UNIQUE keys, which the new definition keeps. No foreign
-- key references facts or fact_evidence, so create, copy, drop and rename is safe. Every row and column is kept,
-- including agent_id (0028, added after the last rebuild, so 0024 never copied it).
CREATE TABLE facts_new (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  kind TEXT NOT NULL,
  operation_key TEXT NOT NULL,             -- one logical operation = one key (FR-08)
  draft_id TEXT,
  draft_revision INTEGER,
  actor_user_id TEXT NOT NULL,
  valid_from_ms INTEGER NOT NULL,          -- business time
  recorded_at_ms INTEGER NOT NULL,         -- system time
  body_json TEXT NOT NULL,
  agent_id TEXT CHECK (agent_id IS NULL OR (length(agent_id) = 8 AND agent_id NOT GLOB '*[^0-9a-f]*')),
  UNIQUE (business_id, operation_key),
  UNIQUE (business_id, id)
) STRICT;
INSERT INTO facts_new (id, business_id, kind, operation_key, draft_id, draft_revision, actor_user_id, valid_from_ms,
    recorded_at_ms, body_json, agent_id)
  SELECT id, business_id, kind, operation_key, draft_id, draft_revision, actor_user_id, valid_from_ms, recorded_at_ms,
    body_json, agent_id
  FROM facts ORDER BY rowid;
DROP TABLE facts;
ALTER TABLE facts_new RENAME TO facts;

CREATE TABLE fact_evidence_new (
  business_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  content_sha256 TEXT,                     -- media: the stored object's hash
  PRIMARY KEY (business_id, fact_id, kind, ref_id)
) STRICT;
INSERT INTO fact_evidence_new (business_id, fact_id, kind, ref_id, content_sha256)
  SELECT business_id, fact_id, kind, ref_id, content_sha256 FROM fact_evidence;
DROP TABLE fact_evidence;
ALTER TABLE fact_evidence_new RENAME TO fact_evidence;
