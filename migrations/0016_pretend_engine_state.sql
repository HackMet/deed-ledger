-- Stand-in until the real engine lands: the pretend engine's state for each store, as one JSON
-- snapshot, so a deployed demo shares it between isolates (PRETEND_ENGINE=1). Written only through
-- a version compare-and-swap in the caller's batch (src/infrastructure/memory/d1-pretend-engine.ts).
-- Drop it with the pretend engine. Conventions: see 0001_tenancy.sql.

CREATE TABLE pretend_engine_state (
  business_id TEXT PRIMARY KEY REFERENCES businesses (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  updated_at_ms INTEGER NOT NULL
) STRICT;
