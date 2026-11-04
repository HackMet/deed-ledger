/**
 * DEED_ENGINE=1 end to end: Angel's real reader reads a customer's text burst (a recorded Muse Spark
 * answer, no network) and the order engine answers it. Each order step saves one fact.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "../src/application/ports";
import { introButtons, introduction } from "../src/domain/customer-controls";
import { deriveOrderState } from "../src/domain/order-state";
import { buildRuntime } from "../src/composition";
import { COPY, greetingLine, WHAT_TO_ORDER } from "../src/domain/replies";
import { D1OrderStore } from "../src/infrastructure/d1/order-store";
import { line, quote } from "./fixtures/model/recorded";
import { csrfOf, login, send } from "./helpers/console";
import { ensureLinesTable } from "./helpers/engines";
import { harness, rows, testEnv } from "./helpers/harness";
import { newPhone, seedIntroducedCustomer, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

const SETTLED_MS = 4_000;

/** The reader's answers, in the order the bursts ask for them. */
class RecordedProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  constructor(private readonly readings: unknown[]) {}
  async complete(_request: ModelRequest) {
    const json = this.readings.shift();
    if (json === undefined) throw new Error("no recorded reading left");
    return { ok: true, json, latencyMs: 5_000, inputTokens: 3_000, outputTokens: 500 } as const;
  }
}

/** "1 lb de arroz y 2 de azúcar", as the reader reads it: two lines, both quoted from the one message. */
const ORDER_READING = {
  observations: [
    {
      kind: "customer_order",
      lines: [
        line("1 lb de arroz", "arroz 1 lb", "1", "lb", quote(0, "1 lb de arroz")),
        line("2 de azucar", "azucar 1 lb", "2", null, quote(0, "2 de azucar")),
      ],
      issues: [],
    },
  ],
};

beforeAll(ensureLinesTable);

const withFulfillment = (mode: "pickup" | "delivery") => ({
  observations: [
    ...ORDER_READING.observations,
    { kind: "fulfillment", mode, place_text: mode === "delivery" ? "frente a la iglesia" : null, same_as_before: false, issues: [] },
  ],
});

async function setUp(readings: unknown[], options: { firstContact?: boolean; staff?: boolean } = {}) {
  const store = await seedStore({ members: options.staff === true ? [{ phone: newPhone(), role: "owner" }] : [] });
  const phone = newPhone();
  if (options.firstContact !== true) {
    const customerId = await seedIntroducedCustomer(store, phone);
    await env.DB.prepare(`UPDATE customers SET name = 'Ana', name_saved_at_ms = 1 WHERE id = ?`).bind(customerId).run();
  }
  for (const [id, name] of [
    ["arroz", "Arroz 1 lb"],
    ["azucar", "Azucar 1 lb"],
  ]) {
    await env.DB.prepare(`INSERT INTO products (id, business_id, canonical_name, created_at_ms) VALUES (?, ?, ?, 0)`)
      .bind(`${store.businessId}:${id}`, store.businessId, name)
      .run();
  }
  const h = harness({ env: testEnv({ DEED_ENGINE: "1" } as unknown as Partial<Env>), modelProvider: new RecordedProvider(readings) });
  const say = async (body: string) => {
    h.clock.advance(1_000);
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body })] }));
    h.clock.advance(SETTLED_MS);
    await h.deliver(h.takeRingsFor(store.businessId));
  };
  const factKinds = async () =>
    (await rows<{ kind: string }>(`SELECT kind FROM facts WHERE business_id = ? ORDER BY rowid`, store.businessId)).map((row) => row.kind);
  const sent = () => h.channel.sent.filter((message) => message.toPhone === phone);
  /** The engine's refusals on the Deed's record; claim checks are a separate source. */
  const refusals = async () =>
    (await rows<{ reason_code: string }>(`SELECT reason_code FROM deed_checks WHERE business_id = ? AND result = 'fail' AND source <> 'verify_claims'`, store.businessId)).map(
      (row) => row.reason_code,
    );
  return { h, store, phone, say, factKinds, sent, refusals };
}

