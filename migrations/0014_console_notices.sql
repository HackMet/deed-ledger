-- Customer notices queued by a console action (#18). They have no job: their group is the action's
-- operation key, within one conversation. A row in a group is never sent after an earlier row of
-- the same group ended unsent, as for a job's replies. A row belongs to a job or to an action,
-- never both. Conventions: see 0001_tenancy.sql.

ALTER TABLE outbound_messages ADD COLUMN operation_key TEXT
  CHECK (operation_key IS NULL OR (job_id IS NULL AND length(operation_key) BETWEEN 1 AND 200));

CREATE INDEX outbound_by_operation ON outbound_messages (business_id, operation_key, seq);
