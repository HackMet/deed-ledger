import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { CustomerAction } from "../src/domain/contract/actions";
import type { OrderView } from "../src/domain/contract/outcomes";
import { BurstTooLargeError } from "../src/application/errors";
import { BURST_MAX_MESSAGES } from "../src/domain/burst";
import { RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { ANSWER_NEW_READBACK, ASK_NAME, ORDER_CONFIRMED, ORDER_NOT_OPEN, READBACK_CHANGED, renderReadback } from "../src/domain/order-copy";
import { MemoryEngine, type StoredOrder } from "../src/infrastructure/memory/memory-engine";
import { ensureLinesTable, LedgerEngine, lateOrderHandler, savedLines } from "./helpers/engines";
import { conversationOf, expireLease, type Harness, harness, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { buttonReply, textMessage, wamid, webhook } from "./helpers/whatsapp";

const SETTLED_MS = 4_000;
const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

beforeAll(ensureLinesTable);

function order(orderId: string, version: number, state: OrderView["state"] = "por_confirmar"): OrderView {
  return {
    orderId,
    version,
    state,
    lines: [
      {
        lineId: `${orderId}-1`,
        text: "3 lb arroz",
        productId: "p-arroz",
        productName: "Arroz 1 lb",
        quantity: "3",
        unit: null,
        unitPrice: 3000,
        availability: "hay",
        restricted: false,
        mark: null,
        substitute: null,
      },
    ],
    fulfillment: { mode: "pickup" },
    total: 9000,
    queuePosition: null,
  };
}

/**
 * A store with one customer who has written once (so the customer exists), on the pretend engine.
 * `orders` is filled before the engine first sees the store.
 */
async function customerOnMemoryEngine() {
  const store = await seedStore({ members: [] });
  const phone = newPhone();
  const orders: StoredOrder[] = [];
  const engine = new MemoryEngine(() => orders);
  const h = harness({ engine });
  await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
  const [customer] = await rows<{ id: string }>(`SELECT id FROM customers WHERE business_id = ?`, store.businessId);
  // The first message's introduction (#30) is covered in customer-controls.test.ts; these tests count replies.
  await env.DB.prepare(`UPDATE customers SET introduced_at_ms = 1 WHERE id = ?`).bind(customer!.id).run();
  const conversation = await conversationOf(store.businessId);
  const tenant = { businessId: store.businessId };

  const send = async (message: ReturnType<typeof textMessage> | ReturnType<typeof buttonReply>) => {
    await h.post(webhook(store.phoneNumberId, { messages: [message] }));
    h.clock.advance(SETTLED_MS);
    await h.deliver(h.takeRingsFor(store.businessId));
  };
  return {
    h,
    store,
    phone,
    engine,
    orders,
    tenant,
    conversation,
    customerId: customer!.id,
    // A person takes a moment to read the last reply before answering.
    say: (body: string, id = wamid()) => {
      h.clock.advance(1_000);
      return send(textMessage({ from: phone, id, timestampS: nowS(h), body }));
    },
    tap: (replyId: string, title: string, id = wamid()) => {
      h.clock.advance(1_000);
      return send(buttonReply({ from: phone, id, timestampS: nowS(h), replyId, title }));
    },
    /** As if a readback of this version had been queued to the customer, by default just now. */
    showReadback: (orderId: string, version: number, queuedAtMs = h.clock.now() - 1) =>
      env.DB.prepare(
        `UPDATE conversations SET last_readback_order_id = ?, last_readback_version = ?, last_readback_at_ms = ?
         WHERE business_id = ? AND id = ?`,
      )
        .bind(orderId, version, queuedAtMs, store.businessId, conversation.conversationId)
        .run(),
    orderState: async (orderId: string) =>
      (await engine.preparationList(tenant)).find((card) => card.order.orderId === orderId)?.order.state ?? null,
  };
}

function stored(customerId: string, view: OrderView): StoredOrder {
  return { customerId, customerName: null, confirmedAtMs: 0, changedLineIds: [], order: view };
}

describe("readback answers reach the engine with no model", () => {
  it("a tap and a typed \"confirmar\" confirm once: they share one operation key", async () => {
    const c = await customerOnMemoryEngine();
    c.orders.push(stored(c.customerId, order("o-1", 1)));
    c.h.clock.advance(SETTLED_MS);
    await c.h.deliver(c.h.takeRingsFor(c.store.businessId)); // "Hola": the placeholder
    await c.showReadback("o-1", 1);

    await c.tap("confirm:o-1:v1", "Confirmar");
    expect(await c.orderState("o-1")).toBe("confirmado");
    await c.say("Confirmar");

    expect(c.h.sentTo(c.phone)).toEqual([RECEIVED_PLACEHOLDER, ORDER_CONFIRMED]);
    const jobs = await rows<{ job_state: string }>(`SELECT job_state FROM inbound_messages WHERE business_id = ?`, c.store.businessId);
    expect(jobs.map((job) => job.job_state)).toEqual(["done", "done", "done"]);
  });

  it("typed in any case or accent first, then the button: still one confirmation", async () => {
    const c = await customerOnMemoryEngine();
    c.orders.push(stored(c.customerId, order("o-2", 1)));
    c.h.clock.advance(SETTLED_MS);
    await c.h.deliver(c.h.takeRingsFor(c.store.businessId));
    await c.showReadback("o-2", 1);

    await c.say("  CONFIRMÁR! ");
    await c.tap("confirm:o-2:v1", "Confirmar");
    expect(c.h.sentTo(c.phone)).toEqual([RECEIVED_PLACEHOLDER, ORDER_CONFIRMED]);
    expect(await c.orderState("o-2")).toBe("confirmado");
  });

  it("a replayed tap saves nothing: Meta's redelivery is dropped, and a second tap is a duplicate", async () => {
    const c = await customerOnMemoryEngine();
    c.orders.push(stored(c.customerId, order("o-3", 1)));
    c.h.clock.advance(SETTLED_MS);
    await c.h.deliver(c.h.takeRingsFor(c.store.businessId));

    const tapId = wamid();
    await c.tap("confirm:o-3:v1", "Confirmar", tapId);
    const outboxAfterFirst = await rows(`SELECT id FROM outbound_messages WHERE business_id = ?`, c.store.businessId);
    const confirmedAt = (await c.engine.preparationList(c.tenant))[0]!.confirmedAtMs;

    await c.tap("confirm:o-3:v1", "Confirmar", tapId); // the same message again
    await c.tap("confirm:o-3:v1", "Confirmar"); // a second tap
    expect(await rows(`SELECT id FROM outbound_messages WHERE business_id = ?`, c.store.businessId)).toEqual(outboxAfterFirst);
    expect((await c.engine.preparationList(c.tenant))[0]!.confirmedAtMs).toBe(confirmedAt);
    expect(c.h.sentTo(c.phone)).toEqual([RECEIVED_PLACEHOLDER, ORDER_CONFIRMED]);
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ?`, c.store.businessId)).toHaveLength(3);
  });

  it("resolves a button's order only among the customer's own orders", async () => {
    const c = await customerOnMemoryEngine();
    c.orders.push(stored("someone-else", order("o-theirs", 1)));
    c.h.clock.advance(SETTLED_MS);
    await c.h.deliver(c.h.takeRingsFor(c.store.businessId));

    await c.tap("confirm:o-theirs:v1", "Confirmar");
    expect(c.h.sentTo(c.phone)).toEqual([RECEIVED_PLACEHOLDER, ORDER_NOT_OPEN]);
    // Still por_confirmar: not on the preparation list.
    expect(await c.orderState("o-theirs")).toBeNull();
  });

  it("answers a stale version with the current readback, and typed words then answer that version", async () => {
    const c = await customerOnMemoryEngine();
    c.orders.push(stored(c.customerId, order("o-4", 2)));
    c.h.clock.advance(SETTLED_MS);
    await c.h.deliver(c.h.takeRingsFor(c.store.businessId));
    await c.showReadback("o-4", 1);

    await c.say("confirmar"); // answers v1, which changed
    expect(c.h.sentTo(c.phone).at(-1)).toBe(`${READBACK_CHANGED}\n${renderReadback(order("o-4", 2))}`);
    expect(await c.orderState("o-4")).toBeNull();
    expect(
      await rows(`SELECT last_readback_order_id, last_readback_version FROM conversations WHERE id = ?`, c.conversation.conversationId),
    ).toEqual([{ last_readback_order_id: "o-4", last_readback_version: 2 }]);

    await c.say("Confirmar");
    expect(c.h.sentTo(c.phone).at(-1)).toBe(ORDER_CONFIRMED);
    expect(await c.orderState("o-4")).toBe("confirmado");
  });

  it("never lets a typed word confirm a readback queued after the word arrived", async () => {
    const c = await customerOnMemoryEngine();
    c.orders.push(stored(c.customerId, order("o-6", 2)));
    c.h.clock.advance(SETTLED_MS);
    await c.h.deliver(c.h.takeRingsFor(c.store.businessId));
    await c.showReadback("o-6", 1);

    // The customer, looking at v1, types "confirmar"; before it is handled, an earlier job queues the v2 readback.
    await c.h.post(webhook(c.store.phoneNumberId, { messages: [textMessage({ from: c.phone, id: wamid(), timestampS: nowS(c.h), body: "confirmar" })] }));
    await c.showReadback("o-6", 2, c.h.clock.now() + 1);
    c.h.clock.advance(SETTLED_MS);
    await c.h.deliver(c.h.takeRingsFor(c.store.businessId));
    expect(c.h.sentTo(c.phone).at(-1)).toBe(ANSWER_NEW_READBACK);
    expect(await c.orderState("o-6")).toBeNull();

    // Typed after seeing v2, it confirms v2.
    await c.say("confirmar");
    expect(c.h.sentTo(c.phone).at(-1)).toBe(ORDER_CONFIRMED);
    expect(await c.orderState("o-6")).toBe("confirmado");
  });

  it("reads \"confirmar\" as a message when no readback is open", async () => {
    const c = await customerOnMemoryEngine();
    const actions: CustomerAction[] = [];
    const original = c.engine.onCustomerAction.bind(c.engine);
    c.engine.onCustomerAction = async (context, envelope) => {
      actions.push(envelope.action);
      return original(context, envelope);
    };
    await c.say("confirmar");
    expect(actions).toEqual([]);
    expect(c.h.sentTo(c.phone)).toEqual([RECEIVED_PLACEHOLDER]);
  });

  it("ignores a button ID that isn't one of ours, and one over 256 characters", async () => {
    const c = await customerOnMemoryEngine();
    c.orders.push(stored(c.customerId, order("o-5", 1)));
    await c.tap(`confirm:${"x".repeat(260)}:v1`, "Confirmar");
    await c.tap("borrar_todo", "Confirmar");
    expect(await c.orderState("o-5")).toBeNull();
  });
});

describe("a burst is read once", () => {
  async function customerOnLedger(options: { askName?: boolean } = {}) {
    const store = await seedStore({ members: [] });
    const phone = newPhone();
    const engine = new LedgerEngine(options);
    const late = lateOrderHandler(engine);
    const h = harness({ jobHandler: late.jobHandler });
    late.attach(h);
    /** Each message arrives a moment after the one before, as a customer types them. */
    const post = async (...bodies: string[]) => {
      for (const body of bodies) {
        h.clock.advance(200);
        await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body })] }));
      }
    };
    const deliver = () => h.deliver(h.takeRingsFor(store.businessId));
    return { h, store, phone, engine, post, deliver };
  }

  it("reads a three-message burst at its newest message; earlier jobs complete with no reply", async () => {
    const c = await customerOnLedger();
    await c.post("arroz", "azúcar", "jabón");
    c.h.clock.advance(SETTLED_MS);
    await c.deliver();

    expect(await savedLines(c.store.businessId)).toEqual(["arroz", "azúcar", "jabón"]);
    expect(c.engine.contexts).toHaveLength(1);
    expect(c.h.sentTo(c.phone)).toEqual(["¿Lo recogés en la tienda o te lo llevamos?"]);
    expect(await rows(`SELECT 1 FROM burst_reads WHERE business_id = ?`, c.store.businessId)).toHaveLength(3);
  });

  it("a crash mid-burst neither loses nor repeats a line: the retry reads the whole burst again", async () => {
    const c = await customerOnLedger();
    let crashes = 1;
    c.engine.beforeSave = async () => {
      if (crashes-- > 0) throw new Error("worker crashed");
    };
    await c.post("arroz", "azúcar", "jabón");
    c.h.clock.advance(SETTLED_MS);
    await c.deliver(); // jobs 1 and 2 done, job 3 fails before its save and is deferred
    expect(await savedLines(c.store.businessId)).toEqual([]);

    c.h.clock.advance(30_000);
    await c.deliver();
    expect(await savedLines(c.store.businessId)).toEqual(["arroz", "azúcar", "jabón"]);
    expect(c.h.sentTo(c.phone)).toEqual(["¿Lo recogés en la tienda o te lo llevamos?"]);
  });

  it("a consumer that loses its lease mid-burst saves nothing; the next one reads every line once", async () => {
    const c = await customerOnLedger();
    let first = true;
    c.engine.beforeSave = async (context) => {
      if (!first) return;
      first = false;
      await expireLease(context.conversationId); // the consumer stalled past its lease
    };
    await c.post("arroz", "azúcar");
    c.h.clock.advance(SETTLED_MS);
    await c.deliver();
    // The stalled consumer's save was refused whole; the burst was read again under a new lease.
    expect(c.h.log.fields("stale_write_refused")).toHaveLength(1);
    await c.h.runCron();
    await c.deliver();
    expect(await savedLines(c.store.businessId)).toEqual(["arroz", "azúcar"]);
    expect(c.h.sentTo(c.phone)).toEqual(["¿Lo recogés en la tienda o te lo llevamos?"]);
    expect(c.engine.contexts).toHaveLength(2);
  });

  it("a message arriving while the burst is handled is neither lost nor repeated", async () => {
    const c = await customerOnLedger();
    let interleaved = false;
    c.engine.beforeSave = async () => {
      if (interleaved) return;
      interleaved = true;
      await c.post("leche"); // arrives during handling
    };
    await c.post("arroz", "azúcar");
    c.h.clock.advance(SETTLED_MS);
    await c.deliver();
    // The first reading saved its lines; its burst-closing reply was withheld for the late message.
    expect(await savedLines(c.store.businessId)).toEqual(["arroz", "azúcar"]);
    expect(c.h.sentTo(c.phone)).toEqual([]);

    c.h.clock.advance(SETTLED_MS);
    await c.deliver();
    expect(await savedLines(c.store.businessId)).toEqual(["arroz", "azúcar", "leche"]);
    expect(c.h.sentTo(c.phone)).toEqual(["¿Lo recogés en la tienda o te lo llevamos?"]);
  });

  it("reads a burst of more than 50 messages whole: no line is stranded", async () => {
    const c = await customerOnLedger();
    const items = Array.from({ length: 60 }, (_, n) => `producto ${n}`);
    await c.post(...items);
    c.h.clock.advance(SETTLED_MS);
    await c.deliver();
    for (let n = 0; n < 5 && c.h.ringsFor(c.store.businessId).length > 0; n++) {
      c.h.clock.advance(SETTLED_MS);
      await c.deliver();
    }
    expect(await savedLines(c.store.businessId)).toEqual(items);
    expect(await rows(`SELECT 1 FROM burst_reads WHERE business_id = ?`, c.store.businessId)).toHaveLength(60);
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ? AND job_state <> 'done'`, c.store.businessId)).toEqual([]);
  }, 30_000); // 60 messages through intake and the processor on local D1

  it("fails loudly, reading nothing, when a burst is over the cap instead of reading part of it", async () => {
    const c = await customerOnLedger();
    await c.post("primero");
    const conversation = await conversationOf(c.store.businessId);
    const ids = Array.from({ length: BURST_MAX_MESSAGES + 1 }, () => crypto.randomUUID());
    await env.DB.batch(
      ids.map((id, n) =>
        env.DB.prepare(
          `INSERT INTO inbound_messages (id, business_id, conversation_id, provider, provider_message_id, provider_timestamp_s,
             order_ts_s, received_at_ms, kind, text_body, job_state)
           VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, ?, 'text', 'relleno', 'done')`,
        ).bind(id, c.store.businessId, conversation.conversationId, wamid(`FILL${n}`), nowS(c.h) + 1, nowS(c.h) + 1, c.h.clock.now() + n),
      ),
    );
    const lease = { ...conversation, leaseId: "lease-cap" };
    await expect(c.h.deps.jobs.unreadBurst(lease, ids.at(-1)!, c.h.clock.now() - 60_000)).rejects.toBeInstanceOf(BurstTooLargeError);
    expect(await rows(`SELECT 1 FROM burst_reads WHERE business_id = ?`, c.store.businessId)).toEqual([]);
  });

  it("refuses to save a reading that uses a message another reading already used", async () => {
    const c = await customerOnLedger();
    await c.post("arroz");
    c.h.clock.advance(SETTLED_MS);
    await c.deliver();
    const [message] = await rows<{ id: string }>(`SELECT id FROM inbound_messages WHERE business_id = ?`, c.store.businessId);
    const conversation = await conversationOf(c.store.businessId);
    const lease = { ...conversation, leaseId: "lease-test" };
    expect(await c.h.deps.jobs.claimLease(conversation, lease.leaseId, 60_000)).toBe("claimed");
    const commit = c.h.deps.jobs.markReadCommit(lease, message!.id, [message!.id], c.h.clock.now());
    const { guardedBatch } = await import("../src/infrastructure/d1/fence");
    await expect(guardedBatch(env.DB, commit.guards, commit.statements)).rejects.toThrow(/already read/);
  });
});