/** A confirmed order on the real console: the staff member's taps go through the forms on its page. */
async function staffConsole(c: Awaited<ReturnType<typeof setUp>>) {
  const cookie = await login(c.h, c.store.businessId, c.store.members[0]!.userId);
  const order = async () =>
    (await rows<{ id: string; state: string; current_version: number }>(`SELECT id, state, current_version FROM orders WHERE business_id = ?`, c.store.businessId))[0]!;
  const { id } = await order();
  const page = async (path = `/console/preparacion/${id}`) => (await send(c.h, path, { cookie })).text();
  const fieldOf = (form: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(form)?.[1];
  /** The form on screen for this tap, with its fields, so the test taps what a person can tap. */
  const formFor = async (type: string, lineMark?: string) => {
    const forms = [...(await page()).matchAll(/<form[^>]*action="\/console\/acciones">([\s\S]*?)<\/form>/g)].map((match) => match[1]!);
    const form = forms.find((f) => f.includes(`name="type" value="${type}"`) && (lineMark === undefined || f.includes(`name="mark" value="${lineMark}"`)));
    if (form === undefined) throw new Error(`no ${type} form on screen`);
    const fields: Record<string, string> = {};
    for (const name of ["type", "orderId", "version", "operationKey", "csrf", "lineId", "mark"]) {
      const value = fieldOf(form, name);
      if (value !== undefined) fields[name] = value;
    }
    return fields;
  };
  const post = (form: Record<string, string>) => send(c.h, "/console/acciones", { method: "POST", cookie, form });
  const steps = async () =>
    rows<{ status: string | null; line: string | null; key: string }>(
      `SELECT json_extract(body_json, '$.status') AS status, json_extract(body_json, '$.line') AS line, operation_key AS key
       FROM facts WHERE business_id = ? AND kind = 'order_status' ORDER BY rowid`,
      c.store.businessId,
    );
  /** What the ledger derives must be what the cache says (R2). */
  const expectLedgerAgrees = async (state: string) => {
    const row = await order();
    expect(row.state).toBe(state);
    const facts = await new D1OrderStore(env.DB).orderFacts(c.store, id);
    expect(deriveOrderState(facts, row.current_version, row.state as never)).toBe(state);
  };
  return { id, cookie, page, order, formFor, post, steps, expectLedgerAgrees };
}

describe("DEED_ENGINE=1 through the real reader", () => {
  it("a customer's text burst is read back by the engine, confirmed once, and a repeated confirm saves nothing", async () => {
    const c = await setUp([ORDER_READING]);
    await c.say("1 lb de arroz y 2 de azucar");

    // The engine's readback reached the outbox, naming the products the store has.
    const reply = c.h.sentTo(c.phone).at(-1);
    expect(reply).toMatch(/Arroz 1 lb/);
    expect(reply).toMatch(/Azucar 1 lb/);
    expect(await c.factKinds()).toEqual(["order_version"]);

    await c.say("confirmar");
    expect(await c.factKinds()).toEqual(["order_version", "order_confirm"]);

    await c.say("confirmar");
    expect(await c.factKinds()).toEqual(["order_version", "order_confirm"]);
    // The repeat is answered from the first confirm's outcome (the duplicate check), not by the state
    // check, which would answer that the order is not waiting for confirmation.
    expect(c.h.sentTo(c.phone).at(-1)).toBe("¡A la orden! 🙌");
  });
});

describe("DEED_ENGINE=1: small talk says where the order stands", () => {
  it("a first hola gets the welcome with its buttons, with no model call and no refusal on record", async () => {
    const c = await setUp([], { firstContact: true });
    await c.say("Hola");
    const voice = { storeName: "Tienda de prueba", ownerName: null, privacyUrl: null };
    expect(c.sent()).toEqual([expect.objectContaining({ body: introduction(voice), buttons: introButtons(voice) })]);
    expect(await c.factKinds()).toEqual([]);
    expect(await c.refusals()).toEqual([]);
  });

  it("a later hola with no order greets and asks what to order", async () => {
    const c = await setUp([]);
    await c.say("hola");
    expect(c.h.sentTo(c.phone)).toEqual([`${greetingLine("Ana")}\n\n${WHAT_TO_ORDER}`]);
    expect(await c.refusals()).toEqual([]);
  });

  it("under a waiting readback, hola and gracias get the nudge with its buttons, and nothing is saved", async () => {
    const c = await setUp([ORDER_READING]);
    await c.say("1 lb de arroz y 2 de azucar");
    const decisions = c.sent().at(-1)!.buttons;
    expect(decisions).toHaveLength(3);

    await c.say("hola");
    expect(c.sent().at(-1)).toEqual(expect.objectContaining({ body: `${greetingLine("Ana")}\n\n${COPY.confirmNudge}`, buttons: decisions }));
    await c.say("gracias");
    expect(c.sent().at(-1)).toEqual(expect.objectContaining({ body: COPY.confirmNudge, buttons: decisions }));

    expect(await c.factKinds()).toEqual(["order_version"]);
    expect(await c.refusals()).toEqual([]);
    // The readback still waits: the typed word confirms it.
    await c.say("confirmar");
    expect(await c.factKinds()).toEqual(["order_version", "order_confirm"]);
  });

  it("after confirming, hola says the order's status and gracias the house answer", async () => {
    const c = await setUp([ORDER_READING]);
    await c.say("1 lb de arroz y 2 de azucar");
    await c.say("confirmar");
    await c.say("hola");
    expect(c.h.sentTo(c.phone).at(-1)).toBe(`${greetingLine("Ana")}\n\nVas primero en la fila. Te aviso apenas esté listo.`);
    await c.say("gracias");
    expect(c.h.sentTo(c.phone).at(-1)).toBe(COPY.welcome);
    expect(await c.refusals()).toEqual([]);
  });

  it("a reading of only console kinds is still refused, and on record", async () => {
    const c = await setUp([]);
    const customer = (await rows<{ id: string }>(`SELECT id FROM customers WHERE business_id = ?`, c.store.businessId))[0]!;
    const refused = await buildRuntime(c.h.env).engine!.onBurst(
      { businessId: c.store.businessId, conversationId: "c", customerId: customer.id, jobId: crypto.randomUUID(), nowMs: c.h.clock.now() },
      { observations: [{ kind: "sale_report", lines: [], issues: [] }], calls: [] },
      [],
    );
    expect(refused.outcome).toEqual({ type: "rejected", reason: "not_allowed", order: null });
    expect(await c.refusals()).toEqual(["not_allowed"]);
  });
});

describe("DEED_ENGINE=1: packing from the Preparación page", () => {
  const confirmed = async (mode: "pickup" | "delivery") => {
    const c = await setUp([withFulfillment(mode)], { staff: true });
    await c.say("1 lb de arroz y 2 de azucar");
    await c.say("confirmar");
    return { c, staff: await staffConsole(c) };
  };

  it("Listo from confirmado saves one ready fact and one notice; a repeat saves nothing and a stale Empezar is refused", async () => {
    const { c, staff } = await confirmed("pickup");
    await staff.expectLedgerAgrees("confirmado");
    const listo = await staff.formFor("mark_ready");
    const empezar = await staff.formFor("start_preparing");
    const heard = c.sent().length;

    expect((await staff.post(listo)).headers.get("location")).toBe(`/console/preparacion#${staff.id}`);
    await staff.expectLedgerAgrees("listo");
    expect((await staff.steps()).map((step) => step.status)).toEqual(["ready"]);
    expect(c.h.sentTo(c.phone).slice(heard)).toEqual([expect.stringMatching(/listo/i)]);

    await staff.post(listo);
    expect((await staff.steps()).map((step) => step.status)).toEqual(["ready"]);
    expect(c.sent()).toHaveLength(heard + 1);

    expect((await staff.post(empezar)).headers.get("location")).toMatch(/aviso=/);
    await staff.expectLedgerAgrees("listo");
    expect((await staff.steps()).map((step) => step.status)).toEqual(["ready"]);
    expect(await c.refusals()).toContain("invalid_state");
    expect(await staff.page()).toContain('<button class="primary">Entregado</button>');
  });

  it("a line ticked from confirmado starts the packing: its step and its mark, once, and the ledger agrees", async () => {
    const { staff } = await confirmed("pickup");
    const tick = await staff.formFor("mark_line", "listo");
    const listoOnScreen = await staff.formFor("mark_ready");

    await staff.post(tick);
    await staff.expectLedgerAgrees("preparando");
    const started = [
      { status: "preparing", line: null, key: `staff:${staff.id}:1:start_preparing` },
      { status: null, line: tick.lineId!, key: tick.operationKey! },
    ];
    expect(await staff.steps()).toEqual(started);

    await staff.post(tick);
    expect(await staff.steps()).toEqual(started);

    // Empezar is gone from the page, and the tap a stale screen still holds is refused.
    await expect(staff.formFor("start_preparing")).rejects.toThrow();
    const stale = { ...listoOnScreen, type: "start_preparing", operationKey: started[0]!.key };
    expect((await staff.post(stale)).headers.get("location")).toMatch(/aviso=/);
    expect(await staff.steps()).toEqual(started);

    await staff.post(await staff.formFor("mark_ready"));
    await staff.expectLedgerAgrees("listo");
  });

  it("Empezar then Listo still works, and a tap on an old version is refused", async () => {
    const { c, staff } = await confirmed("pickup");
    const stale = { ...(await staff.formFor("mark_ready")), version: "9", operationKey: `staff:${staff.id}:9:mark_ready` };
    expect((await staff.post(stale)).headers.get("location")).toBe(`/console/preparacion/${staff.id}?aviso=cambio`);
    await staff.expectLedgerAgrees("confirmado");
    expect(await c.refusals()).toEqual(["stale_version"]);
    expect(await staff.steps()).toEqual([]);

    await staff.post(await staff.formFor("start_preparing"));
    await staff.expectLedgerAgrees("preparando");
    await staff.post(await staff.formFor("mark_ready"));
    await staff.expectLedgerAgrees("listo");
    expect((await staff.steps()).map((step) => step.status)).toEqual(["preparing", "ready"]);
  });

  it("a delivery order goes from Listo to Despachar instead of Entregado, then out the door", async () => {
    const { c, staff } = await confirmed("delivery");
    await staff.post(await staff.formFor("mark_ready"));
    await staff.expectLedgerAgrees("listo");

    const ready = await staff.page();
    expect(ready).not.toContain("Entregado");
    const href = /<a class="button primary" href="([^"]+)">Despachar<\/a>/.exec(ready)?.[1];
    expect(href).toBe(`/console/pedidos/${staff.id}`);

    const pedidos = await staff.page(href);
    const path = `/console/pedidos/${staff.id}/paso`;
    const repartidor = /<option value="([^"]+)">/.exec(pedidos)![1]!;
    const csrf = csrfOf(pedidos)!;
    await send(c.h, path, { method: "POST", cookie: staff.cookie, form: { csrf, paso: "despachar", version: "1", repartidor } });
    await staff.expectLedgerAgrees("en_camino");
    expect(c.h.sentTo(c.phone).at(-1)).toMatch(/en camino/i);

    await send(c.h, path, { method: "POST", cookie: staff.cookie, form: { csrf, paso: "entregar", version: "1" } });
    await staff.expectLedgerAgrees("entregado");
    expect((await staff.steps()).map((step) => step.status)).toEqual(["ready", "dispatched", "delivered"]);
  });
});
