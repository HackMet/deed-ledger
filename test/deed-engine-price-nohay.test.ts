/**
 * Prices and No hay on DEED_ENGINE=1, the deployed composition: signed webhooks, the real reader's
 * wire format, real D1 and the real console route. No pretend engine anywhere in this file.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { MemberContext } from "../src/application/engine";
import { staffKey } from "../src/application/engine/order-engine";
import type { ModelProvider, ModelRequest, Tenant } from "../src/application/ports";
import type { LineMark } from "../src/domain/contract/actions";
import type { Claim, OrderView } from "../src/domain/contract/outcomes";
import { reviewKey } from "../src/domain/change-request";
import { libroRows } from "../src/domain/deed-libro";
import { priceKey } from "../src/domain/price";
import { D1LibroReads } from "../src/infrastructure/d1/libro-reads";
import { edit, line, quote } from "./fixtures/model/recorded";
import { csrfFor, login, send, storeWithStaff } from "./helpers/console";
import { ensureLinesTable } from "./helpers/engines";
import { harness, rows, testEnv } from "./helpers/harness";
import { engine, save, store as orderStore } from "./helpers/orders";
import { newPhone, seedIntroducedCustomer } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

const SETTLED_MS = 4_000;
const SAFE_REPLY = "Dejame revisar bien y ya te confirmo.";

class RecordedProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  constructor(private readonly readings: unknown[]) {}
  async complete(_request: ModelRequest) {
    const json = this.readings.shift();
    if (json === undefined) throw new Error("no recorded reading left");
    return { ok: true, json, latencyMs: 5_000, inputTokens: 3_000, outputTokens: 500 } as const;
  }
}

const SAID = "3 de arroz y 2 de azucar, lo paso a traer";
const ORDER = (more: Record<string, unknown> = {}) => ({
  observations: [
    {
      kind: "customer_order",
      lines: [line("3 de arroz", "arroz 1 lb", "3", null, quote(0, "3 de arroz"), more), line("2 de azucar", "azucar 1 lb", "2", null, quote(0, "2 de azucar"))],
      issues: [],
    },
    { kind: "fulfillment", mode: "pickup", place_text: null, same_as_before: false, issues: [] },
  ],
});

beforeAll(ensureLinesTable);

async function setUp(readings: unknown[]) {
  const store = await storeWithStaff();
  const phone = newPhone();
  const customerId = await seedIntroducedCustomer(store, phone);
  await env.DB.prepare(`UPDATE customers SET name = 'Ana', name_saved_at_ms = 1 WHERE id = ?`).bind(customerId).run();
  const arroz = `${store.businessId}:arroz`;
  const azucar = `${store.businessId}:azucar`;
  for (const [id, name] of [
    [arroz, "Arroz 1 lb"],
    [azucar, "Azucar 1 lb"],
  ]) {
    await env.DB.prepare(`INSERT INTO products (id, business_id, canonical_name, created_at_ms) VALUES (?, ?, ?, 0)`).bind(id, store.businessId, name).run();
  }
  const h = harness({ env: testEnv({ DEED_ENGINE: "1" } as unknown as Partial<Env>), modelProvider: new RecordedProvider(readings) });
  const owner = store.members[0]!.userId;
  const staff = store.members[1]!.userId;
  const tenant: Tenant = { businessId: store.businessId };

  /** The owner saying what a product costs, by the same action the console sends. */
  const setPrice = async (productId: string, price: number, type: "confirm_price" | "propose_price" = "confirm_price") => {
    // A price key holds the minute: a second price needs a later one.
    h.clock.advance(60_000);
    const member: MemberContext = { businessId: store.businessId, memberId: owner, role: "owner", canApproveFiado: false, nowMs: h.clock.now() };
    await save(
      await engine.onConsoleAction(member, {
        operationKey: priceKey(productId, member.nowMs, type),
        actor: { type: "member", memberId: owner, role: "owner" },
        action: { type, productId, price },
      }),
    );
  };

  const say = async (body: string) => {
    h.clock.advance(1_000);
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body })] }));
    h.clock.advance(SETTLED_MS);
    await h.deliver(h.takeRingsFor(store.businessId));
  };
  const order = async (): Promise<OrderView> => (await orderStore.openOrder(tenant, customerId))!.view;

  const cookie = await login(h, store.businessId, staff);
  const csrf = await csrfFor(h, cookie);
  /** A tap on Preparación, through the console's form. Delivers what the tap queued unless told to wait. */
  const tap = async (
    fields: { type: "start_preparing" | "mark_ready" } | { type: "mark_line"; lineId: string; mark: LineMark },
    { deliver = true }: { deliver?: boolean } = {},
  ) => {
    const { orderId, version } = await order();
    const action =
      fields.type === "mark_line"
        ? { type: fields.type, orderId, version, lineId: fields.lineId, mark: fields.mark, substituteProductId: null }
        : { type: fields.type, orderId, version };
    const form: Record<string, string> = { csrf, type: fields.type, orderId, version: String(version), operationKey: staffKey(action) };
    if (fields.type === "mark_line") Object.assign(form, { lineId: fields.lineId, mark: fields.mark });
    h.clock.advance(1_000);
    const response = await send(h, "/console/acciones", { method: "POST", cookie, form });
    expect(response.status).toBe(303);
    if (deliver) await h.deliver(h.takeRingsFor(store.businessId));
  };
  const open = async (path: string) => (await send(h, path, { cookie })).text();
  const pendientes = async (kind: string) => (await rows(`SELECT 1 FROM conversation_pendientes WHERE business_id = ? AND kind = ?`, store.businessId, kind)).length;
  return { h, store, tenant, phone, arroz, azucar, setPrice, say, order, tap, open, pendientes };
}

