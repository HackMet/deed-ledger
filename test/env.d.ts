declare namespace Cloudflare {
  interface Env {
    /** Defined in vitest.config.ts. */
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
