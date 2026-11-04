import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Claim } from "../src/domain/contract/outcomes";
import { INVITE_TTL_MS } from "../src/domain/console-auth";
import { type DeedEntry, entryOf, recheckEntry } from "../src/domain/deed-recheck";
import { D1LibroReads } from "../src/infrastructure/d1/libro-reads";
import { hashToken, newToken } from "../src/infrastructure/tokens";
import { firstOrder, ids } from "./fixtures/contract";
import { type Harness, harness } from "./helpers/harness";
import { T0, engine, newStore, placeFirstOrder, save, tap } from "./helpers/orders";
import { newPhone, seedStore } from "./helpers/seed";

type Store = Awaited<ReturnType<typeof newStore>>;

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function get(h: Harness, path: string, cookie?: string) {
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(
    new IncomingRequest(`https://worker.test${path}`, { headers: cookie === undefined ? {} : { cookie }, redirect: "manual" }),
    h.env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** A session for a member of the store, opened through the real invite. Returns the cookie. */
async function login(h: Harness, s: Store, role: "owner" | "staff"): Promise<string> {
  const member = await env.DB.prepare(`SELECT user_id AS id FROM memberships WHERE business_id = ? AND role = ?`)
    .bind(s.businessId, role)
    .first<{ id: string }>();
  const code = newToken();
  const now = h.clock.now();
  await env.DB.prepare(
    `INSERT INTO console_invites (id, business_id, user_id, token_hash, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), s.businessId, member!.id, await hashToken(code), now + INVITE_TTL_MS, now)
    .run();
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(
    new IncomingRequest("https://worker.test/console/entrar", {
      method: "POST",
      headers: { origin: "https://worker.test" },
      body: new URLSearchParams({ codigo: code }),
      redirect: "manual",
    }),
    h.env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(303);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

/** A store whose members sign in: an owner and a staff member, both in the store `newStore` seeds. */
async function storeWithMembers(): Promise<Store & { readonly phones: readonly string[] }> {
  const base = await seedStore({
    members: [
      { phone: newPhone(), role: "owner" },
      { phone: newPhone(), role: "staff" },
    ],
  });
  const s = await newStore();
  await env.DB.batch(
    base.members.map((m) =>
      env.DB.prepare(
        `INSERT INTO memberships (business_id, user_id, location_id, role, created_at_ms)
         SELECT ?1, ?2, id, ?3, 0 FROM locations WHERE business_id = ?1`,
      ).bind(s.businessId, m.userId, m.role),
    ),
  );
  return { ...s, phones: base.members.map((m) => m.phone) };
}

const REPLY_TEXT = "Tu pedido está confirmado, gracias por tu compra.";
const CUSTOMER_NAME = "Ana Sintética Prueba";
const MEMBER_NAME = "Dueño Sintético Prueba";

/** The keys each object of the entry may carry. A key the list lacks fails the test, so a new field is listed on purpose. */
const ENTRY_KEYS = {
  entry: ["schema", "input", "verdicts"],
  input: ["orderId", "facts", "lines", "replies", "refusals"],
  fact: ["id", "kind", "operationKey", "recordedAtMs", "version", "status", "resumeState", "live", "witness"],
  witness: ["kind", "refId"],
  line: ["version", "counted", "unitPrice", "quantity"],
  reply: ["id", "atMs", "status", "providerStatus", "providerStatusAtS", "claims"],
  check: ["anyOf"],
  claim: {
    order_state: ["type", "orderId", "version", "state"],
    order_total: ["type", "orderId", "version", "total"],
  },
  refusal: ["id", "atMs", "reason", "decidingFactId", "operationKey"],
  verdict: ["rowKey", "state"],
} as const;

function expectKeys(value: object, allowed: readonly string[]) {
  expect(Object.keys(value).sort()).toEqual([...allowed].sort());
}

/** Every object of the entry carries exactly its listed keys; a claim is checked against the list of its own type. */
function expectOnlyListedKeys(value: unknown) {
  const entry = value as DeedEntry;
  expectKeys(entry, ENTRY_KEYS.entry);
  expectKeys(entry.input, ENTRY_KEYS.input);
  for (const fact of entry.input.facts) {
    expectKeys(fact, ENTRY_KEYS.fact);
    if (fact.witness !== null) expectKeys(fact.witness, ENTRY_KEYS.witness);
  }
  for (const line of entry.input.lines) expectKeys(line, ENTRY_KEYS.line);
  for (const reply of entry.input.replies) {
    expectKeys(reply, ENTRY_KEYS.reply);
    for (const check of reply.claims) {
      expectKeys(check, ENTRY_KEYS.check);
      for (const claim of check.anyOf) {
        expect(Object.keys(ENTRY_KEYS.claim)).toContain(claim.type);
        expectKeys(claim, ENTRY_KEYS.claim[claim.type as keyof typeof ENTRY_KEYS.claim]);
      }
    }
  }
  for (const refusal of entry.input.refusals) expectKeys(refusal, ENTRY_KEYS.refusal);
  for (const verdict of entry.verdicts) expectKeys(verdict, ENTRY_KEYS.verdict);
}

/** An outbox reply carrying `claims`, delivered as `providerStatus` (null: no status yet). */
async function insertReply(businessId: string, claims: readonly Claim[], over: { status?: string; providerStatus?: string | null } = {}) {
  const id = crypto.randomUUID();
  const channel = await env.DB.prepare(`SELECT id FROM channel_accounts WHERE business_id = ?`).bind(businessId).first<{ id: string }>();
  await env.DB.prepare(
    `INSERT INTO outbound_messages (id, business_id, channel_account_id, recipient_hash, seq, kind, body_text, dedupe_key, status,
       expires_at_ms, created_at_ms, updated_at_ms, sent_at_ms, claims_json, provider_status, provider_status_at_s)
     VALUES (?, ?, ?, 'hash-synthetic', (SELECT COALESCE(MAX(seq), 0) + 1 FROM outbound_messages), 'reply', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      businessId,
      channel!.id,
      REPLY_TEXT,
      `dedupe:${id}`,
      over.status ?? "sent",
      T0 + 3_600_000,
      T0 + 1_000,
      T0 + 1_000,
      T0 + 1_500,
      JSON.stringify(claims.map((claim) => ({ anyOf: [claim] }))),
      over.providerStatus ?? null,
      over.providerStatus ? T0 / 1000 + 2 : null,
    )
    .run();
}

async function confirmedOrder(s: Store): Promise<{ orderId: string; confirmId: string }> {
  const placed = await placeFirstOrder(s, ids.customer, T0, firstOrder);
  await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1_000 }), tap(placed.orderId, 1)));
  const confirm = await env.DB.prepare(`SELECT id FROM facts WHERE business_id = ? AND kind = 'order_confirm'`)
    .bind(s.businessId)
    .first<{ id: string }>();
  return { orderId: placed.orderId, confirmId: confirm!.id };
}

