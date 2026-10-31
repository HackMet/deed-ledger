declare namespace Cloudflare {
  interface Env {
    /** Defined in vitest.config.ts. */
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    /** Defined in vitest.config.ts: an empty D1 for the migration test. */
    MIGRATION_TEST_DB: D1Database;
  }
}