describe("DEED_ENGINE=1: a confirmed price reaches the order", () => {
  it("prices the lines in integer centavos, totals them, and the total claim passes both checks on confirm", async () => {
    const c = await setUp([ORDER()]);
    await c.setPrice(c.arroz, 1800);
    await c.setPrice(c.azucar, 2050);
    await c.say(SAID);

    const readback = c.h.sentTo(c.phone).at(-1)!;
    expect(readback).toContain("3 Arroz 1 lb · L 54");
    expect(readback).toContain("2 Azucar 1 lb · L 41");
    expect(readback).toContain("Total: L 95");
    expect(readback).not.toContain("te confirmo");
    expect(await rows(`SELECT unit_price_centavos AS price FROM order_lines WHERE business_id = ? ORDER BY line_no`, c.store.businessId)).toEqual([{ price: 1800 }, { price: 2050 }]);
    const { orderId, total } = await c.order();
    expect(total).toBe(9500);

    await c.say("confirmar");
    expect(c.h.sentTo(c.phone).at(-1)).toContain("Total: L 95");
    expect(c.h.sentTo(c.phone)).not.toContain(SAFE_REPLY);
    expect(c.h.log.events()).not.toContain("reply_claim_blocked");
    const claim = (t: number): Claim => ({ type: "order_total", orderId, version: 1, total: t });
    expect(await engine.verifyClaims(c.tenant, [claim(9500), claim(9400)])).toEqual([true, false]);
    // Nothing is left to confirm by hand, so no one is asked to.
    expect(await c.pendientes("customer_question")).toBe(0);
  });

  it("keeps an unconfirmed price unknown, never zero, and then no total", async () => {
    const c = await setUp([ORDER()]);
    await c.setPrice(c.arroz, 1800);
    await c.setPrice(c.azucar, 2050, "propose_price");
    await c.say(SAID);

    const readback = c.h.sentTo(c.phone).at(-1)!;
    expect(readback).toContain("3 Arroz 1 lb · L 54");
    expect(readback).not.toMatch(/Azucar 1 lb · L/u);
    expect(readback).toContain("El total te lo confirmo");
    expect(await rows(`SELECT unit_price_centavos AS price FROM order_lines WHERE business_id = ? ORDER BY line_no`, c.store.businessId)).toEqual([{ price: 1800 }, { price: null }]);
    expect((await c.order()).total).toBeNull();
  });

  it("reads the live price, and never quotes a restricted line", async () => {
    const c = await setUp([ORDER({ restricted: true })]);
    await c.setPrice(c.arroz, 1800);
    await c.setPrice(c.azucar, 2000);
    await c.setPrice(c.azucar, 2100);
    await c.say(SAID);
    const { lines, total } = await c.order();
    expect(lines.map((l) => l.unitPrice)).toEqual([null, 2100]);
    // The restricted line is left out, so the other one is the whole total.
    expect(total).toBe(4200);
  });

  it("states no total while a short line is still a question", async () => {
    const c = await setUp([ORDER()]);
    await c.setPrice(c.arroz, 1800);
    await c.setPrice(c.azucar, 2000);
    await env.DB.prepare(`INSERT INTO stock_balances (business_id, product_id, qty_milli, updated_at_ms) VALUES (?, ?, 1000, 0)`).bind(c.store.businessId, c.azucar).run();
    await c.say(SAID);
    const readback = c.h.sentTo(c.phone).at(-1)!;
    expect(readback).toContain("me aparecen 1");
    expect(readback).toContain("El total te lo confirmo");
    expect((await c.order()).total).toBeNull();
  });
});

