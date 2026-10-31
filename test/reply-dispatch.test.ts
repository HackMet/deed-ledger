import { describe, expect, it } from "vitest";
import type { CustomerContext } from "../src/application/engine";
import { dispatchOutbox } from "../src/application/dispatch";
import type { ClaimVerifier, JobHandler, Tenant } from "../src/application/ports";
import { replyForOutcome } from "../src/application/replies";
import type { EngineOutcome, OrderView } from "../src/domain/contract/outcomes";
import { actionFromButtonId, COPY, decisionKey, renderOutcome, typedDecision } from "../src/domain/replies";
import { MemoryEngine, type StoredOrder } from "../src/infrastructure/memory/memory-engine";
import { type Harness, harness, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";
import { confirmedOrder, readbackOrder } from "./fixtures/contract";

const CUSTOMER = "customer-test";
const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

function engineWith(...orders: OrderView[]): MemoryEngine {
  return new MemoryEngine(() =>
    orders.map((order): StoredOrder => ({ customerId: CUSTOMER, customerName: null, confirmedAtMs: 0, changedLineIds: [], order })),
  );
}

/** Answers the burst's newest message with the reply for one fixed outcome, as the handler will. */
function replying(h: () => Harness, outcome: () => EngineOutcome): JobHandler {
  return {
    async handle({ lease, isNewestOfBurst }) {
      if (!isNewestOfBurst) return { replies: [] };
      const context = { businessId: lease.businessId, conversationId: lease.conversationId, customerId: CUSTOMER };
      return { replies: await replyForOutcome(h().deps, context, outcome()) };
    },
  };
}

async function setup(options: { engine?: MemoryEngine; outcome: () => EngineOutcome; verifier?: "none" }) {
  let ref: Harness | undefined;
  const h = harness({
    jobHandler: replying(() => ref!, options.outcome),
    ...(options.engine === undefined || options.verifier === "none" ? {} : { engine: options.engine }),
  });
  ref = h;
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  return { h, phone, store, tenant: { businessId: store.businessId } as Tenant };
}

/** A message that is processed and queued, but not sent yet. */
async function queueReply(h: Harness, phoneNumberId: string, phone: string, body = "¿A qué hora está?") {
  h.channel.configured = false;
  await h.post(webhook(phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body })] }));
  h.clock.advance(4_000);
  await h.deliver();
  h.channel.configured = true;
}

async function outboxRows(businessId: string) {
  return rows<{ status: string; body_text: string; claims_json: string | null; buttons_json: string | null; claims_blocked_at_ms: number | null; last_error: string | null }>(
    `SELECT status, body_text, claims_json, buttons_json, claims_blocked_at_ms, last_error FROM outbound_messages WHERE business_id = ? ORDER BY seq`,
    businessId,
  );
}

function customer(tenant: Tenant, nowMs = 0): CustomerContext {
  return { businessId: tenant.businessId, customerId: CUSTOMER, conversationId: "conv", jobId: "job", nowMs };
}

const cancelTap = (order: OrderView) => ({
  operationKey: decisionKey("cancel", order)!,
  actor: { type: "customer", customerId: CUSTOMER } as const,
  action: { type: "cancel_order", orderId: order.orderId, version: order.version } as const,
});

