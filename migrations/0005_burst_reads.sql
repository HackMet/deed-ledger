-- Burst reads: which inbound messages a reading (or a tap) has used. A row is written in the same
-- batch as the engine's commits for that reading, so a crash before the save leaves the messages
-- unread (the retry reads them again) and a saved reading can't use them twice (the primary key).
-- Also the readback a customer was last shown, so a typed "confirmar" applies to that version.
-- Conventions: see 0001_tenancy.sql.

CREATE TABLE burst_reads (
  business_id TEXT NOT NULL,
  inbound_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  -- The job whose completion saved the reading.
  read_by_job_id TEXT NOT NULL,
  read_at_ms INTEGER NOT NULL,
  PRIMARY KEY (business_id, inbound_message_id),
  FOREIGN KEY (business_id, inbound_message_id) REFERENCES inbound_messages (business_id, id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations (business_id, id),
  FOREIGN KEY (business_id, read_by_job_id) REFERENCES inbound_messages (business_id, id)
) STRICT;

CREATE INDEX burst_reads_by_conversation ON burst_reads (business_id, conversation_id);

-- Messages already handled before this migration count as read, so the first burst after it
-- doesn't pick up old messages.
INSERT INTO burst_reads (business_id, inbound_message_id, conversation_id, read_by_job_id, read_at_ms)
SELECT business_id, id, conversation_id, id, COALESCE(job_finished_at_ms, received_at_ms)
FROM inbound_messages WHERE job_state IN ('done', 'failed');

-- The readback (order and version) whose reply was last queued to this conversation. Untrusted as
-- a fact about the order: the engine still checks the version and that the order is the customer's.
ALTER TABLE conversations ADD COLUMN last_readback_order_id TEXT;
ALTER TABLE conversations ADD COLUMN last_readback_version INTEGER CHECK (last_readback_version IS NULL OR last_readback_version >= 1);
-- When that readback was queued, by our clock. A typed word answers it only if the word arrived
-- after it: a word sent before the customer could see a new version never confirms that version.
ALTER TABLE conversations ADD COLUMN last_readback_at_ms INTEGER;