describe("DEED_ENGINE=1: No hay on a matched line", () => {
  /** A confirmed, priced pickup order being packed. */
  async function packing() {
    const c = await setUp([ORDER()]);
    await c.setPrice(c.arroz, 1800);
    await c.setPrice(c.azucar, 2000);
    await c.say(SAID);
    await c.say("confirmar");
    await c.tap({ type: "start_preparing" });
    return c;
  }

  it("tells the customer the notice once, drops the line from the total and keeps the mark", async () => {
    const c = await packing();
    const before = c.h.sentTo(c.phone).length;
    await c.tap({ type: "mark_line", lineId: "L2", mark: "no_hay" });

    const notice = "Perdón, ahorita no hay Azucar 1 lb 😔 Tu pedido queda en L 54. Si querés otra cosa en su lugar, decime.";
    expect(c.h.sentTo(c.phone).slice(before)).toEqual([notice]);
    expect(c.h.log.events()).not.toContain("reply_claim_blocked");
    expect(await c.pendientes("claim_blocked")).toBe(0);

    const order = await c.order();
    expect(order.lines[1]).toMatchObject({ mark: "no_hay", availability: "se_acabo" });
    expect(order.total).toBe(5400);
    // The version keeps what was confirmed: the fact and the row are not rewritten.
    expect(await rows(`SELECT total_centavos AS total FROM order_versions WHERE order_id = ?`, order.orderId)).toEqual([{ total: 9400 }]);

    // A double tap saves once and says nothing more.
    await c.tap({ type: "mark_line", lineId: "L2", mark: "no_hay" });
    expect(c.h.sentTo(c.phone).slice(before)).toEqual([notice]);
    expect(await rows(`SELECT 1 FROM facts WHERE business_id = ? AND json_extract(body_json, '$.mark') = 'no_hay'`, c.store.businessId)).toHaveLength(1);

    // The packer sees it, and the ready message leaves it out.
    const page = await c.open(`/console/preparacion/${encodeURIComponent(order.orderId)}`);
    expect(page).toContain("No hay</span>");
    await c.tap({ type: "mark_ready" });
    expect(c.h.sentTo(c.phone).at(-1)).toContain("Total: L 54, sin Azucar 1 lb.");
    expect(c.h.sentTo(c.phone)).not.toContain(SAFE_REPLY);
  });

  it("shows the tick of a Listo mark, which leaves the total alone", async () => {
    const c = await packing();
    const before = c.h.sentTo(c.phone).length;
    await c.tap({ type: "mark_line", lineId: "L1", mark: "listo" });
    expect(c.h.sentTo(c.phone)).toHaveLength(before);
    const order = await c.order();
    expect(order.lines[0]?.mark).toBe("listo");
    expect(order.total).toBe(9400);
    expect(await c.open(`/console/preparacion/${encodeURIComponent(order.orderId)}`)).toContain('aria-label="Ya está"');
  });

  it("gives a line with no price the notice too, with no total in it", async () => {
    const c = await setUp([ORDER()]);
    await c.setPrice(c.arroz, 1800);
    await c.say(SAID);
    await c.say("confirmar");
    await c.tap({ type: "start_preparing" });
    await c.tap({ type: "mark_line", lineId: "L1", mark: "no_hay" });
    expect(c.h.sentTo(c.phone).at(-1)).toBe("Perdón, ahorita no hay Arroz 1 lb 😔 Si querés otra cosa en su lugar, decime.");
    expect((await c.order()).total).toBeNull();
  });

  it("backs se_acabo only from a live mark of this store's open order", async () => {
    const c = await packing();
    const other = await setUp([]);
    const claim: Claim = { type: "availability", productId: c.azucar, availability: "se_acabo" };
    expect(await engine.verifyClaims(c.tenant, [claim])).toEqual([false]);

    await c.tap({ type: "mark_line", lineId: "L2", mark: "no_hay" });
    expect(await engine.verifyClaims(c.tenant, [claim, { ...claim, productId: c.arroz }, { ...claim, availability: "hay" }])).toEqual([true, false, false]);
    expect(await engine.verifyClaims(other.tenant, [claim])).toEqual([false]);

    await c.tap({ type: "mark_ready" });
    const { orderId, version } = await c.order();
    expect(await engine.verifyClaims(c.tenant, [claim])).toEqual([true]);
    await env.DB.prepare(`UPDATE orders SET state = 'entregado' WHERE id = ? AND current_version = ?`).bind(orderId, version).run();
    expect(await engine.verifyClaims(c.tenant, [claim])).toEqual([false]);
  });

  it("keeps the total the claim was checked against in step with what the customer heard", async () => {
    const c = await packing();
    const { orderId } = await c.order();
    await c.tap({ type: "mark_line", lineId: "L2", mark: "no_hay" });
    const total = (t: number): Claim => ({ type: "order_total", orderId, version: 1, total: t });
    expect(await engine.verifyClaims(c.tenant, [total(5400), total(9400)])).toEqual([true, false]);
  });

  it("pairs in the Deed's book both the total said before the tap and the one said after", async () => {
    const c = await packing();
    const { orderId } = await c.order();
    await c.tap({ type: "mark_line", lineId: "L2", mark: "no_hay" });
    const input = await new D1LibroReads(env.DB).read(c.tenant, orderId);
    const said = libroRows(input!).filter((row) => row.agent?.kind === "claim" && row.agent.text.startsWith("Dijo: total"));
    expect(said.map((row) => row.agent!.text)).toEqual(expect.arrayContaining(["Dijo: total L 94", "Dijo: total L 54"]));
    expect(said.map((row) => row.state)).toEqual(said.map(() => "emparejado"));
  });

  it("keeps a No hay line out of the total of the version an approved change makes", async () => {
    const c = await setUp([
      ORDER(),
      { observations: [{ kind: "order_change", edits: [edit("add", { text: "1 de arroz", name: "arroz 1 lb", quantity: "1", evidence: quote(0, "1 de arroz") })], issues: [] }] },
    ]);
    await c.setPrice(c.arroz, 1800);
    await c.setPrice(c.azucar, 2000);
    await c.say(SAID);
    await c.say("confirmar");
    await c.tap({ type: "start_preparing" });
    await c.tap({ type: "mark_line", lineId: "L2", mark: "no_hay" });
    await c.say("y 1 de arroz");

    const requestId = (await c.order()).openChangeRequest!.id;
    const owner = c.store.members[0]!.userId;
    c.h.clock.advance(1_000);
    await save(
      await engine.onConsoleAction(
        { businessId: c.store.businessId, memberId: owner, role: "owner", canApproveFiado: false, nowMs: c.h.clock.now() },
        { operationKey: reviewKey(requestId), actor: { type: "member", memberId: owner, role: "owner" }, action: { type: "review_change", changeRequestId: requestId, decision: "approve", reason: "Va" } },
      ),
    );
    const v2 = await c.order();
    expect(v2).toMatchObject({ version: 2, state: "preparando", total: 7200 });
    expect(v2.lines.map((l) => [l.lineId, l.availability, l.mark])).toEqual([
      ["L1", "no_se", null],
      ["L2", "se_acabo", null],
      ["L3", "no_se", null],
    ]);
  });

  it("still says the notice when Listo follows before the notice went out", async () => {
    const c = await packing();
    const before = c.h.sentTo(c.phone).length;
    await c.tap({ type: "mark_line", lineId: "L2", mark: "no_hay" }, { deliver: false });
    await c.tap({ type: "mark_ready" }, { deliver: false });
    await c.h.deliver(c.h.takeRingsFor(c.store.businessId));
    const sent = c.h.sentTo(c.phone).slice(before);
    expect(sent.filter((body) => body.startsWith("Perdón, ahorita no hay Azucar 1 lb"))).toHaveLength(1);
    expect(sent).not.toContain(SAFE_REPLY);
  });
});