describe("the second claim check, right before sending", () => {
  it("doesn't send a reply queued before a cancel: the safe reply goes instead, and a Pendientes item is raised", async () => {
    const engine = engineWith(confirmedOrder);
    const { h, phone, store, tenant } = await setup({ engine, outcome: () => ({ type: "order_confirmed", order: confirmedOrder }) });
    await queueReply(h, store.phoneNumberId, phone);
    const [queued] = await outboxRows(store.businessId);
    expect(queued).toMatchObject({ status: "pending", body_text: COPY.confirmed });
    expect(JSON.parse(queued!.claims_json!)).toHaveLength(1);

    // The customer cancels after the reply was queued.
    expect((await engine.onCustomerAction(customer(tenant), cancelTap(confirmedOrder))).outcome.type).toBe("order_cancelled");

    await h.runCron();
    expect(h.sentTo(phone)).toEqual([COPY.safeReply]);
    const [row] = await outboxRows(store.businessId);
    expect(row!.status).toBe("sent");
    expect(row!.claims_blocked_at_ms).not.toBeNull();
    expect(h.log.events()).toContain("reply_claim_blocked");
    expect(h.log.fields("pendiente_raised")).toEqual([
      expect.objectContaining({ businessId: store.businessId, reason: "claim_blocked:before_send", outboxId: expect.any(String) }),
    ]);
  });

  it("sends the reply as written while its claims hold, even if staff started packing in between", async () => {
    const engine = engineWith(confirmedOrder);
    const { h, phone, store } = await setup({ engine, outcome: () => ({ type: "order_confirmed", order: confirmedOrder }) });
    await queueReply(h, store.phoneNumberId, phone);
    const staff = { businessId: store.businessId, memberId: "m", role: "staff", canApproveFiado: false, nowMs: 0 } as const;
    const started = await engine.onConsoleAction(staff, {
      operationKey: "op-start",
      actor: { type: "member", memberId: "m", role: "staff" },
      action: { type: "start_preparing", orderId: confirmedOrder.orderId, version: 1 },
    });
    expect(started.outcome.type).toBe("action_saved");

    await h.runCron();
    expect(h.sentTo(phone)).toEqual([COPY.confirmed]);
    expect((await outboxRows(store.businessId))[0]!.claims_blocked_at_ms).toBeNull();
    expect(h.log.events()).not.toContain("pendiente_raised");
  });

  it("sends the safe reply when no engine can check the claims", async () => {
    const { h, phone, store } = await setup({
      engine: engineWith(confirmedOrder),
      verifier: "none",
      outcome: () => ({ type: "order_confirmed", order: confirmedOrder }),
    });
    await queueReply(h, store.phoneNumberId, phone);
    await h.runCron();
    expect(h.sentTo(phone)).toEqual([COPY.safeReply]);
  });

  it("retries later, never sending unchecked, when the engine fails to answer", async () => {
    const engine = engineWith(confirmedOrder);
    const { h, phone, store } = await setup({ engine, outcome: () => ({ type: "order_confirmed", order: confirmedOrder }) });
    await queueReply(h, store.phoneNumberId, phone);
    const failing: ClaimVerifier = {
      async verifyClaims() {
        throw new Error("engine unavailable");
      },
    };
    expect(await dispatchOutbox({ ...h.deps, claimVerifier: failing }, { limit: 5 })).toContain("retry_later");
    expect(h.sentTo(phone)).toEqual([]);
    expect((await outboxRows(store.businessId))[0]).toMatchObject({ status: "pending", last_error: "claim_check_unavailable" });

    await h.runCron();
    expect(h.sentTo(phone)).toEqual([COPY.confirmed]);
  });

  it("treats stored claims it can't read as claims that don't hold", async () => {
    const engine = engineWith(confirmedOrder);
    const { h, phone, store } = await setup({ engine, outcome: () => ({ type: "order_confirmed", order: confirmedOrder }) });
    await queueReply(h, store.phoneNumberId, phone);
    await rows(`UPDATE outbound_messages SET claims_json = '{"not":"claims"}' WHERE business_id = ?`, store.businessId);
    await h.runCron();
    expect(h.sentTo(phone)).toEqual([COPY.safeReply]);
  });

  it("blocks every part of a long reply together: one safe reply, the other parts never sent", async () => {
    const many: OrderView = {
      ...readbackOrder,
      lines: Array.from({ length: 120 }, (_, n) => ({
        ...readbackOrder.lines[0]!,
        lineId: `l-${n}`,
        productName: `Producto de prueba número ${n}`,
        unitPrice: null,
      })),
      total: null,
    };
    const engine = engineWith(many);
    const { h, phone, store, tenant } = await setup({ engine, outcome: () => ({ type: "readback", order: many }) });
    await queueReply(h, store.phoneNumberId, phone);
    const queued = await outboxRows(store.businessId);
    expect(queued.length).toBeGreaterThan(1);
    expect(queued.every((row) => row.claims_json !== null)).toBe(true);
    // Only the last part carries the buttons.
    expect(queued.map((row) => row.buttons_json !== null)).toEqual(queued.map((_, n) => n === queued.length - 1));

    await engine.onCustomerAction(customer(tenant), cancelTap(many));
    await h.runCron();
    expect(h.sentTo(phone)).toEqual([COPY.safeReply]);
    const after = await outboxRows(store.businessId);
    expect(after[0]!.status).toBe("sent");
    expect(after.slice(1).map((row) => [row.status, row.last_error])).toEqual(after.slice(1).map(() => ["failed", "claims_blocked_in_reply"]));
  });
});

