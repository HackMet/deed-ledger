import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Claim } from "../src/domain/contract/outcomes";
import { INVITE_TTL_MS } from "../src/domain/console-auth";
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
