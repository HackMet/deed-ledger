-- The name a store gives a person is that store's own: it lives on the membership, so an owner
-- can never write or read another store's name for the same phone. users.display_name is left to
-- the operator's admin scripts; the console no longer writes it. Conventions: see 0001_tenancy.sql.

ALTER TABLE memberships ADD COLUMN display_name TEXT
  CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 120);

-- Carry existing names over only where they can't be another store's: the person belongs to
-- exactly one store. Anyone in several stores starts unnamed and their store names them again.
UPDATE memberships SET display_name = (SELECT display_name FROM users WHERE users.id = memberships.user_id)
WHERE (SELECT COUNT(*) FROM memberships other WHERE other.user_id = memberships.user_id) = 1;
