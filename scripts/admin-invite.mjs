#!/usr/bin/env node
// Creates a one-time console invite for a member of a store and prints its link (good for 15
// minutes). Adds the person as a member first if they aren't one. Used for the owner's first login
// and during the setup session; after that the owner invites staff from the console. Local D1 by
// default; --remote writes to the deployed database and is Angel's call.
//
//   npm run admin:invite -- --phone-number-id 100000000000001 --phone 50400000002 --role staff \
//     [--name "Carla"] [--base-url https://<worker>.workers.dev] [--persist-to .wrangler/sim-state] [--remote]
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
const baseUrl = typeof args["base-url"] === "string" ? args["base-url"].replace(/\/+$/, "") : "http://127.0.0.1:8787";

const code = randomBytes(32).toString("base64url");
const codeHash = createHash("sha256").update(code).digest("hex");
const now = Date.now();
const store = `(SELECT business_id FROM channel_accounts WHERE provider = 'whatsapp' AND phone_number_id = ${sql(phoneNumberId)})`;
const user = `(SELECT id FROM users WHERE phone = ${sql(phone)})`;

const statements = [
  `INSERT INTO users (id, phone, display_name, created_at_ms)
   VALUES (${sql(randomUUID())}, ${sql(phone)}, ${name === null ? "NULL" : sql(name)}, ${now})
   ON CONFLICT (phone) DO NOTHING;`,
  // A new member gets the role asked for; an existing one keeps theirs and must be active.
  `INSERT INTO memberships (business_id, user_id, location_id, role, created_at_ms)
   SELECT ${store}, ${user}, NULL, ${sql(role)}, ${now} WHERE ${store} IS NOT NULL
   ON CONFLICT (business_id, user_id) DO NOTHING;`,
  `INSERT INTO console_invites (id, business_id, user_id, token_hash, expires_at_ms, created_at_ms)
   SELECT ${sql(randomUUID())}, m.business_id, m.user_id, ${sql(codeHash)}, ${now + INVITE_TTL_MS}, ${now}
   FROM memberships m WHERE m.business_id = ${store} AND m.user_id = ${user} AND m.active = 1;`,
];

mkdirSync(".wrangler/tmp", { recursive: true });
const file = join(".wrangler/tmp", `invite-${randomUUID()}.sql`);
writeFileSync(file, `${statements.join("\n")}\n`);

const target = args.remote === true ? ["--remote"] : ["--local", ...(typeof args["persist-to"] === "string" ? ["--persist-to", args["persist-to"]] : [])];
const check = `SELECT m.role FROM console_invites i
  JOIN memberships m ON m.business_id = i.business_id AND m.user_id = i.user_id
  WHERE i.token_hash = ${sql(codeHash)};`;
let actualRole;
try {
  wrangler(["d1", "execute", "DB", ...target, "--file", file], { env: process.env, capture: true });
  const out = wrangler(["d1", "execute", "DB", ...target, "--json", "--command", check], { env: process.env, capture: true });
  actualRole = JSON.parse(out)[0]?.results?.[0]?.role;
} catch (error) {
  fail(error.message);
}
// The code is never written to disk: only its hash went into the SQL file.
if (actualRole === undefined) fail("no invite created: unknown store number, or the member is deactivated");
if (actualRole !== role) console.log(`Note: already a member as ${actualRole}; the role wasn't changed.`);

console.log(`Invite for ${actualRole} ${name ?? phone.slice(-4).padStart(phone.length, "•")}, valid 15 minutes, one use:`);
console.log(`${baseUrl}/console/entrar?codigo=${code}`);
