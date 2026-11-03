-- Console staff management: when a member acknowledged the first-login notice that their voice
-- notes are kept as the store's records. NULL until they tap "Entendido".

ALTER TABLE memberships ADD COLUMN voice_notice_seen_at_ms INTEGER;
