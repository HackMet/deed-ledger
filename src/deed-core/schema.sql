-- The core's four tables, with neutral names and no kind lists: a host's policy decides which kinds exist.
-- Every row is scoped by scope_id (a tenant, a site, a lot: the host decides). Append-only: nothing updates
-- or removes a row, so each trigger below refuses it. A host may add its own columns and CHECKs in its own
-- migration, never by editing these tables.

-- One operation = one operation_key. A second entry with the same key is a duplicate, refused by the judge first.
CREATE TABLE facts (
  scope_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  valid_from_ms INTEGER NOT NULL,          -- business time
  recorded_at_ms INTEGER NOT NULL,         -- system time
  body_json TEXT NOT NULL,
  agent_id TEXT,                           -- stamped by the host on a claim; the core stores it and never reads it
  PRIMARY KEY (scope_id, id),
  UNIQUE (scope_id, operation_key)
) STRICT;

-- The evidence a fact rests on. content_sha256 is optional: any evidence may carry a hash.
CREATE TABLE fact_evidence (
  scope_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  content_sha256 TEXT,
  PRIMARY KEY (scope_id, fact_id, kind, ref_id)
) STRICT;

-- "Fact B was decided using fact A" (B -> A). Liveness is derived from these edges, never cascaded.
CREATE TABLE fact_dependencies (
  scope_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  depends_on_fact_id TEXT NOT NULL,
  PRIMARY KEY (scope_id, fact_id, depends_on_fact_id),
  CHECK (fact_id <> depends_on_fact_id)
) STRICT;

-- A fact closes once: the primary key refuses a second close, so a double close fails loudly.
CREATE TABLE fact_closures (
  scope_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  closed_by_fact_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('cancelled', 'superseded')),
  closed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_id, fact_id)
) STRICT;

CREATE TRIGGER facts_are_never_updated BEFORE UPDATE ON facts
BEGIN
  SELECT RAISE(ABORT, 'facts are append-only');
END;

CREATE TRIGGER facts_are_never_deleted BEFORE DELETE ON facts
BEGIN
  SELECT RAISE(ABORT, 'facts are append-only');
END;

CREATE TRIGGER fact_evidence_is_never_updated BEFORE UPDATE ON fact_evidence
BEGIN
  SELECT RAISE(ABORT, 'fact evidence is append-only');
END;

CREATE TRIGGER fact_evidence_is_never_deleted BEFORE DELETE ON fact_evidence
BEGIN
  SELECT RAISE(ABORT, 'fact evidence is append-only');
END;

CREATE TRIGGER fact_dependencies_are_never_updated BEFORE UPDATE ON fact_dependencies
BEGIN
  SELECT RAISE(ABORT, 'fact dependencies are append-only');
END;

CREATE TRIGGER fact_dependencies_are_never_deleted BEFORE DELETE ON fact_dependencies
BEGIN
  SELECT RAISE(ABORT, 'fact dependencies are append-only');
END;

CREATE TRIGGER fact_closures_are_never_updated BEFORE UPDATE ON fact_closures
BEGIN
  SELECT RAISE(ABORT, 'fact closures are append-only');
END;

CREATE TRIGGER fact_closures_are_never_deleted BEFORE DELETE ON fact_closures
BEGIN
  SELECT RAISE(ABORT, 'fact closures are append-only');
END;

-- INSERT OR REPLACE deletes the old row without firing a delete trigger (recursive_triggers is off), so an insert
-- that would replace a row is refused here, before the replace happens.
CREATE TRIGGER facts_are_never_replaced BEFORE INSERT ON facts
WHEN EXISTS (SELECT 1 FROM facts WHERE scope_id = NEW.scope_id AND (id = NEW.id OR operation_key = NEW.operation_key))
BEGIN
  SELECT RAISE(ABORT, 'facts are append-only');
END;

CREATE TRIGGER fact_evidence_is_never_replaced BEFORE INSERT ON fact_evidence
WHEN EXISTS (SELECT 1 FROM fact_evidence WHERE scope_id = NEW.scope_id AND fact_id = NEW.fact_id AND kind = NEW.kind AND ref_id = NEW.ref_id)
BEGIN
  SELECT RAISE(ABORT, 'fact evidence is append-only');
END;

CREATE TRIGGER fact_dependencies_are_never_replaced BEFORE INSERT ON fact_dependencies
WHEN EXISTS (SELECT 1 FROM fact_dependencies WHERE scope_id = NEW.scope_id AND fact_id = NEW.fact_id AND depends_on_fact_id = NEW.depends_on_fact_id)
BEGIN
  SELECT RAISE(ABORT, 'fact dependencies are append-only');
END;

CREATE TRIGGER fact_closures_are_never_replaced BEFORE INSERT ON fact_closures
WHEN EXISTS (SELECT 1 FROM fact_closures WHERE scope_id = NEW.scope_id AND fact_id = NEW.fact_id)
BEGIN
  SELECT RAISE(ABORT, 'fact closures are append-only');
END;

-- Batch guards: a D1 batch inserts one row per guard, whose `ok` is NULL unless the guard holds; NOT NULL then aborts
-- the whole batch. The batch deletes its guard rows as its last statement, so the table stays empty.
CREATE TABLE batch_guards (
  guard_id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;
