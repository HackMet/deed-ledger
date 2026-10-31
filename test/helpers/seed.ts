import { env } from "cloudflare:workers";

function randomDigits(count: number): string {
  return [...crypto.getRandomValues(new Uint8Array(count))].map((byte) => String(byte % 10)).join("");
}

/** A random synthetic phone_number_id, so tests never collide even if storage is shared. */
export function newPhoneNumberId(): string {
  return `1${randomDigits(14)}`;
}

/** A random synthetic member phone: Honduras country code, then "0", which no real number starts with. */
export function newPhone(): string {
  return `5040${randomDigits(8)}`;
}

export interface SeededStore {
  readonly businessId: string;
  readonly locationId: string;
  readonly channelAccountId: string;
  readonly phoneNumberId: string;
  readonly members: ReadonlyArray<{ readonly userId: string; readonly phone: string; readonly role: "owner" | "staff" }>;
}

/** Creates a synthetic store with its location, WhatsApp number and members. */
export async function seedStore(options: {
  readonly name?: string;
  readonly phoneNumberId?: string;
  readonly members: ReadonlyArray<{ readonly phone: string; readonly role: "owner" | "staff" }>;
}): Promise<SeededStore> {
  const businessId = crypto.randomUUID();
  const locationId = crypto.randomUUID();
  const channelAccountId = crypto.randomUUID();
  const phoneNumberId = options.phoneNumberId ?? newPhoneNumberId();
  const now = Date.UTC(2026, 9, 1);
  const statements = [
    env.DB.prepare(`INSERT INTO businesses (id, name, created_at_ms) VALUES (?1, ?2, ?3)`).bind(
      businessId,
      options.name ?? "Tienda de prueba",
      now,
    ),
    env.DB.prepare(`INSERT INTO locations (id, business_id, name, created_at_ms) VALUES (?1, ?2, 'Principal', ?3)`).bind(
      locationId,
      businessId,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO channel_accounts (id, business_id, location_id, provider, phone_number_id, created_at_ms)
       VALUES (?1, ?2, ?3, 'whatsapp', ?4, ?5)`,
    ).bind(channelAccountId, businessId, locationId, phoneNumberId, now),
  ];
  for (const member of options.members) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO users (id, phone, created_at_ms) VALUES (?1, ?2, ?3) ON CONFLICT (phone) DO NOTHING`,
      ).bind(crypto.randomUUID(), member.phone, now),
      env.DB.prepare(
        `INSERT INTO memberships (business_id, user_id, location_id, role, created_at_ms)
         SELECT ?1, id, ?2, ?3, ?4 FROM users WHERE phone = ?5`,
      ).bind(businessId, locationId, member.role, now, member.phone),
    );
  }
  await env.DB.batch(statements);

  const members = [];
  for (const member of options.members) {
    const row = await env.DB.prepare(`SELECT id FROM users WHERE phone = ?1`).bind(member.phone).first<{ id: string }>();
    members.push({ userId: row!.id, phone: member.phone, role: member.role });
  }
  return { businessId, locationId, channelAccountId, phoneNumberId, members };
}

/** A customer of the store, as intake would create one. Returns the customer's ID. */
export async function seedCustomer(store: Pick<SeededStore, "businessId">, phone: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO customers (id, business_id, phone, created_at_ms) VALUES (?1, ?2, ?3, ?4)`)
    .bind(id, store.businessId, phone, Date.UTC(2026, 9, 1))
    .run();
  return id;
}
