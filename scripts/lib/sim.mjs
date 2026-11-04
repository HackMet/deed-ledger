// Shared settings for the local simulator. Everything here is fake and safe to commit.
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";

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
  LINK_SIGNING_SECRET: "sim-link-secret-not-real",
  // Blank so the simulator never spends: the real key in .dev.vars would otherwise reach it.
  MODEL_API_KEY: "",
};

/** Plain settings for the simulated Worker: the console opens without login, on the pretend engine. */
export const SIM_VARS = {
  DEV_CONSOLE: "1",
  // wrangler.jsonc turns the real engine on for the deployed Worker, and it wins over the other two.
  DEED_ENGINE: "0",
  // The console acts as this store's owner, so it shows the orders typed in `npm run chat`.
  DEV_STORE_PHONE_NUMBER_ID: SIM.phoneNumberId,
  // WhatsApp test commands (/new, /help) for the store's members (the owner's phone, SIM.ownerPhone).
  TEST_COMMANDS: "1",
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

/**
 * An outbox row's buttons_json, in either shape: a plain array of buttons, or (with a footer or a
 * text fallback) `{ buttons, footer, textFallback }`. Missing or unreadable: no buttons.
 */
export function readButtonsJson(json) {
  if (json === null || json === undefined) return { buttons: [], footer: null };
  try {
    const value = JSON.parse(json);
    if (Array.isArray(value)) return { buttons: value, footer: null };
    return { buttons: Array.isArray(value?.buttons) ? value.buttons : [], footer: typeof value?.footer === "string" ? value.footer : null };
  } catch {
    return { buttons: [], footer: null };
  }
}

/** Posts one message to the local Worker as a Meta webhook, signed with the simulator's app secret. */
export async function postWebhook(url, message, { from, to = SIM.phoneNumberId }) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "900000000000001",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: to },
              contacts: [{ profile: { name: "Simulador" }, wa_id: from }],
              messages: [message],
            },
          },
        ],
      },
    ],
  });
  const signature = `sha256=${createHmac("sha256", SIM.appSecret).update(body).digest("hex")}`;
  return fetch(`${url}/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body,
  });
}

/**
 * Uploads a local photo or voice note to the simulator (dev only) and returns the media ID a webhook
 * can name, as WhatsApp's would. The simulator serves it back when the Worker downloads that media.
 */
export async function uploadSimMedia(url, path) {
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(path);
  const type = /\.(ogg|opus)$/i.test(path) ? "audio/ogg; codecs=opus" : /\.png$/i.test(path) ? "image/png" : "image/jpeg";
  const response = await fetch(`${url}/dev/sim-media`, { method: "POST", headers: { "content-type": type }, body: bytes });
  if (!response.ok) throw new Error(`upload refused (${response.status}): is the simulator running with this version?`);
  const { id } = await response.json();
  return { id, type };
}

/** The webhook message for an uploaded photo or voice note. */
export function mediaMessage({ id, type }, caption) {
  return type.startsWith("audio/")
    ? { type: "audio", audio: { id, mime_type: type, sha256: "c2lt", voice: true } }
    : { type: "image", image: { id, mime_type: type, sha256: "c2lt", ...(caption ? { caption } : {}) } };
}
