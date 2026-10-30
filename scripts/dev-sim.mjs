#!/usr/bin/env node
// Runs the Worker locally for the simulator, with fake secrets and its own local state:
//   1. writes .wrangler/sim/sim.env (fake values; WHATSAPP_TOKEN blank, so nothing reaches WhatsApp)
//   2. applies every migration to the simulator's local D1
//   3. seeds the synthetic demo store if it isn't there yet
//   4. starts `wrangler dev` with only that env file, so .dev.vars is never loaded
//
//   npm run dev:sim            then, in another terminal:   npm run simulate -- --text "Hola"
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { queryLocal, SIM, SIM_SECRETS, SIM_VARS, simChildEnv, wrangler } from "./lib/sim.mjs";

mkdirSync(dirname(SIM.envFile), { recursive: true });
writeFileSync(
  SIM.envFile,
  `${Object.entries({ ...SIM_SECRETS, ...SIM_VARS })
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`,
);

console.log("Applying migrations to the simulator's local D1…");
wrangler(["d1", "migrations", "apply", "DB", "--local", "--persist-to", SIM.persistTo]);

const existing = queryLocal(
  `SELECT business_id FROM channel_accounts WHERE phone_number_id = '${SIM.phoneNumberId}'`,
);
if (existing.length === 0) {
  console.log("Seeding the synthetic demo store…");
  const seeded = spawn(
    process.execPath,
    [
      "scripts/admin-create-store.mjs",
      "--name",
      SIM.storeName,
      "--phone-number-id",
      SIM.phoneNumberId,
      "--owner-phone",
      SIM.ownerPhone,
      "--persist-to",
      SIM.persistTo,
    ],
    { stdio: "inherit", env: simChildEnv() },
  );
  const code = await new Promise((resolve) => seeded.on("exit", resolve));
  if (code !== 0) process.exit(code ?? 1);
}

console.log(`Starting the Worker on http://127.0.0.1:${SIM.port} (fake secrets, no WhatsApp sends)…`);
const dev = spawn(
  "npx",
  ["wrangler", "dev", "--env-file", SIM.envFile, "--persist-to", SIM.persistTo, "--port", String(SIM.port), "--ip", "127.0.0.1"],
  { stdio: "inherit", env: simChildEnv() },
);
dev.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => dev.kill(signal));