/** An order with one of each pair state: delivered and believed (green), a claim of a state the book lacks (red),
 *  a reply with no delivery yet (amber), and a refused staff tap (grey gate). */
async function fourStates(s: Store): Promise<{ orderId: string; confirmId: string }> {
  const { orderId, confirmId } = await confirmedOrder(s);
  await insertReply(s.businessId, [{ type: "order_state", orderId, version: 1, state: "confirmado" }], { providerStatus: "delivered" });
  await insertReply(s.businessId, [{ type: "order_state", orderId, version: 1, state: "listo" }], { providerStatus: "read" });
  await insertReply(s.businessId, [{ type: "order_total", orderId, version: 1, total: 4000 }]);
  await env.DB.prepare(
    `INSERT INTO deed_checks (business_id, id, at_ms, source, subject_fact_id, order_id, claim_kind, result, reason_code, deciding_fact_id, operation_key)
     VALUES (?, 'chk-gate', ?, 'gate', NULL, ?, NULL, 'fail', 'invalid_state', ?, ?)`,
  )
    .bind(s.businessId, T0 + 2_000, orderId, confirmId, `staff:${orderId}:1:mark_ready`)
    .run();
  return { orderId, confirmId };
}

describe("/console/deed/:orderId/libro: the three lanes", () => {
  it("draws each pair state in the reference's colour, and each row links to its detail", async () => {
    const s = await storeWithMembers();
    const { orderId } = await fourStates(s);
    const h = harness({ engine });
    const cookie = await login(h, s, "staff");
    const response = await get(h, `/console/deed/${encodeURIComponent(orderId)}/libro`, cookie);
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const state of ["s-emparejado", "s-sin_pareja", "s-en_duda", "s-bloqueado"]) expect(body).toContain(state);
    for (const colour of ["#3A4BC8", "#0E7C86", "#1F8A4C", "#B7791F", "#C2362F"]) expect(body).toContain(colour);
    expect(body).toMatch(/<a href="#d-r\d+"/);
    expect(body).toMatch(/<section id="d-r\d+" class="panel/);
    expect(body).toContain("Sin pareja");
    expect(body).toContain("En duda");
    expect(body).toContain("Bloqueado: el estado no lo permite");
    expect(body).toContain("Sin confirmación de entrega todavía");
  });

  it("shows a balance that does not add up as a red box, saying what was said and what was recorded", async () => {
    const s = await storeWithMembers();
    const { orderId } = await confirmedOrder(s);
    // Each line costs L 10 for one: the recorded total is known, and the claim (one centavo) differs from it.
    await env.DB.prepare(`UPDATE order_lines SET unit_price_centavos = 1000, qty_milli = 1000 WHERE business_id = ? AND order_id = ?`)
      .bind(s.businessId, orderId)
      .run();
    await insertReply(s.businessId, [{ type: "order_total", orderId, version: 1, total: 1 }], { providerStatus: "delivered" });
    const h = harness({ engine });
    const cookie = await login(h, s, "owner");
    const body = await (await get(h, `/console/deed/${encodeURIComponent(orderId)}/libro`, cookie)).text();
    expect(body).toContain("dijo L 0.01 · registró L ");
    expect(body).toMatch(/class="box s-sin_pareja"/);
  });

  it("answers 404 for another store's order, and lets an owner and a staff member open this one", async () => {
    const mine = await storeWithMembers();
    const { orderId } = await fourStates(mine);
    const theirs = await storeWithMembers();
    const h = harness({ engine });
    const cookie = await login(h, mine, "staff");
    expect((await get(h, `/console/deed/${encodeURIComponent(orderId)}/libro`, cookie)).status).toBe(200);
    const ownerCookie = await login(h, mine, "owner");
    expect((await get(h, `/console/deed/${encodeURIComponent(orderId)}/libro`, ownerCookie)).status).toBe(200);
    const theirsCookie = await login(h, theirs, "owner");
    expect((await get(h, `/console/deed/${encodeURIComponent(orderId)}/libro`, theirsCookie)).status).toBe(404);
  });

  it("paints a reply the provider delivered green and one it failed red (seeded in this test only; the demo has no status webhooks)", async () => {
    const s = await storeWithMembers();
    const { orderId } = await confirmedOrder(s);
    const said: Claim[] = [{ type: "order_state", orderId, version: 1, state: "confirmado" }];
    await insertReply(s.businessId, said, { providerStatus: "delivered" });
    await insertReply(s.businessId, said, { providerStatus: "failed" });
    const h = harness({ engine });
    const cookie = await login(h, s, "staff");
    const body = await (await get(h, `/console/deed/${encodeURIComponent(orderId)}/libro`, cookie)).text();
    expect(body).toMatch(/<rect class="bar s-emparejado"|<line class="bar s-emparejado"/);
    expect(body).toMatch(/<line class="bar s-sin_pareja"/);
    expect(body).toContain("Falló el envío");
    expect(body).toContain("Entregado al teléfono");
  });

  it("leaves the drawing room for its 12 px margins inside a 360 px screen, so the page never scrolls sideways", async () => {
    const s = await storeWithMembers();
    const { orderId } = await fourStates(s);
    const h = harness({ engine });
    const cookie = await login(h, s, "staff");
    const body = await (await get(h, `/console/deed/${encodeURIComponent(orderId)}/libro`, cookie)).text();
    expect(body).toContain("width:calc(100% - 24px);max-width:420px;height:auto;margin:8px 12px;");
  });

  it("writes no ACK or NACK, no external URL and no script, and never the text of a message or a phone", async () => {
    const s = await storeWithMembers();
    const { orderId } = await fourStates(s);
    const h = harness({ engine });
    const cookie = await login(h, s, "staff");
    const body = await (await get(h, `/console/deed/${encodeURIComponent(orderId)}/libro`, cookie)).text();
    expect(body).not.toMatch(/ACK|NACK/);
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toContain("<script");
    expect(body).not.toContain(REPLY_TEXT);
    for (const phone of s.phones) expect(body).not.toContain(phone);
    // A member phone (5040 and eight digits) as a whole token: a UUID's last group, bounded by "-", never matches.
    expect(body).not.toMatch(/(?<![0-9a-zA-Z-])5040\d{8}(?![0-9a-zA-Z-])/);
  });

  it("is linked from the order's Deed page and from the Pedidos trail", async () => {
    const s = await storeWithMembers();
    const { orderId } = await fourStates(s);
    const h = harness({ engine });
    const cookie = await login(h, s, "staff");
    const deed = await (await get(h, `/console/deed/${encodeURIComponent(orderId)}`, cookie)).text();
    expect(deed).toContain(`href="/console/deed/${encodeURIComponent(orderId)}/libro"`);
    const trail = await (await get(h, `/console/pedidos/${encodeURIComponent(orderId)}`, cookie)).text();
    expect(trail).toContain(`href="/console/deed/${encodeURIComponent(orderId)}/libro"`);
  });
});