describe("the customer's name", () => {
  async function customer() {
    const store = await seedStore({ members: [] });
    const phone = newPhone();
    const engine = new LedgerEngine({ askName: true });
    const late = lateOrderHandler(engine);
    const h = harness({ jobHandler: late.jobHandler });
    late.attach(h);
    const say = async (body: string) => {
      await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body })] }));
      h.clock.advance(SETTLED_MS);
      await h.deliver(h.takeRingsFor(store.businessId));
    };
    const record = async () =>
      (
        await rows<{ name: string | null; name_saved_at_ms: number | null; name_asked_at_ms: number | null }>(
          `SELECT name, name_saved_at_ms, name_asked_at_ms FROM customers WHERE business_id = ?`,
          store.businessId,
        )
      )[0]!;
    return { h, store, phone, engine, say, record };
  }

  it("is asked once, without blocking the order", async () => {
    const c = await customer();
    await c.say("arroz");
    await c.say("azúcar");
    expect(c.h.sentTo(c.phone)).toEqual([ASK_NAME, "¿Lo recogés en la tienda o te lo llevamos?"]);
    // The order went on: both lines were saved, the first one with the question.
    expect(await savedLines(c.store.businessId)).toEqual(["arroz", "azúcar"]);
    expect((await c.record()).name_asked_at_ms).not.toBeNull();
    expect(c.engine.contexts.map((context) => context.customerNameAsked)).toEqual([false, true]);
  });

  it("isn't marked asked when the reply with the question is withheld for a later message", async () => {
    const c = await customer();
    let interleaved = false;
    c.engine.beforeSave = async () => {
      if (interleaved) return;
      interleaved = true;
      await c.h.post(webhook(c.store.phoneNumberId, { messages: [textMessage({ from: c.phone, id: wamid(), timestampS: nowS(c.h), body: "azúcar" })] }));
    };
    await c.say("arroz");
    expect(c.h.sentTo(c.phone)).toEqual([]); // the question was withheld
    expect((await c.record()).name_asked_at_ms).toBeNull();

    c.h.clock.advance(SETTLED_MS);
    await c.h.deliver(c.h.takeRingsFor(c.store.businessId));
    expect(c.h.sentTo(c.phone)).toEqual([ASK_NAME]);
    expect((await c.record()).name_asked_at_ms).not.toBeNull();
    expect(await savedLines(c.store.businessId)).toEqual(["arroz", "azúcar"]);
  });

  it("is saved once, and a returning customer is recognized by it", async () => {
    const c = await customer();
    await c.say("Me llamo Carla");
    const saved = await c.record();
    expect(saved).toMatchObject({ name: "Carla", name_saved_at_ms: expect.any(Number) });

    c.h.clock.advance(2 * 24 * 60 * 60 * 1000);
    await c.say("Me llamo Carlota");
    expect(await c.record()).toMatchObject({ name: "Carla", name_saved_at_ms: saved.name_saved_at_ms });
    await c.say("arroz");
    expect(c.engine.contexts.at(-1)).toMatchObject({ customerName: "Carla" });
    // Known by name, so it isn't asked.
    expect(c.h.sentTo(c.phone)).not.toContain(ASK_NAME);
  });
});
