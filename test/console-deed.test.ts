import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MemberContext } from "../src/application/engine";
import { OrderEngine, staffKey } from "../src/application/engine/order-engine";
import type { ActionEnvelope, ConsoleAction, CustomerAction } from "../src/domain/contract/actions";
import { INVITE_TTL_MS } from "../src/domain/console-auth";
import { D1DeedChecks } from "../src/infrastructure/d1/deed-checks";
import { D1FactLedger } from "../src/infrastructure/d1/fact-ledger";
import { hashToken, newToken } from "../src/infrastructure/tokens";
import { firstOrder, ids } from "./fixtures/contract";
import { type Harness, harness } from "./helpers/harness";
import { T0, newStore, placeFirstOrder, save, store, tap } from "./helpers/orders";
import { newPhone, seedStore } from "./helpers/seed";

type Store = Awaited<ReturnType<typeof newStore>>;

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/** The engine that records the Deed's checks, as the demo's worker builds it. */
const checkedEngine = new OrderEngine({
  store,
  ids: { newId: () => crypto.randomUUID() },
  ledger: new D1FactLedger(env.DB),
  checks: new D1DeedChecks(env.DB),
  clock: { now: () => T0 },
});

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
async function storeWithMembers(): Promise<Store> {
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
  return s;
}

const cancelTap = (orderId: string, version: number): ActionEnvelope<CustomerAction> => ({
  ...tap(orderId, version),
  operationKey: `cancel:${orderId}:v${version}`,
  action: { type: "cancel_order", orderId, version },
});

/**
 * Order E's shape (demo/run.mjs): placed, confirmed, a change asked for on the confirmed order, then
 * cancelled. The cancel closes the confirm, so the change request rests on a closed fact.
 */
async function cancelledWithChange(s: Store): Promise<{ orderId: string; confirmId: string; changeId: string }> {
  const v1 = await placeFirstOrder(s, ids.customer, T0, firstOrder);
  const context = s.context({ nowMs: T0 + 1_000 });
  await save(await checkedEngine.onCustomerAction(context, tap(v1.orderId, 1)));
  const line = v1.lines[0]!.lineId;
  const removal: ActionEnvelope<CustomerAction> = {
    operationKey: `remove:${v1.orderId}:v1:${line}`,
    actor: { type: "customer", customerId: ids.customer },
    action: { type: "remove_line", orderId: v1.orderId, version: 1, lineId: line },
  };
  await save(await checkedEngine.onCustomerAction(s.context({ nowMs: T0 + 2_000 }), removal));
  await save(await checkedEngine.onCustomerAction(s.context({ nowMs: T0 + 3_000 }), cancelTap(v1.orderId, 1)));
  const rows = await env.DB.prepare(
    `SELECT kind, id FROM facts WHERE business_id = ? AND kind IN ('order_confirm', 'change_request') ORDER BY kind`,
  )
    .bind(s.businessId)
    .all<{ kind: string; id: string }>();
  const confirmId = rows.results.find((row) => row.kind === "order_confirm")!.id;
  const changeId = rows.results.find((row) => row.kind === "change_request")!.id;
  return { orderId: v1.orderId, confirmId, changeId };
}

/** A staff tap on an order's version, as the console sends it. */
const staffTap = (member: MemberContext, type: "mark_ready" | "mark_delivered", orderId: string, version: number) => {
  const action = { type, orderId, version } as const;
  const envelope: ActionEnvelope<ConsoleAction> = {
    operationKey: staffKey(action),
    actor: { type: "member", memberId: member.memberId, role: member.role },
    action,
  };
  return checkedEngine.onConsoleAction(member, envelope);
};

