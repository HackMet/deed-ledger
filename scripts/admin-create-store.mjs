#!/usr/bin/env node
// Creates a store, its location, its WhatsApp number mapping and an owner membership.
// Synthetic data only unless Angel decides otherwise. Local D1 by default; --remote writes to the
// deployed database and is Angel's call.
//
//   npm run admin:create-store -- --name "Tienda B (sintética)" --phone-number-id 100000000000002 \
//     --owner-phone 50400000002 [--owner-name "Dueña B"] [--location "Principal"] \
//     [--persist-to .wrangler/sim-state] [--remote]
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, wrangler } from "./lib/sim.mjs";

const args = parseArgs(process.argv.slice(2));

function fail(message) {
  console.error(`admin-create-store: ${message}`);
  process.exit(1);
}

function name(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`--${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length > 120 || /[\u0000-\u001f\u007f]/.test(trimmed)) fail(`--${label} must be 1-120 printable characters`);
  return trimmed;
}

function digits(value, label, min, max) {
  if (typeof value !== "string") fail(`--${label} is required`);
  const cleaned = value.replace(/^\+/, "");
  if (!/^[0-9]+$/.test(cleaned) || cleaned.length < min || cleaned.length > max) {
    fail(`--${label} must be ${min}-${max} digits`);
  }
  return cleaned;
}

const sql = (text) => `'${text.replaceAll("'", "''")}'`;

const storeName = name(args.name, "name");
const locationName = args.location === undefined ? "Principal" : name(args.location, "location");
const ownerName = args["owner-name"] === undefined ? null : name(args["owner-name"], "owner-name");
const phoneNumberId = digits(args["phone-number-id"], "phone-number-id", 1, 32);
const ownerPhone = digits(args["owner-phone"], "owner-phone", 6, 15);

const ids = { business: randomUUID(), location: randomUUID(), channelAccount: randomUUID(), user: randomUUID(), product: randomUUID() };
const now = Date.now();

const statements = [
  `INSERT INTO businesses (id, name, created_at_ms) VALUES (${sql(ids.business)}, ${sql(storeName)}, ${now});`,
  `INSERT INTO locations (id, business_id, name, created_at_ms)
   VALUES (${sql(ids.location)}, ${sql(ids.business)}, ${sql(locationName)}, ${now});`,
  `INSERT INTO channel_accounts (id, business_id, location_id, provider, phone_number_id, created_at_ms)
   VALUES (${sql(ids.channelAccount)}, ${sql(ids.business)}, ${sql(ids.location)}, 'whatsapp', ${sql(phoneNumberId)}, ${now});`,
  // A person can belong to several stores: reuse the user if the phone is already known.
  `INSERT INTO users (id, phone, display_name, created_at_ms)
   VALUES (${sql(ids.user)}, ${sql(ownerPhone)}, ${ownerName === null ? "NULL" : sql(ownerName)}, ${now})
   ON CONFLICT (phone) DO NOTHING;`,
  `INSERT INTO memberships (business_id, user_id, location_id, role, created_at_ms)
   SELECT ${sql(ids.business)}, id, ${sql(ids.location)}, 'owner', ${now} FROM users WHERE phone = ${sql(ownerPhone)};`,
  // One synthetic product until the catalog exists, so stock movements have a product to name.
  `INSERT INTO products (id, business_id, canonical_name, created_at_ms)
   VALUES (${sql(ids.product)}, ${sql(ids.business)}, ${sql("Producto de prueba (sintético)")}, ${now});`,
];

mkdirSync(".wrangler/tmp", { recursive: true });
const file = join(".wrangler/tmp", `create-store-${ids.business}.sql`);
writeFileSync(file, `${statements.join("\n")}\n`);

const target = args.remote === true ? ["--remote"] : ["--local", ...(typeof args["persist-to"] === "string" ? ["--persist-to", args["persist-to"]] : [])];
try {
  wrangler(["d1", "execute", "DB", ...target, "--file", file], { env: process.env, capture: args.remote !== true });
} catch (error) {
  fail(error.message);
}

console.log(
  JSON.stringify(
    {
      created: { businessId: ids.business, locationId: ids.location, channelAccountId: ids.channelAccount, productId: ids.product },
      database: args.remote === true ? "remote" : "local",
    },
    null,
    2,
  ),
);
