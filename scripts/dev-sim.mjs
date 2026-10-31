#!/usr/bin/env node
// Runs the Worker locally for the simulator, with fake secrets and its own local state:
//   1. writes .wrangler/sim/sim.env (fake values; WHATSAPP_TOKEN blank, so nothing reaches WhatsApp)
//   2. applies every migration to the simulator's local D1
//   3. seeds the synthetic demo store if it isn't there yet
//   4. starts `wrangler dev` with only that env file, so .dev.vars is never loaded
//
//   npm run dev:sim            then, in another terminal:   npm run chat
//
// With --ai, customer messages are read by Muse Spark for real, which spends Meta credits (about
// US$0.01 per message, inside the per-store daily cap). Only MODEL_API_KEY is taken, from
// MODEL_API_KEY in the environment or the --vars file (default .dev.vars); WhatsApp stays fake.
//
//   npm run dev:sim -- --ai --vars ../hackathon/.dev.vars
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs, queryLocal, SIM, SIM_SECRETS, SIM_VARS, simChildEnv, wrangler } from "./lib/sim.mjs";

const args = parseArgs(process.argv.slice(2));

/** The model key for --ai, read without printing it; null when there is none. */
function modelKey() {
  if ((process.env.MODEL_API_KEY ?? "") !== "") return process.env.MODEL_API_KEY;
  const path = typeof args.vars === "string" ? args.vars : ".dev.vars";
  if (!existsSync(path)) return null;
  const line = readFileSync(path, "utf8")
    .split("\n")
    .find((row) => row.startsWith("MODEL_API_KEY="));
  const value = line?.slice("MODEL_API_KEY=".length).trim().replace(/^["']|["']$/g, "") ?? "";
  return value === "" ? null : value;
}

const aiKey = args.ai === true ? modelKey() : null;
if (args.ai === true && aiKey === null) {
  console.error("--ai needs MODEL_API_KEY: set it in the environment or pass --vars <path to .dev.vars>.");
  process.exit(1);
}

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
  // The key travels only in the child's environment, never in the env file on disk.
  { stdio: "inherit", env: aiKey === null ? simChildEnv() : { ...simChildEnv(), MODEL_API_KEY: aiKey } },
);
if (aiKey !== null) console.log("AI mode: customer messages are read by Muse Spark (spends Meta credits).");
dev.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => dev.kill(signal));