describe("/console/deed/:orderId: the order's facts as a graph", () => {
  it("draws the cancelled confirm red and what rests on it grey, each fact a link to its panel", async () => {
    const s = await storeWithMembers();
    const { orderId, confirmId, changeId } = await cancelledWithChange(s);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const response = await get(h, `/console/deed/${encodeURIComponent(orderId)}`, cookie);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(`class="node closed"`);
    expect(body).toContain(`class="node blocked"`);
    expect(body).toContain(`href="#f-${confirmId}"`);
    expect(body).toContain(`id="f-${changeId}"`);
    expect(body).toContain(`Bloqueado por`);
    expect(body).toContain(`?foco=${changeId}`);
    // No refresh on the order page: a reload would close the open panel and drop the `?foco=` path.
    expect(body).not.toContain(`http-equiv="refresh"`);
    expect(body).not.toContain("<script");
  });

  it("replays the order as it stood at ?t=, and draws the refused tap beside the cancel that decided it", async () => {
    const s = await storeWithMembers();
    const { orderId } = await cancelledWithChange(s);
    const member: MemberContext = { businessId: s.businessId, memberId: ids.staff, role: "staff", canApproveFiado: false, nowMs: T0 + 4_000 };
    await staffTap(member, "mark_ready", orderId, 1);
    const cancel = await env.DB.prepare(`SELECT id FROM facts WHERE business_id = ? AND kind = 'order_cancel'`).bind(s.businessId).first<{ id: string }>();
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const path = `/console/deed/${encodeURIComponent(orderId)}`;

    // Before the cancel: the confirm is still live, and nothing was refused yet.
    const before = await (await get(h, `${path}?t=${T0 + 2_500}`, cookie)).text();
    expect(before).toContain(`class="node live"`);
    expect(before).not.toContain(`class="node closed"`);
    expect(before).not.toContain("Intento rechazado");
    expect(before).toContain(`name="t"`);

    // After the refusal: the confirm is closed, the refused tap is drawn and linked to the cancel.
    const after = await (await get(h, `${path}?t=${T0 + 5_000}`, cookie)).text();
    expect(after).toContain(`class="node closed"`);
    expect(after).toContain("Intento rechazado");
    expect(after).toContain(`href="#f-${cancel!.id}"`);

    // The live view has no range to replay from, and it does not refresh (that would close an open panel).
    const live = await (await get(h, path, cookie)).text();
    expect(live).toContain(`class="node closed"`);
    expect(live).not.toContain(`http-equiv="refresh"`);
  });

  it("never draws another store's refusals on this order's graph", async () => {
    const s = await storeWithMembers();
    const other = await newStore();
    const { orderId } = await cancelledWithChange(s);
    await env.DB.prepare(
      `INSERT INTO deed_checks (business_id, id, at_ms, source, order_id, result, reason_code, operation_key)
       VALUES (?, ?, ?, 'stale_version', ?, 'fail', 'stale_version', 'staff:foreign:1:mark_ready')`,
    )
      .bind(other.businessId, crypto.randomUUID(), T0 + 4_000, orderId)
      .run();
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const body = await (await get(h, `/console/deed/${encodeURIComponent(orderId)}`, cookie)).text();
    expect(body).not.toContain("Intento rechazado");
    expect(body).not.toContain("foreign");
  });

  it("answers 404 for another store's order, and lets an owner and staff open this one", async () => {
    const mine = await storeWithMembers();
    const theirs = await newStore();
    const { orderId } = await cancelledWithChange(mine);
    const foreign = await placeFirstOrder(theirs, ids.customer, T0, firstOrder);
    const h = harness({ engine: checkedEngine });
    const staffCookie = await login(h, mine, "staff");
    const ownerCookie = await login(h, mine, "owner");
    expect((await get(h, `/console/deed/${encodeURIComponent(foreign.orderId)}`, staffCookie)).status).toBe(404);
    expect((await get(h, `/console/deed/${encodeURIComponent(orderId)}`, staffCookie)).status).toBe(200);
    expect((await get(h, `/console/deed/${encodeURIComponent(orderId)}`, ownerCookie)).status).toBe(200);
  });

  it("is linked from the Pedidos trail and from Más", async () => {
    const s = await storeWithMembers();
    const { orderId } = await cancelledWithChange(s);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const trail = await (await get(h, `/console/pedidos/${encodeURIComponent(orderId)}`, cookie)).text();
    expect(trail).toContain(`href="/console/deed/${encodeURIComponent(orderId)}"`);
    const more = await (await get(h, "/console/mas", cookie)).text();
    expect(more).toContain(`href="/console/deed/verificaciones"`);
  });
});

describe("/console/deed/verificaciones: every check, newest first, for the store only", () => {
  it("shows the refused mark_ready as a ✗ with its reason, and counts one refusal", async () => {
    const s = await storeWithMembers();
    const { orderId } = await cancelledWithChange(s);
    const member: MemberContext = { businessId: s.businessId, memberId: ids.staff, role: "staff", canApproveFiado: false, nowMs: T0 + 4_000 };
    const refused = await staffTap(member, "mark_ready", orderId, 1);
    expect(refused.outcome).toMatchObject({ type: "rejected", reason: "invalid_state" });

    const other = await newStore();
    const foreign = await placeFirstOrder(other, ids.customer, T0, firstOrder);
    await staffTap({ ...member, businessId: other.businessId }, "mark_ready", foreign.orderId, 1);

    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const body = await (await get(h, "/console/deed/verificaciones", cookie)).text();
    expect(body).toContain('id="contadores">Intentos rechazados 1<');
    expect(body).toContain('id="afirmaciones">Afirmaciones verificadas 0, pasaron 0<');
    expect(body).toContain("✗");
    expect(body).toContain("Intentó marcar listo");
    expect(body).toContain("ancestro cancelado");
    expect(body).not.toContain(foreign.orderId);
    expect(body).toContain(`href="/console/deed/${encodeURIComponent(orderId)}"`);
  });

  it("lists each refusal reason in Spanish, never the raw code", async () => {
    const s = await storeWithMembers();
    const { orderId } = await cancelledWithChange(s);
    const member: MemberContext = { businessId: s.businessId, memberId: ids.staff, role: "staff", canApproveFiado: false, nowMs: T0 + 4_000 };
    await staffTap(member, "mark_ready", orderId, 1);
    await staffTap(member, "mark_delivered", orderId, 1);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const body = await (await get(h, "/console/deed/verificaciones", cookie)).text();
    expect(body).toContain('<li>el estado no lo permite: 2</li>');
    expect(body).not.toContain("invalid_state");
  });

  it("refreshes the feed, and only the feed, to its own path", async () => {
    const s = await storeWithMembers();
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const feed = await (await get(h, "/console/deed/verificaciones", cookie)).text();
    expect(feed).toContain(`<meta http-equiv="refresh" content="3;url=/console/deed/verificaciones">`);
  });
});