describe("the first claim check, before the save", () => {
  it("queues the safe reply, with no claims, when the outcome doesn't back what the reply says", async () => {
    const wrongTotal: OrderView = { ...readbackOrder, total: 99900 };
    const { h, phone, store } = await setup({ engine: engineWith(wrongTotal), outcome: () => ({ type: "readback", order: wrongTotal }) });
    await queueReply(h, store.phoneNumberId, phone);
    expect(await outboxRows(store.businessId)).toEqual([
      expect.objectContaining({ status: "pending", body_text: COPY.safeReply, claims_json: null, buttons_json: null }),
    ]);
    expect(h.log.fields("pendiente_raised")).toEqual([
      expect.objectContaining({ reason: "claim_blocked:before_save", outcome: "readback" }),
    ]);
    await h.runCron();
    expect(h.sentTo(phone)).toEqual([COPY.safeReply]);
  });
});

describe("reply buttons", () => {
  it("sends the readback with its three buttons, and a tap confirms once", async () => {
    const engine = engineWith(readbackOrder);
    const { h, phone, store, tenant } = await setup({ engine, outcome: () => ({ type: "readback", order: readbackOrder }) });
    await queueReply(h, store.phoneNumberId, phone, "lo paso a traer");
    await h.runCron();

    const [sent] = h.channel.sent.filter((s) => s.toPhone === phone);
    expect(sent!.body).toContain("Total: L 315");
    expect(sent!.body).toContain("Respondé Confirmar, Corregir o Cancelar.");
    expect(sent!.buttons).toEqual([
      { id: "confirm:order-0001:v1", title: "Confirmar" },
      { id: "correct:order-0001:v1", title: "Corregir" },
      { id: "cancel:order-0001:v1", title: "Cancelar" },
    ]);

    // The tap comes back as the button's ID: the operation key. Typed "CONFIRMAR" shares it.
    const tapped = sent!.buttons![0]!.id;
    const action = actionFromButtonId(tapped);
    expect(action).toEqual({ type: "confirm_order", orderId: "order-0001", version: 1 });
    const envelope = { operationKey: tapped, actor: { type: "customer", customerId: CUSTOMER } as const, action: action! };
    expect((await engine.onCustomerAction(customer(tenant), envelope)).outcome.type).toBe("order_confirmed");

    const typed = typedDecision("CONFIRMAR");
    expect(decisionKey(typed!, { orderId: "order-0001", version: 1 })).toBe(tapped);
    const again = await engine.onCustomerAction(customer(tenant), { ...envelope, operationKey: decisionKey(typed!, readbackOrder)! });
    expect(again.outcome.type).toBe("duplicate");
    // Already answered: the duplicate gets no second reply.
    expect(renderOutcome(again.outcome, { customerId: CUSTOMER })).toBeNull();
  });

  it("drops the buttons when the claims are blocked", async () => {
    const engine = engineWith(readbackOrder);
    const { h, phone, store, tenant } = await setup({ engine, outcome: () => ({ type: "readback", order: readbackOrder }) });
    await queueReply(h, store.phoneNumberId, phone, "lo paso a traer");
    await engine.onCustomerAction(customer(tenant), cancelTap(readbackOrder));
    await h.runCron();
    const sent = h.channel.sent.filter((s) => s.toPhone === phone);
    expect(sent.map((s) => [s.body, s.buttons])).toEqual([[COPY.safeReply, undefined]]);
  });

  it("refuses a tap on another customer's order or an old version", async () => {
    const engine = engineWith({ ...readbackOrder, version: 2 });
    const tenant = { businessId: crypto.randomUUID() };
    const tap = (operationKey: string, customerId: string) =>
      engine.onCustomerAction(
        { ...customer(tenant), customerId },
        { operationKey, actor: { type: "customer", customerId }, action: actionFromButtonId(operationKey)! as never },
      );
    expect((await tap("confirm:order-0001:v1", CUSTOMER)).outcome).toMatchObject({ type: "rejected", reason: "stale_version" });
    expect((await tap("confirm:order-0001:v2", "someone-else")).outcome).toMatchObject({ type: "rejected", reason: "not_found" });
    expect((await tap("confirm:order-0001:v2", CUSTOMER)).outcome.type).toBe("order_confirmed");
  });

  it("never hands one customer's outcome to another who replays the same key", async () => {
    const engine = engineWith(readbackOrder);
    const tenant = { businessId: crypto.randomUUID() };
    const key = decisionKey("confirm", readbackOrder)!;
    const tap = (customerId: string) =>
      engine.onCustomerAction(
        { ...customer(tenant), customerId },
        { operationKey: key, actor: { type: "customer", customerId }, action: actionFromButtonId(key)! as never },
      );
    expect((await tap(CUSTOMER)).outcome.type).toBe("order_confirmed");
    const replayed = (await tap("customer-b")).outcome;
    expect(replayed).toEqual({ type: "rejected", reason: "not_found", order: null });
    // The owner's own repeat is still a duplicate of the first outcome.
    expect((await tap(CUSTOMER)).outcome.type).toBe("duplicate");
  });
});

