-- Messaging: conversations, inbound messages (each one is also its processing job), media,
-- the outbox, and messages from numbers that aren't members of the receiving store.
-- Conventions: see 0001_tenancy.sql.

-- One conversation per store number and member. The lease says which queue consumer is working
-- on it: lease_id is the fencing token, and every write a consumer makes checks it in the same
-- batch (see batch_guards). Lease times use the database's clock.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  channel_account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- Our receive time of the member's newest new message; drives WhatsApp's 24-hour window.
  -- Never a provider timestamp, and a redelivery doesn't move it.
  last_inbound_at_ms INTEGER,
  lease_id TEXT,
  lease_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (business_id, id),
  UNIQUE (business_id, channel_account_id, user_id),
  FOREIGN KEY (business_id, channel_account_id) REFERENCES channel_accounts (business_id, id),
  FOREIGN KEY (business_id, user_id) REFERENCES memberships (business_id, user_id),
  CHECK ((lease_id IS NULL) = (lease_until_ms IS NULL))
) STRICT;

-- Media sent by members. object_key is the asset's own prefix, inside the store's prefix. Stored
-- objects are immutable: the bytes live at stored_key = object_key || '/' || content_sha256, and
-- stored_key is published only by a fenced write.
CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp')),
  provider_media_id TEXT NOT NULL,
  mime_type TEXT,
  provider_sha256 TEXT,
  object_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'stored', 'failed')),
  content_sha256 TEXT,
  stored_key TEXT
    CHECK (stored_key IS NULL OR substr(stored_key, 1, length(object_key) + 1) = object_key || '/'),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  created_at_ms INTEGER NOT NULL,
  stored_at_ms INTEGER,
  UNIQUE (business_id, id),
  UNIQUE (business_id, provider, provider_media_id),
  CHECK (substr(object_key, 1, length('stores/' || business_id || '/'))
         = 'stores/' || business_id || '/'),
  -- A stored asset always has its published object.
  CHECK (state <> 'stored' OR (stored_key IS NOT NULL AND content_sha256 IS NOT NULL))
) STRICT;

