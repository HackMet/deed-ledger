import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { extractOpusWasm } from "./scripts/extract-opus-wasm.mjs";

/**
 * Wrangler loads .dev.vars (or process.env for the declared secrets) into the test Worker. These
 * bindings override every secret with "", so real credentials never reach a test. Tests that need
 * a secret pass an obviously fake one explicitly, and test/setup.ts fails the run if any
 * secret-looking binding is non-empty.
 */
const BLANK_SECRETS = {
  WHATSAPP_APP_SECRET: "",
  WHATSAPP_VERIFY_TOKEN: "",
  WHATSAPP_TOKEN: "",
  SENDER_HASH_SALT: "",
  MODEL_API_KEY: "",
  LINK_SIGNING_SECRET: "",
};

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  // The voice-note decoder imports the libopus Wasm that this extracts (wrangler's build command
  // does the same for dev and deploy).
  await extractOpusWasm();
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Test-only binding so the setup file can apply every migration to the local D1.
          // DEED_ENGINE: off unless a test turns it on; wrangler.jsonc's "1" is for the deployed Worker.
          bindings: { ...BLANK_SECRETS, DEED_ENGINE: "0", TEST_MIGRATIONS: migrations },
          // An empty database for the migration test, which applies migrations step by step.
          d1Databases: { MIGRATION_TEST_DB: "migration-test" },
        },
      }),
    ],
    // Same stub as wrangler.jsonc's "alias", which the test pool doesn't apply.
    resolve: {
      alias: { "@eshaz/web-worker": path.join(import.meta.dirname, "src/integrations/audio/no-web-worker.ts") },
    },
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
