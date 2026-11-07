-- Three limits for the public demo (src/domain/demo.ts):
-- * The demo's total counts only stores still open (expires_at_ms in the future), so expired demo
--   stores never fill the demo for good. This index keeps that count cheap.
-- * Each demo store's console readings (Anotar, Pedido a mano) call the model; they are counted per
--   store so one visitor can't spend the demo's shared daily budget from the console.
-- * The demo phone's sends are counted here too, taken in one guarded write before a send goes in,
--   so parallel sends can't pass the store's lifetime message limit together.
CREATE INDEX demo_stores_by_expiry ON demo_stores (expires_at_ms);

ALTER TABLE demo_stores ADD COLUMN console_reads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE demo_stores ADD COLUMN phone_sends INTEGER NOT NULL DEFAULT 0;

-- Stores already open start from what their phone already sent (the count messageCount makes).
UPDATE demo_stores SET phone_sends = (
  SELECT count(*) FROM inbound_messages i
  JOIN conversations c ON c.id = i.conversation_id AND c.business_id = i.business_id
  JOIN customers cu ON cu.id = c.customer_id AND cu.business_id = c.business_id
  WHERE i.business_id = demo_stores.business_id AND cu.phone = demo_stores.customer_phone
);
