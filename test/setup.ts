import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Real credentials must never reach a test: stop the run if any secret-looking binding is set.
for (const [name, value] of Object.entries(env)) {
  if (/SECRET|TOKEN|KEY|SALT|PASSWORD/.test(name) && typeof value === "string" && value !== "") {
    throw new Error(`Test binding ${name} must be blank; tests pass fake values explicitly`);
  }
}

// Setup files can run more than once; applyD1Migrations only applies what's missing.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
