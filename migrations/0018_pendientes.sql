-- Pendientes raised on the customer side (wireframe C5, contract gap c): a customer asked for a
-- person, a question was answered "te confirmo", a reply is late, a notice waits for the 24-hour
-- window, or the claim check stopped a reply. Conventions: see 0001_tenancy.sql.
--
-- IDs and codes only, never message text: who it's about comes from the conversation. The engine's
-- own items (prices to approve, payments to check) join the same screen once gap (c) is agreed.
CREATE TABLE conversation_pendientes (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('customer_handoff', 'customer_question', 'slow_reply', 'notice_waiting_window', 'claim_blocked')),
  -- NULL only for a claim blocked before a conversation was known.
  conversation_id TEXT,
  -- One item per event: a retried job raises the same key again and nothing is added.
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 300),
  -- A code, never words: the question's topic, the notice's type, or the check's stage.
  detail TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 80),
  -- How many things asked about got "te confirmo" (customer_question).
  item_count INTEGER CHECK (item_count IS NULL OR item_count >= 1),
  urgent INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  raised_at_ms INTEGER NOT NULL,
  -- "Listo" on the console: who, and when. Both or neither.
  done_at_ms INTEGER,
  done_by_user_id TEXT,
  UNIQUE (business_id, id),
  UNIQUE (business_id, dedupe_key),
  FOREIGN KEY (business_id) REFERENCES businesses (id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations (business_id, id),
  FOREIGN KEY (business_id, done_by_user_id) REFERENCES memberships (business_id, user_id),
  CHECK ((done_at_ms IS NULL) = (done_by_user_id IS NULL))
) STRICT;

CREATE INDEX conversation_pendientes_open ON conversation_pendientes (business_id, done_at_ms, raised_at_ms);
