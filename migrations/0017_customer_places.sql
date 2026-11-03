-- Delivery places (#29): a customer's saved places, and the coordinates of a shared WhatsApp
-- location on the message that carried it. Conventions: see 0001_tenancy.sql.
--
-- inbound_messages.kind keeps its CHECK rule (SQLite can't change one without rebuilding the
-- table): a location message stays kind 'other' and carries its pin in two nullable columns.
-- No floats: coordinates are kept as INTEGER millionths of a degree (*_e6, about 11 cm).

ALTER TABLE inbound_messages ADD COLUMN latitude_e6 INTEGER
  CHECK (latitude_e6 IS NULL OR latitude_e6 BETWEEN -90000000 AND 90000000);
ALTER TABLE inbound_messages ADD COLUMN longitude_e6 INTEGER
  CHECK ((longitude_e6 IS NULL) = (latitude_e6 IS NULL)
         AND (longitude_e6 IS NULL OR longitude_e6 BETWEEN -180000000 AND 180000000));

-- A place a customer's delivery went to. Saved when a delivery order that used it is confirmed, so
-- a place given for a pickup or a cancelled order is never kept. The newest used place is the one
-- offered back ("¿Te lo llevamos al mismo lugar de siempre?"), as a question, never applied.
-- order_id is the engine's order ID (orders are the engine's tables): one row per order, so the
-- same order confirmed again after a change updates its place instead of adding one.
CREATE TABLE customer_places (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  -- As the customer wrote it. Untrusted; never logged.
  place_text TEXT CHECK (place_text IS NULL OR length(place_text) BETWEEN 1 AND 300),
  latitude_e6 INTEGER CHECK (latitude_e6 IS NULL OR latitude_e6 BETWEEN -90000000 AND 90000000),
  longitude_e6 INTEGER CHECK (longitude_e6 IS NULL OR longitude_e6 BETWEEN -180000000 AND 180000000),
  order_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER NOT NULL,
  UNIQUE (business_id, id),
  UNIQUE (business_id, order_id),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id),
  CHECK ((latitude_e6 IS NULL) = (longitude_e6 IS NULL)),
  CHECK (place_text IS NOT NULL OR latitude_e6 IS NOT NULL)
) STRICT;

CREATE INDEX customer_places_latest ON customer_places (business_id, customer_id, last_used_at_ms);
