-- Customers: anyone who writes to a store's WhatsApp number is that store's customer. Memberships
-- only matter for the console now. Conversations move from memberships to customers.
-- Conventions: see 0001_tenancy.sql.
--
-- SQLite can't change a foreign key, so conversations is rebuilt: its rows are copied aside, the
-- table is dropped and created again under the same name, and the rows go back with their IDs
-- (inbound and outbound messages point at them). Each member who had a conversation becomes a
-- customer of that store. Foreign keys are checked when the migration's transaction ends. The rows
-- must go back into a table named conversations (not a renamed one): only inserting the parent
-- rows clears the violations the drop counted against the messages that point at them.

PRAGMA defer_foreign_keys = on;

-- A store's customer. phone is the WhatsApp number (digits only), NULL for a customer known only by
-- name (fiado on paper). The same number in two stores is two customers that never meet.
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  phone TEXT CHECK (phone IS NULL OR (length(phone) BETWEEN 6 AND 15 AND phone NOT GLOB '*[^0-9]*')),
  -- As the customer gave it. Saved once: a later answer doesn't overwrite it.
  name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 120),
  name_saved_at_ms INTEGER,
  -- When the assistant asked for the name, so it is asked once.
  name_asked_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (business_id, id),
  UNIQUE (business_id, phone),
  CHECK ((name IS NULL) = (name_saved_at_ms IS NULL))
) STRICT;

-- Members who had a conversation become customers, under a fresh ID each.
INSERT INTO customers (id, business_id, phone, created_at_ms)
SELECT lower(hex(randomblob(16))), x.business_id, x.phone, x.created_at_ms
FROM (SELECT c.business_id, u.phone, MIN(c.created_at_ms) AS created_at_ms
      FROM conversations c JOIN users u ON u.id = c.user_id
      GROUP BY c.business_id, u.phone) x;

CREATE TABLE conversations_copy (
  id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  channel_account_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  last_inbound_at_ms INTEGER,
  lease_id TEXT,
  lease_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL
) STRICT;

INSERT INTO conversations_copy
SELECT c.id, c.business_id, c.channel_account_id, cu.id, c.last_inbound_at_ms, c.lease_id, c.lease_until_ms,
       c.created_at_ms
FROM conversations c
JOIN users u ON u.id = c.user_id
JOIN customers cu ON cu.business_id = c.business_id AND cu.phone = u.phone;

DROP TABLE conversations;

-- One conversation per store number and customer. Everything else as in 0002_messaging.sql.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  channel_account_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  -- Our receive time of the customer's newest new message; drives WhatsApp's 24-hour window.
  -- Never a provider timestamp, and a redelivery doesn't move it.
  last_inbound_at_ms INTEGER,
  lease_id TEXT,
  lease_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (business_id, id),
  UNIQUE (business_id, channel_account_id, customer_id),
  FOREIGN KEY (business_id, channel_account_id) REFERENCES channel_accounts (business_id, id),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id),
  CHECK ((lease_id IS NULL) = (lease_until_ms IS NULL))
) STRICT;

INSERT INTO conversations
  (id, business_id, channel_account_id, customer_id, last_inbound_at_ms, lease_id, lease_until_ms, created_at_ms)
SELECT id, business_id, channel_account_id, customer_id, last_inbound_at_ms, lease_id, lease_until_ms, created_at_ms
FROM conversations_copy;

DROP TABLE conversations_copy;