describe("/console/deed/:orderId/entrada.json: the entry a third party re-judges", () => {
  it("downloads the order's entry, whose verdicts the judge reproduces from the entry alone", async () => {
    const s = await storeWithMembers();
    const { orderId } = await fourStates(s);
    const h = harness({ engine });
    const cookie = await login(h, s, "staff");
    const response = await get(h, `/console/deed/${encodeURIComponent(orderId)}/entrada.json`, cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="entrada-/);
    const body = await response.text();
    const entry = JSON.parse(body);
    expect(entry.schema).toBe(1);
    expect(entry.input.orderId).toBe(orderId);
    expect(entry.verdicts.length).toBeGreaterThan(0);
    const result = recheckEntry(entry);
    expect(result).toEqual({ ok: true, pairs: entry.verdicts.length, same: entry.verdicts.length, differ: [] });
  });

  it("exports the entry the book holds: the route's entry is the read model's entry, and the screen shows its verdicts", async () => {
    const s = await storeWithMembers();
    const { orderId } = await fourStates(s);
    const h = harness({ engine });
    const cookie = await login(h, s, "staff");
    const book = await new D1LibroReads(env.DB).read({ businessId: s.businessId }, orderId);
    expect(book).not.toBeNull();
    const entry = JSON.parse(await (await get(h, `/console/deed/${encodeURIComponent(orderId)}/entrada.json`, cookie)).text()) as DeedEntry;
    expect(entry).toEqual(JSON.parse(JSON.stringify(entryOf(book!))));
    expect(entry.verdicts.map((verdict) => verdict.state)).toEqual(expect.arrayContaining(["emparejado", "sin_pareja", "en_duda", "bloqueado"]));
    const page = await (await get(h, `/console/deed/${encodeURIComponent(orderId)}/libro`, cookie)).text();
    const panels = [...page.matchAll(/<section id="d-(r\d+)" class="panel ([\w-]+)"/g)].map((match) => [match[1], match[2]]);
    expect(panels).toEqual(entry.verdicts.map((verdict) => [verdict.rowKey, verdict.state ?? "sin-par"]));
  });

  it("exports a fact that a cancellation closed as not live, and the entry still re-runs with no difference", async () => {
    const s = await storeWithMembers();
    const { orderId, confirmId } = await fourStates(s);
    await env.DB.prepare(
      `INSERT INTO fact_closures (business_id, fact_id, closed_by_fact_id, reason, closed_at_ms) VALUES (?, ?, 'cancel-fact-synthetic', 'cancelled', ?)`,
    )
      .bind(s.businessId, confirmId, T0 + 3_000)
      .run();
    const h = harness({ engine });
    const cookie = await login(h, s, "staff");
    const entry = JSON.parse(await (await get(h, `/console/deed/${encodeURIComponent(orderId)}/entrada.json`, cookie)).text()) as DeedEntry;
    expect(entry.input.facts.find((fact) => fact.id === confirmId)?.live).toBe(false);
    expect(recheckEntry(entry)).toMatchObject({ ok: true, differ: [] });
  });

  it("reads the recorded lines and total with literal values, and the judge re-runs the verdict from the entry alone", async () => {
    const s = await storeWithMembers();
    const { orderId } = await confirmedOrder(s);
    // Every line is left out of the total; then one line of version 1 is counted at L 10 for 2.5 units, so the total is L 25.
    await env.DB.prepare(`UPDATE order_lines SET excluded_from_total = 1 WHERE business_id = ? AND order_id = ?`).bind(s.businessId, orderId).run();
    await env.DB.prepare(
      `UPDATE order_lines SET excluded_from_total = 0, unit_price_centavos = 1000, qty_milli = 2500
       WHERE business_id = ?1 AND order_id = ?2 AND version = 1
         AND line_no = (SELECT MIN(line_no) FROM order_lines WHERE business_id = ?1 AND order_id = ?2 AND version = 1)`,
    )
      .bind(s.businessId, orderId)
      .run();
    await insertReply(s.businessId, [{ type: "order_total", orderId, version: 1, total: 2500 }], { providerStatus: "delivered" });
    const h = harness({ engine });
    const cookie = await login(h, s, "staff");
    const entry = JSON.parse(await (await get(h, `/console/deed/${encodeURIComponent(orderId)}/entrada.json`, cookie)).text()) as DeedEntry;
    expect(entry.input.lines.filter((line) => line.counted)).toEqual([{ version: 1, counted: true, unitPrice: 1000, quantity: "2.5" }]);
    expect(entry.verdicts.map((verdict) => verdict.state)).toContain("emparejado");
    expect(recheckEntry(entry)).toMatchObject({ ok: true, differ: [] });
    const page = await (await get(h, `/console/deed/${encodeURIComponent(orderId)}/libro`, cookie)).text();
    expect(page).toContain("Total L 25");
  });

  it("carries IDs, codes, numbers and claims only: no name, no phone, no message text, and no key the allow-list lacks", async () => {
    const s = await storeWithMembers();
    const { orderId } = await fourStates(s);
    // A customer's name and a member's name, saved in this store: neither may reach the entry.
    const named = await env.DB.prepare(`INSERT INTO customers (id, business_id, name, name_saved_at_ms, created_at_ms) VALUES (?1, ?2, ?3, ?4, ?4)`)
      .bind(crypto.randomUUID(), s.businessId, CUSTOMER_NAME, T0)
      .run();
    const members = await env.DB.prepare(`UPDATE memberships SET display_name = ?1 WHERE business_id = ?2`).bind(MEMBER_NAME, s.businessId).run();
    expect(named.meta.changes).toBeGreaterThan(0);
    expect(members.meta.changes).toBeGreaterThan(0);
    const h = harness({ engine });
    const cookie = await login(h, s, "staff");
    const body = await (await get(h, `/console/deed/${encodeURIComponent(orderId)}/entrada.json`, cookie)).text();
    expect(body).not.toContain(CUSTOMER_NAME);
    expect(body).not.toContain(MEMBER_NAME);
    expect(body).not.toContain(REPLY_TEXT);
    for (const phone of s.phones) expect(body).not.toContain(phone);
    expect(body).not.toMatch(/(?<![0-9a-zA-Z-])5040\d{8}(?![0-9a-zA-Z-])/);
    expectOnlyListedKeys(JSON.parse(body));
  });

  it("answers 404 for another store's order and for an unknown id", async () => {
    const mine = await storeWithMembers();
    const theirs = await storeWithMembers();
    const { orderId } = await fourStates(theirs);
    const h = harness({ engine });
    const cookie = await login(h, mine, "owner");
    expect((await get(h, `/console/deed/${encodeURIComponent(orderId)}/entrada.json`, cookie)).status).toBe(404);
    expect((await get(h, `/console/deed/${encodeURIComponent("no-such-order")}/entrada.json`, cookie)).status).toBe(404);
  });

  it("is linked as 'Descargar entrada' from the Libro screen", async () => {
    const s = await storeWithMembers();
    const { orderId } = await fourStates(s);
    const h = harness({ engine });
    const cookie = await login(h, s, "staff");
    const body = await (await get(h, `/console/deed/${encodeURIComponent(orderId)}/libro`, cookie)).text();
    expect(body).toContain(`href="/console/deed/${encodeURIComponent(orderId)}/entrada.json" download>Descargar entrada</a>`);
  });
});