describe("order-dependent replies that aren't readbacks", () => {
  it("doesn't send a question about an order that was cancelled after the question was queued", async () => {
    const engine = engineWith(readbackOrder);
    const ask: EngineOutcome = { type: "ask", question: "pickup_or_delivery", line: null, order: readbackOrder };
    const { h, phone, store, tenant } = await setup({ engine, outcome: () => ask });
    await queueReply(h, store.phoneNumberId, phone, "quiero agregar algo");
    expect(JSON.parse((await outboxRows(store.businessId))[0]!.claims_json!)).toHaveLength(1);

    await engine.onCustomerAction(customer(tenant), cancelTap(readbackOrder));
    await h.runCron();
    expect(h.sentTo(phone)).toEqual([COPY.safeReply]);
    expect((await outboxRows(store.businessId))[0]!.claims_blocked_at_ms).not.toBeNull();
  });

  it("sends the question while the order is still open", async () => {
    const engine = engineWith(readbackOrder);
    const ask: EngineOutcome = { type: "ask", question: "pickup_or_delivery", line: null, order: readbackOrder };
    const { h, phone, store } = await setup({ engine, outcome: () => ask });
    await queueReply(h, store.phoneNumberId, phone, "quiero agregar algo");
    await h.runCron();
    expect(h.sentTo(phone)).toEqual(["¿Lo recogés en la tienda o te lo llevamos?"]);
  });
});

describe("when the second check runs", () => {
  it("checks the claims after the claim on the row is confirmed, as the last step before the send", async () => {
    const engine = engineWith(confirmedOrder);
    const { h, phone, store } = await setup({ engine, outcome: () => ({ type: "order_confirmed", order: confirmedOrder }) });
    await queueReply(h, store.phoneNumberId, phone);

    const steps: string[] = [];
    const outbox = new Proxy(h.deps.outbox, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          steps.push(String(property));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const verifier: ClaimVerifier = {
      async verifyClaims(tenant, claims) {
        steps.push("verifyClaims");
        return engine.verifyClaims(tenant, claims);
      },
    };
    const channel = new Proxy(h.channel, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property !== "sendText" && property !== "sendButtons") return value;
        return async (...args: unknown[]) => {
          steps.push("send");
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });

    expect(await dispatchOutbox({ ...h.deps, outbox, channel, claimVerifier: verifier }, { limit: 1 })).toEqual(["sent"]);
    expect(steps.filter((s) => ["confirmClaim", "verifyClaims", "send", "markSent"].includes(s))).toEqual([
      "confirmClaim",
      "verifyClaims",
      "send",
      "markSent",
    ]);
    expect(h.sentTo(phone)).toEqual([COPY.confirmed]);
  });

  it("doesn't send when the check itself outlasts the claim's confirmation budget", async () => {
    const engine = engineWith(confirmedOrder);
    const { h, phone, store } = await setup({ engine, outcome: () => ({ type: "order_confirmed", order: confirmedOrder }) });
    await queueReply(h, store.phoneNumberId, phone);
    const slow: ClaimVerifier = {
      async verifyClaims(tenant, claims) {
        h.clock.advance(6_000);
        return engine.verifyClaims(tenant, claims);
      },
    };
    expect(await dispatchOutbox({ ...h.deps, claimVerifier: slow }, { limit: 1 })).toEqual(["retry_later"]);
    expect(h.sentTo(phone)).toEqual([]);
    expect((await outboxRows(store.businessId))[0]).toMatchObject({ status: "pending", last_error: "claim_check_slow" });
  });
});

describe("replies that claim nothing", () => {
  it("go out as written, with no engine to ask", async () => {
    const { h, phone, store } = await setup({ outcome: () => ({ type: "handoff" }) });
    await queueReply(h, store.phoneNumberId, phone);
    expect((await outboxRows(store.businessId))[0]!.claims_json).toBeNull();
    await h.runCron();
    expect(h.sentTo(phone)).toEqual([COPY.handoff]);
  });
});
