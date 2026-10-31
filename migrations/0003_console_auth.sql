-- Console login: single-use invites and long-lived sessions for the store's members. Tokens are
-- stored as SHA-256 hashes; the raw token only exists in the invite link and the session cookie.

ALTER TABLE memberships ADD COLUMN can_approve_fiado INTEGER NOT NULL DEFAULT 0 CHECK (can_approve_fiado IN (0, 1));

CREATE TABLE console_invites (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at_ms INTEGER NOT NULL,
  -- Set once, when the invite opens a session. An invite is never used twice.
  used_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (business_id, user_id) REFERENCES memberships (business_id, user_id)
) STRICT;

CREATE TABLE console_sessions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  -- Set when the member's sessions are ended: every request re-checks it, together with the membership.
  revoked_at_ms INTEGER,
  FOREIGN KEY (business_id, user_id) REFERENCES memberships (business_id, user_id)
) STRICT;

CREATE INDEX console_sessions_by_member ON console_sessions (business_id, user_id);
