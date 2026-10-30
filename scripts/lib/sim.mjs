// Shared settings for the local simulator. Everything here is fake and safe to commit.
import { spawnSync } from "node:child_process";

export const SIM = {
  appSecret: "sim-app-secret-not-real",
  verifyToken: "sim-verify-token-not-real",
  salt: "sim-salt-not-real",
  // Local state for simulator runs, separate from `npm run dev`'s default .wrangler/state.
  persistTo: ".wrangler/sim-state",
  envFile: ".wrangler/sim/sim.env",
  port: 8787,
  // The synthetic store the simulator seeds and writes to.
  storeName: "Tienda demo (sintética)",
  phoneNumberId: "100000000000001",
  ownerPhone: "50400000001",
};

/** Secrets for the simulated Worker. WHATSAPP_TOKEN stays blank: nothing is ever sent to WhatsApp. */
export const SIM_SECRETS = {
  WHATSAPP_APP_SECRET: SIM.appSecret,
  WHATSAPP_VERIFY_TOKEN: SIM.verifyToken,
  WHATSAPP_TOKEN: "",
  SENDER_HASH_SALT: SIM.salt,
};

/** Plain settings for the simulated Worker: the console opens without login, on the pretend engine. */
export const SIM_VARS = {
  DEV_CONSOLE: "1",
};

/**
 * The environment for child processes: the caller's environment minus anything that looks like
 * a credential, plus the fake simulator secrets. Wrangler lets process.env override env files for
 * declared secrets, so they are set explicitly here.
 */
export function simChildEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/SECRET|TOKEN|KEY|SALT|PASSWORD/i.test(name)) env[name] = value;
  }
  return { ...env, ...SIM_SECRETS };
}

/** Runs wrangler and returns stdout; throws with wrangler's output when it fails. */
export function wrangler(args, { env = simChildEnv(), capture = true } = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

/** Runs one read-only SQL query against the simulator's local D1 and returns its rows. */
export function queryLocal(sql, persistTo = SIM.persistTo) {
  const out = wrangler(["d1", "execute", "DB", "--local", "--persist-to", persistTo, "--json", "--command", sql]);
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[name] = true;
    else {
      args[name] = next;
      i++;
    }
  }
  return args;
}
