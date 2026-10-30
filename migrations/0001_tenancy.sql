-- Tenancy: stores (businesses), their locations, people (users), who belongs to which store
-- (memberships, where roles live) and which WhatsApp number belongs to which store
-- (channel_accounts). Identity, membership and channel are separate tables.
--
-- Conventions for every migration:
-- - Tables are STRICT, so a REAL can't slip into an INTEGER column. No floats anywhere.
-- - Times are INTEGER Unix epoch milliseconds (UTC), named *_at_ms. Provider times keep the
--   provider's unit and say so (*_s).
-- - Every business-owned table carries business_id and exposes UNIQUE (business_id, id), so
--   child tables reference (business_id, id) and can't point at another store's rows.

CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (business_id, id)
) STRICT;

-- A person, identified by their WhatsApp phone number (digits only, E.164 without "+").
-- Not business-owned: one person can belong to several stores.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE
    CHECK (length(phone) BETWEEN 6 AND 15 AND phone NOT GLOB '*[^0-9]*'),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 120),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE memberships (
  business_id TEXT NOT NULL REFERENCES businesses (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  location_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (business_id, user_id),
  FOREIGN KEY (business_id, location_id) REFERENCES locations (business_id, id)
) STRICT;

-- Memberships are deactivated (active = 0), never deleted: conversations reference them.
CREATE TRIGGER memberships_are_never_deleted BEFORE DELETE ON memberships
BEGIN
  SELECT RAISE(ABORT, 'memberships are deactivated, never deleted');
END;

-- Maps a WhatsApp business phone number (Meta's phone_number_id) to exactly one store.
-- Incoming webhooks resolve the store from metadata.phone_number_id here, by exact match only.
CREATE TABLE channel_accounts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (id),
  location_id TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp')),
  phone_number_id TEXT NOT NULL
    CHECK (length(phone_number_id) BETWEEN 1 AND 32 AND phone_number_id NOT GLOB '*[^0-9]*'),
  display_phone_number TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (provider, phone_number_id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES locations (business_id, id)
) STRICT;