-- A message from a member. The row is also its processing job: job_state, attempts and the
-- lease that last worked on it. These are processing states only; drafts get their own table
-- and states later.
CREATE TABLE inbound_messages (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp')),
  provider_message_id TEXT NOT NULL,
  -- As sent by the provider. Kept for audit; never used for time decisions.
  provider_timestamp_s INTEGER NOT NULL,
  -- Ordering time: the provider timestamp clamped to [received - 7 days, received + 5 minutes].
  order_ts_s INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'image', 'audio', 'interactive', 'other')),
  -- Untrusted content: text body, caption or tapped button title. Never logged.
  text_body TEXT,
  -- ID of the tapped reply button or list row, and the message it answers.
  reply_id TEXT,
  context_message_id TEXT,
  -- NULL for a photo or voice note that came without a usable media ID: its job ends with an
  -- honest reply.
  media_asset_id TEXT,
  job_state TEXT NOT NULL CHECK (job_state IN ('pending', 'processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  job_lease_id TEXT,
  job_started_at_ms INTEGER,
  job_finished_at_ms INTEGER,
  -- A deferred job isn't started again before this time; later jobs in its conversation wait.
  retry_after_ms INTEGER,
  -- An error code, never content.
  last_error TEXT,
  UNIQUE (business_id, provider, provider_message_id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations (business_id, id),
  FOREIGN KEY (business_id, media_asset_id) REFERENCES media_assets (business_id, id)
) STRICT;

CREATE INDEX inbound_open_jobs ON inbound_messages
  (business_id, conversation_id, job_state, order_ts_s, received_at_ms);
CREATE INDEX inbound_jobs_by_state ON inbound_messages (job_state, received_at_ms);
CREATE INDEX inbound_by_conversation_time ON inbound_messages (business_id, conversation_id, received_at_ms);

-- A message from a number that isn't a member of the receiving store. Only keyed hashes are
-- kept (HMAC with SENDER_HASH_SALT): no content, no media, no phone number. The message ID is
-- hashed too, because WhatsApp message IDs embed the sender's phone number.
CREATE TABLE unknown_inbound_messages (
  business_id TEXT NOT NULL REFERENCES businesses (id),
  message_hash TEXT NOT NULL,
  sender_hash TEXT NOT NULL,
  provider_timestamp_s INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (business_id, message_hash)
) STRICT;

CREATE INDEX unknown_inbound_by_sender ON unknown_inbound_messages (business_id, sender_hash, received_at_ms);
CREATE INDEX unknown_inbound_by_time ON unknown_inbound_messages (received_at_ms);

-- The outbox. Replies are written here first (in the same batch as the work that produced
-- them) and sent afterwards. A row goes either to a member's conversation or, for the fixed
-- unknown-sender notice, to a hashed recipient whose phone number is never stored.
--
-- Statuses: waiting_window (WhatsApp's 24-hour window was closed; sent when it reopens);
-- unknown_delivery (the outcome is unknown, so it is never sent again automatically: at most
-- once); expired (past expires_at_ms, never sent).
CREATE TABLE outbound_messages (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  channel_account_id TEXT NOT NULL,
  conversation_id TEXT,
  recipient_hash TEXT,
  -- Send order, increasing with every row written. A conversation's rows go out in this order,
  -- one at a time: a row waits until every earlier row of its conversation has settled.
  seq INTEGER NOT NULL UNIQUE,
  -- The job whose replies these are: one group. When a row of the group ends unsent (failed,
  -- expired or unknown_delivery), the rows after it are never sent (failed, predecessor_not_sent).
  job_id TEXT,
  -- Which of the job's replies this is, and which part of it after splitting.
  reply_index INTEGER NOT NULL DEFAULT 0 CHECK (reply_index >= 0),
  part_index INTEGER NOT NULL DEFAULT 0 CHECK (part_index >= 0),
  kind TEXT NOT NULL,
  body_text TEXT NOT NULL CHECK (length(body_text) BETWEEN 1 AND 4096),
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'sending', 'sent', 'waiting_window', 'failed', 'unknown_delivery', 'expired')),
  -- Send attempts, reserved when a dispatcher claims the row.
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- A dispatcher's claim. Its end uses the database's clock, like leases.
  claim_id TEXT,
  claim_until_ms INTEGER,
  -- Every row expires; whoever writes the row sets it.
  expires_at_ms INTEGER NOT NULL,
  provider_message_id TEXT UNIQUE,
  -- Delivery status from WhatsApp status webhooks. It only moves forward (by rank).
  provider_status TEXT
    CHECK (provider_status IS NULL OR provider_status IN ('sent', 'delivered', 'read', 'played', 'failed')),
  provider_status_rank INTEGER NOT NULL DEFAULT 0 CHECK (provider_status_rank BETWEEN 0 AND 5),
  provider_status_at_s INTEGER,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, channel_account_id) REFERENCES channel_accounts (business_id, id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations (business_id, id),
  FOREIGN KEY (business_id, job_id) REFERENCES inbound_messages (business_id, id),
  CHECK ((conversation_id IS NULL) <> (recipient_hash IS NULL)),
  CHECK (job_id IS NULL OR conversation_id IS NOT NULL),
  CHECK ((claim_id IS NULL) = (claim_until_ms IS NULL))
) STRICT;

CREATE INDEX outbound_by_status ON outbound_messages (status, seq);
CREATE INDEX outbound_by_conversation ON outbound_messages (business_id, conversation_id, seq);
CREATE INDEX outbound_by_job ON outbound_messages (business_id, job_id, seq);
CREATE INDEX outbound_unknown_notices ON outbound_messages (business_id, recipient_hash, kind, status);

-- Delivery statuses that arrive before the send result is stored, kept briefly and reconciled
-- when it is. Keyed by a keyed hash of the provider message ID, which embeds a phone number.
CREATE TABLE early_statuses (
  business_id TEXT NOT NULL REFERENCES businesses (id),
  message_hash TEXT NOT NULL,
  provider_status TEXT NOT NULL CHECK (provider_status IN ('sent', 'delivered', 'read', 'played', 'failed')),
  provider_status_rank INTEGER NOT NULL CHECK (provider_status_rank BETWEEN 1 AND 5),
  provider_status_at_s INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (business_id, message_hash)
) STRICT;

CREATE INDEX early_statuses_by_time ON early_statuses (received_at_ms);

-- Batch guards make a D1 batch fail loudly when a precondition doesn't hold. A batch inserts a
-- guard row whose `ok` is a subquery that is NULL unless the precondition holds (for example,
-- "this consumer still holds the conversation lease"); NOT NULL then aborts the whole batch.
-- The batch deletes its guard row as its last statement, so the table stays empty.
CREATE TABLE batch_guards (
  guard_id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;
