#!/usr/bin/env node
// Creates a one-time console invite for a member of a store and prints its link (good for 15
// minutes). Adds the person as a member first if they aren't one. Used for the owner's first login
// and during the setup session. Local D1 by
// default; --remote writes to the deployed database and is Angel's call.
//
//   npm run admin:invite -- --phone-number-id 100000000000001 --phone 50400000002 --role staff \
//     [--name "Carla"] [--base-url https://<worker>.workers.dev] [--persist-to .wrangler/sim-state] [--remote]
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, wrangler } from "./lib/sim.mjs";

const INVITE_TTL_MS = 15 * 60 * 1000; // keep in step with src/domain/console-auth.ts

const args = parseArgs(process.argv.slice(2));

function fail(message) {
  console.error(`admin-invite: ${message}`);
  process.exit(1);
}

function digits(value, label, min, max) {
  if (typeof value !== "string") fail(`--${label} is required`);
  const cleaned = value.replace(/^\+/, "");
  if (!/^[0-9]+$/.test(cleaned) || cleaned.length < min || cleaned.length > max) fail(`--${label} must be ${min}-${max} digits`);
  return cleaned;
}

const sql = (text) => `'${text.replaceAll("'", "''")}'`;

const phoneNumberId = digits(args["phone-number-id"], "phone-number-id", 1, 32);
const phone = digits(args.phone, "phone", 6, 15);
const role = args.role === undefined ? "staff" : args.role;
if (role !== "owner" && role !== "staff") fail("--role must be owner or staff");
let name = null;
if (args.name !== undefined) {
  if (typeof args.name !== "string" || args.name.trim() === "" || args.name.trim().length > 120) fail("--name must be 1-120 characters");
  name = args.name.trim();
}
if (args.remote === true && typeof args["base-url"] !== "string") fail("--remote needs --base-url (the deployed Worker's address)");
const baseUrl = typeof args["base-url"] === "string" ? args["base-url"].replace(/\/+$/, "") : "http://127.0.0.1:8787";

const code = randomBytes(32).toString("base64url");
const codeHash = createHash("sha256").update(code).digest("hex");
const now = Date.now();
const store = `(SELECT business_id FROM channel_accounts WHERE provider = 'whatsapp' AND phone_number_id = ${sql(phoneNumberId)})`;
const user = `(SELECT id FROM users WHERE phone = ${sql(phone)})`;

const statements = [
  // Nothing is written for an unknown store number.
  `INSERT INTO users (id, phone, display_name, created_at_ms)
   SELECT ${sql(randomUUID())}, ${sql(phone)}, ${name === null ? "NULL" : sql(name)}, ${now} WHERE ${store} IS NOT NULL
   ON CONFLICT (phone) DO NOTHING;`,
  // A new member gets the role asked for; an existing one keeps theirs and must be active.
  `INSERT INTO memberships (business_id, user_id, location_id, role, created_at_ms)
   SELECT ${store}, ${user}, NULL, ${sql(role)}, ${now} WHERE ${store} IS NOT NULL
   ON CONFLICT (business_id, user_id) DO NOTHING;`,
  // The database's clock, not this machine's: the Worker checks expiry against its own clock.
  `INSERT INTO console_invites (id, business_id, user_id, token_hash, expires_at_ms, created_at_ms)
   SELECT ${sql(randomUUID())}, m.business_id, m.user_id, ${sql(codeHash)}, db.now + ${INVITE_TTL_MS}, db.now
   FROM memberships m, (SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now) db WHERE m.business_id = ${store} AND m.user_id = ${user} AND m.active = 1;`,
];

mkdirSync(".wrangler/tmp", { recursive: true });
const file = join(".wrangler/tmp", `invite-${randomUUID()}.sql`);
writeFileSync(file, `${statements.join("\n")}\n`);

const target = args.remote === true ? ["--remote"] : ["--local", ...(typeof args["persist-to"] === "string" ? ["--persist-to", args["persist-to"]] : [])];
const check = `SELECT m.role, u.display_name FROM console_invites i
  JOIN memberships m ON m.business_id = i.business_id AND m.user_id = i.user_id
  JOIN users u ON u.id = i.user_id
  WHERE i.token_hash = ${sql(codeHash)};`;
let invited;
try {
  wrangler(["d1", "execute", "DB", ...target, "--file", file], { env: process.env, capture: true });
  const out = wrangler(["d1", "execute", "DB", ...target, "--json", "--command", check], { env: process.env, capture: true });
  invited = JSON.parse(out)[0]?.results?.[0];
} catch (error) {
  rmSync(file, { force: true });
  fail(error.message);
}
// The SQL file holds the phone number; the code itself was never written to disk.
rmSync(file, { force: true });
if (invited === undefined) fail("no invite created: unknown store number, or the member is deactivated");
if (args.role !== undefined && invited.role !== role) console.log(`Note: already a member as ${invited.role}; the role wasn't changed.`);

console.log(`Invite for ${invited.role} ${invited.display_name ?? phone.slice(-4).padStart(phone.length, "•")}, valid 15 minutes, one use:`);
console.log(`${baseUrl}/console/entrar?codigo=${code}`);
