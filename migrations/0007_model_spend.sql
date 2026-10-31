-- Model spend per store per day, for the daily cap. A call reserves its estimate first, in one
-- statement that adds only while the day stays under the cap, so concurrent calls can't pass it
-- together; the actual cost replaces the estimate after the call. Micro-dollars: 1000000 is US$1.

CREATE TABLE model_spend (
  business_id TEXT NOT NULL REFERENCES businesses (id),
  -- The store's local day, YYYY-MM-DD.
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  micro_usd INTEGER NOT NULL CHECK (micro_usd >= 0),
  calls INTEGER NOT NULL CHECK (calls >= 0),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (business_id, day)
) STRICT;
