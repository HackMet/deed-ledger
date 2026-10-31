-- Replies carry their claims and buttons on the outbox row. The claims are checked again right
-- before the send (the claim check's second pass); a row whose claims no longer hold isn't sent,
-- the safe fixed reply goes instead, and claims_blocked_at_ms records it. A sent row with
-- claims_blocked_at_ms set was not delivered as written.
ALTER TABLE outbound_messages ADD COLUMN claims_json TEXT CHECK (claims_json IS NULL OR json_valid(claims_json));
ALTER TABLE outbound_messages ADD COLUMN buttons_json TEXT CHECK (buttons_json IS NULL OR json_valid(buttons_json));
ALTER TABLE outbound_messages ADD COLUMN claims_blocked_at_ms INTEGER;
