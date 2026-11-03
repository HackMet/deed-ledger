-- Customer controls (#30): the first message, ALTO and SEGUIR, and deletion on request.
--
-- introduced_at_ms: the first reply (who we are, the privacy notice, ALTO, how to reach the owner)
--   was written to the outbox. NULL for customers who existed before this migration, so they get it
--   once on their next message.
-- stopped_at_ms: the customer typed ALTO (or asked for deletion). Dispatch sends them nothing but
--   the direct answers to their control words; SEGUIR clears it.
-- stop_reminded_at_ms: while stopped, a message gets one reminder that SEGUIR resumes, once per stop.
-- deletion_requested_at_ms / deleted_at_ms: an explicit deletion request, and when the purge finished.
--   After the purge the row stays, with no phone or name, so sale and fiado amounts that point at
--   it keep their history without the person.
ALTER TABLE customers ADD COLUMN introduced_at_ms INTEGER;
ALTER TABLE customers ADD COLUMN stopped_at_ms INTEGER;
ALTER TABLE customers ADD COLUMN stop_reminded_at_ms INTEGER;
ALTER TABLE customers ADD COLUMN deletion_requested_at_ms INTEGER;
ALTER TABLE customers ADD COLUMN deleted_at_ms INTEGER;

CREATE INDEX customers_deletion_due ON customers (deletion_requested_at_ms)
  WHERE deletion_requested_at_ms IS NOT NULL AND deleted_at_ms IS NULL;

-- A deleted customer's sender, per store, as the keyed hash (HMAC with SENDER_HASH_SALT) of the
-- phone: never the phone itself. A webhook for a message sent at or before deleted_at_ms (a late
-- delivery or a retry) is dropped instead of creating the customer again.
CREATE TABLE customer_tombstones (
  business_id TEXT NOT NULL REFERENCES businesses (id),
  sender_hash TEXT NOT NULL CHECK (length(sender_hash) = 64 AND sender_hash NOT GLOB '*[^0-9a-f]*'),
  deleted_at_ms INTEGER NOT NULL,
  PRIMARY KEY (business_id, sender_hash)
) STRICT;
