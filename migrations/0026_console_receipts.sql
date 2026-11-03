-- Console invoices (K14): the owner uploads a supplier invoice photo on the console, and its draft is
-- reviewed and approved there. Conventions: see 0001_tenancy.sql and 0020_ledger.sql. 0020 may be
-- applied remotely, so the widened columns are a rebuild here, never an edit there.

-- A draft comes from a WhatsApp message (source_inbound_id) or from a console member's upload
-- (source_member_id), never neither. A console upload has no media_assets row (that table is
-- WhatsApp's): its stored object's key and SHA-256 are kept on the draft, unchanged by every revision.
-- No foreign key references drafts, so create, copy, drop and rename is safe. Every row is kept.
CREATE TABLE drafts_new (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  conversation_id TEXT NOT NULL,           -- 'console' for a console upload
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'price')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'cancelled', 'expired')),
  payload_json TEXT NOT NULL,              -- validated claim, never raw model text
  source_inbound_id TEXT,
  source_media_asset_id TEXT,
  source_member_id TEXT,
  source_media_key TEXT,
  source_media_sha256 TEXT,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (source_inbound_id IS NOT NULL OR source_member_id IS NOT NULL),
  CHECK ((source_media_key IS NULL) = (source_media_sha256 IS NULL)),
  CHECK (source_media_key IS NULL OR substr(source_media_key, 1, length('stores/' || business_id || '/')) = 'stores/' || business_id || '/'),
  UNIQUE (business_id, id)
) STRICT;

INSERT INTO drafts_new (id, business_id, conversation_id, kind, revision, state, payload_json, source_inbound_id,
    source_media_asset_id, expires_at_ms, created_at_ms, updated_at_ms)
  SELECT id, business_id, conversation_id, kind, revision, state, payload_json, source_inbound_id, source_media_asset_id,
    expires_at_ms, created_at_ms, updated_at_ms
  FROM drafts ORDER BY rowid;

DROP TABLE drafts;
ALTER TABLE drafts_new RENAME TO drafts;

CREATE INDEX drafts_by_conversation ON drafts (business_id, conversation_id, kind, created_at_ms);
