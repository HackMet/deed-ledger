import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { CustomerAction } from "../src/domain/contract/actions";
import type { OrderView } from "../src/domain/contract/outcomes";
import { BurstTooLargeError } from "../src/application/errors";
import { BURST_MAX_MESSAGES } from "../src/domain/burst";
import { RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { ANSWER_NEW_READBACK } from "../src/domain/order-copy";
import { COPY, renderOutcome } from "../src/domain/replies";
import { MemoryEngine, type StoredOrder } from "../src/infrastructure/memory/memory-engine";
import { ensureLinesTable, LedgerEngine, lateOrderHandler, savedLines } from "./helpers/engines";
import { conversationOf, expireLease, type Harness, harness, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { audioMessage, buttonReply, imageMessage, textMessage, wamid, webhook } from "./helpers/whatsapp";
import type { BurstMediaResolver } from "../src/application/order-reading";
import type { MediaBytes, ModelProvider, ModelRequest, Transcriber, TranscriberAudio, Transcript } from "../src/application/ports";
import { toneOgg } from "./fixtures/audio";
import { FakeMediaSource } from "./helpers/fakes";
import { buildOrderReading } from "../src/composition";
import { renderNotice } from "../src/domain/replies";
import type { CustomerNotice } from "../src/domain/contract/outcomes";
import type { PretendProduct } from "../src/infrastructure/memory/memory-engine";
import { box, line, photo, quote, voice } from "./fixtures/model/recorded";
import { csrfFor, login, send as consoleSend, storeWithStaff } from "./helpers/console";
import { testEnv } from "./helpers/harness";

const SETTLED_MS = 4_000;
const ASK_NAME = "¿A nombre de quién lo anoto?";
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

    expect(c.h.sentTo(c.phone)).toEqual([RECEIVED_PLACEHOLDER, COPY.confirmed]);
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
    expect(c.h.sentTo(c.phone)).toEqual([RECEIVED_PLACEHOLDER, COPY.confirmed]);
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
    expect(c.h.sentTo(c.phone)).toEqual([RECEIVED_PLACEHOLDER, COPY.confirmed]);
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ?`, c.store.businessId)).toHaveLength(3);
  });

  it("resolves a button's order only among the customer's own orders", async () => {
    const c = await customerOnMemoryEngine();
    c.orders.push(stored("someone-else", order("o-theirs", 1)));
    c.h.clock.advance(SETTLED_MS);
    await c.h.deliver(c.h.takeRingsFor(c.store.businessId));

    await c.tap("confirm:o-theirs:v1", "Confirmar");
    expect(c.h.sentTo(c.phone)).toEqual([RECEIVED_PLACEHOLDER, COPY.refusedTap]);
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
    expect(c.h.sentTo(c.phone).at(-1)).toBe(
      renderOutcome({ type: "rejected", reason: "stale_version", order: order("o-4", 2) }, { customerId: c.customerId })!.body,
    );
    expect(await c.orderState("o-4")).toBeNull();
    // The current readback carries its own buttons.
    expect(c.h.channel.sent.at(-1)?.buttons?.map((button) => button.id)).toEqual(["confirm:o-4:v2", "correct:o-4:v2", "cancel:o-4:v2"]);
    expect(
      await rows(`SELECT last_readback_order_id, last_readback_version FROM conversations WHERE id = ?`, c.conversation.conversationId),
    ).toEqual([{ last_readback_order_id: "o-4", last_readback_version: 2 }]);

    await c.say("Confirmar");
    expect(c.h.sentTo(c.phone).at(-1)).toBe(COPY.confirmed);
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
    expect(c.h.sentTo(c.phone).at(-1)).toBe(COPY.confirmed);
    expect(await c.orderState("o-6")).toBe("confirmado");
  });

  it("asks what to change on Corregir, and leaves the order waiting", async () => {
    const c = await customerOnMemoryEngine();
    c.orders.push(stored(c.customerId, order("o-7", 1)));
    c.h.clock.advance(SETTLED_MS);
    await c.h.deliver(c.h.takeRingsFor(c.store.businessId));
    await c.tap("correct:o-7:v1", "Corregir");
    expect(c.h.sentTo(c.phone)).toEqual([RECEIVED_PLACEHOLDER, "Va. Decime qué le cambiamos al pedido."]);
    expect(await c.orderState("o-7")).toBeNull();
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

// ---------------------------------------------------------------------------------------------
// The whole trip, PRD "A first order": WhatsApp in, Muse Spark's reading (recorded), the pretend
// engine, the replies templates and the claim check, the outbox, the fake channel, and the staff's
// taps on the preparation list.

/** Synthetic catalog with the store's confirmed prices. "aceite clover" alone fits two sizes. */
const CATALOG: readonly PretendProduct[] = [
  { productId: "p-clover-1l", names: ["Aceite Clover 1 L"], aliases: ["aceite clover", "aceite clover de litro"], barcode: null, price: 6000 },
  { productId: "p-clover-500", names: ["Aceite Clover 500 ml"], aliases: ["aceite clover", "aceite clover de medio"], barcode: null, price: 3400 },
  { productId: "p-arroz", names: ["Arroz 1 lb", "Arroz"], aliases: [], barcode: null, price: 3000 },
  { productId: "p-azucar", names: ["Azúcar 1 lb", "Azúcar"], aliases: [], barcode: null, price: 3000 },
  { productId: "p-jabon", names: ["Jabón Xtra"], aliases: [], barcode: null, price: 3500 },
];

const TRANSCRIPT = "Y agregale dos libras de azúcar";
const none = { issues: [] };

/** Recorded readings in the wire format, one per burst, in the order the bursts are read. */
const READINGS = {
  hola: { observations: [{ kind: "other", ...none }] },
  nameListVoice: {
    observations: [
      { kind: "customer_name", name: "Carla", evidence: quote(0, "Carla"), ...none },
      {
        kind: "customer_order",
        lines: [
          line("1 aceite clover", "aceite clover", "1", null, box(1, [0.08, 0.12, 0.71, 0.2])),
          line("3 lb arroz", "arroz", "3", "libra", box(1, [0.08, 0.22, 0.6, 0.3])),
          line("3 jabon xtra", "jabon xtra", "3", null, box(1, [0.08, 0.32, 0.66, 0.4])),
          line("dos libras de azúcar", "azúcar", "2", "libra", quote(2, "dos libras de azúcar")),
        ],
        issues: [{ code: "ambiguous_size", line: 0, evidence: box(1, [0.08, 0.12, 0.71, 0.2]) }],
      },
    ],
  },
  deLitro: { observations: [{ kind: "clarification", answer: "de litro", evidence: quote(0, "de litro"), ...none }] },
  pickup: { observations: [{ kind: "fulfillment", mode: "pickup", place_text: null, same_as_before: false, ...none }] },
  whenReady: { observations: [{ kind: "question", topic: "order_status", products: [], ...none }] },
} as const;

/** Muse Spark's place, answering each call with the next recorded reading. Never the network. */
class RecordedProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  readonly requests: ModelRequest[] = [];
  failNext = 0;

  constructor(private readonly readings: unknown[]) {}

  async complete(request: ModelRequest) {
    this.requests.push(request);
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false, error: "unavailable", status: 503, latencyMs: 30, inputTokens: null, outputTokens: null } as const;
    }
    const json = this.readings.shift();
    if (json === undefined) throw new Error("no recorded reading left");
    return { ok: true, json, latencyMs: 7_000, inputTokens: 3_950, outputTokens: 1_500 } as const;
  }

  /** The text the model was given in call n (context and messages), joined. */
  textOf(n: number): string {
    return this.requests[n]!.user.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  }
}

/** Photos and voice notes as #26 and #27 will resolve them: synthetic bytes, a recorded transcript. */
const recordedMedia: BurstMediaResolver = {
  async resolve(_tenant, job) {
    return job.kind === "image" ? photo() : voice(TRANSCRIPT);
  },
};

async function firstOrderTrip(readings: unknown[]) {
  const store = await storeWithStaff();
  const staff = store.members[1]!;
  const phone = newPhone();
  const engine = new MemoryEngine(() => [], { catalog: CATALOG });
  const provider = new RecordedProvider(readings);
  const h = harness({ engine, modelProvider: provider, burstMedia: recordedMedia });
  const tenant = { businessId: store.businessId };

  const notices: CustomerNotice[] = [];
  const onConsoleAction = engine.onConsoleAction.bind(engine);
  engine.onConsoleAction = async (context, envelope) => {
    const result = await onConsoleAction(context, envelope);
    notices.push(...result.notices);
    return result;
  };

  const settle = async () => {
    h.clock.advance(SETTLED_MS);
    await h.deliver(h.takeRingsFor(store.businessId));
  };
  /** One burst: each message a moment after the one before, then the conversation settles. */
  const burst = async (...messages: readonly unknown[]) => {
    h.clock.advance(1_000);
    for (const message of messages) {
      h.clock.advance(200);
      await h.post(webhook(store.phoneNumberId, { messages: [message] }));
    }
    await settle();
  };
  const at = () => ({ from: phone, id: wamid(), timestampS: nowS(h) });
  const text = (body: string) => textMessage({ ...at(), body });

  let cookie: string | null = null;
  /** A staff tap on the preparation list, through the console route. */
  const staffTap = async (type: "start_preparing" | "mark_ready", operationKey: string) => {
    cookie ??= await login(h, store.businessId, staff.userId);
    const card = (await engine.preparationList(tenant))[0]!;
    const response = await consoleSend(h, "/console/acciones", {
      method: "POST",
      cookie,
      form: { type, orderId: card.order.orderId, version: String(card.order.version), operationKey, csrf: await csrfFor(h, cookie) },
    });
    expect(response.status).toBe(303);
  };

  return { h, store, phone, engine, provider, tenant, notices, burst, text, at, staffTap };
}

const EXPECTED_READBACK = [
  "Tu pedido:",
  "1. Aceite Clover 1 L: 1 × L 60 = L 60",
  "2. Arroz 1 lb: 3 libras × L 30 = L 90",
  "3. Jabón Xtra: 3 × L 35 = L 105",
  "4. Azúcar 1 lb: 2 libras × L 30 = L 60",
  "Lo recogés en la tienda.",
  "Total: L 315",
  "¿Está bien así? Respondé Confirmar, Corregir o Cancelar.",
].join("\n");

describe("the first order, from reading to reply", () => {
  it("goes Hola → name → list and voice note → size → pickup → readback → Confirmar → on the list → listo", async () => {
    const t = await firstOrderTrip(Object.values(READINGS).concat([READINGS.whenReady]));

    await t.burst(t.text("Hola, quiero hacer un pedido"));
    // The name, a photo of the list and a voice note settle into one burst: one reading, one reply.
    await t.burst(
      t.text("Carla"),
      imageMessage({ ...t.at(), mediaId: "media-list" }),
      audioMessage({ ...t.at(), mediaId: "media-voice" }),
    );
    expect(t.provider.requests).toHaveLength(2);
    await t.burst(t.text("de litro"));
    await t.burst(t.text("lo paso a traer"));

    const readback = t.h.channel.sent.filter((sent) => sent.toPhone === t.phone).at(-1)!;
    expect(readback.body).toBe(EXPECTED_READBACK);
    const confirm = readback.buttons?.find((button) => button.title === "Confirmar");
    expect(readback.buttons?.map((button) => button.title)).toEqual(["Confirmar", "Corregir", "Cancelar"]);
    expect(confirm?.id).toMatch(/^confirm:order-[0-9a-f-]+:v1$/);
    expect(await t.engine.preparationList(t.tenant)).toEqual([]); // nothing on the list before Confirmar

    await t.burst(buttonReply({ ...t.at(), replyId: confirm!.id, title: "Confirmar" }));
    const [card] = await t.engine.preparationList(t.tenant);
    expect(card).toMatchObject({ customerName: "Carla", order: { state: "confirmado", version: 1, total: 31500 } });

    await t.burst(t.text("¿a qué hora está?"));
    await t.staffTap("start_preparing", "k-start");
    await t.staffTap("mark_ready", "k-ready");
    expect((await t.engine.preparationList(t.tenant))[0]!.order.state).toBe("listo");
    // The engine's notice renders as the PRD says; queuing it with the tap is #18 (console taps save
    // with their customer messages), so it doesn't reach the phone yet.
    expect(t.notices.map((notice) => renderNotice(notice.notice).body)).toEqual([
      "Tu pedido ya está listo. Total L 315. Ya podés pasar a traerlo.",
    ]);
    await t.burst(t.text("¿ya está?"));

    expect(t.h.sentTo(t.phone)).toEqual([
      "¿A nombre de quién lo anoto?",
      "¿De qué tamaño querés 1 aceite clover?",
      "¿Lo recogés en la tienda o te lo llevamos?",
      EXPECTED_READBACK,
      COPY.confirmed,
      "Vas primero en la lista. Te aviso apenas esté listo.",
      COPY.statusReady,
    ]);

    // Each reply was written once and sent once, in order.
    const outbox = await rows<{ body_text: string; status: string }>(
      `SELECT body_text, status FROM outbound_messages WHERE business_id = ? ORDER BY seq`,
      t.store.businessId,
    );
    expect(outbox.map((row) => row.body_text)).toEqual(t.h.sentTo(t.phone));
    expect(outbox.every((row) => row.status === "sent")).toBe(true);

    // The name was asked once and saved once, through our own records.
    expect(await rows(`SELECT name, name_asked_at_ms IS NOT NULL AS asked FROM customers WHERE business_id = ?`, t.store.businessId)).toEqual([
      { name: "Carla", asked: 1 },
    ]);
    // Six readings, one model call each; the tap needed none.
    expect(t.provider.requests).toHaveLength(6);
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ? AND job_state <> 'done'`, t.store.businessId)).toEqual([]);
  }, 30_000);

  it("gives perception the burst in order, the open order's labels and the question asked last", async () => {
    const t = await firstOrderTrip([READINGS.hola, READINGS.nameListVoice, READINGS.deLitro]);
    await t.burst(t.text("Hola, quiero hacer un pedido"));
    await t.burst(
      t.text("Carla"),
      imageMessage({ ...t.at(), mediaId: "media-list" }),
      audioMessage({ ...t.at(), mediaId: "media-voice" }),
    );
    await t.burst(t.text("de litro"));

    expect(t.provider.textOf(0)).toContain("PREGUNTA PENDIENTE: ninguna");
    expect(t.provider.textOf(1)).toContain("PREGUNTA PENDIENTE: customer_name");
    const burst = t.provider.requests[1]!.user;
    expect(burst.filter((part) => part.type === "image")).toHaveLength(1);
    expect(t.provider.textOf(1)).toContain(`[0] texto: "Carla"`);
    expect(t.provider.textOf(1)).toContain("[1] foto:");
    expect(t.provider.textOf(1)).toContain(`[2] nota de voz (transcripcion): ${JSON.stringify(TRANSCRIPT)}`);
    expect(t.provider.textOf(2)).toContain("PREGUNTA PENDIENTE: ambiguous_size");
    expect(t.provider.textOf(2)).toContain(`L1: "1 aceite clover: 1"\nL2: "Arroz 1 lb: 3"\nL3: "Jabón Xtra: 3"\nL4: "Azúcar 1 lb: 2"`);
    // Logs carry IDs and counts, never what the customer wrote.
    expect(t.h.log.lines.join("\n")).not.toMatch(/Carla|aceite|azúcar|litro/i);
  });

  it("a replayed webhook changes nothing: no reading, no record, no reply", async () => {
    const t = await firstOrderTrip([READINGS.hola, READINGS.nameListVoice, READINGS.deLitro, READINGS.pickup]);
    await t.burst(t.text("Hola, quiero hacer un pedido"));
    await t.burst(t.text("Carla"), imageMessage({ ...t.at(), mediaId: "m1" }), audioMessage({ ...t.at(), mediaId: "m2" }));
    await t.burst(t.text("de litro"));
    const pickup = t.text("lo paso a traer");
    await t.burst(pickup);

    const before = {
      outbox: await rows(`SELECT id, status FROM outbound_messages WHERE business_id = ? ORDER BY seq`, t.store.businessId),
      inbound: await rows(`SELECT id, job_state FROM inbound_messages WHERE business_id = ?`, t.store.businessId),
      reads: await rows(`SELECT * FROM burst_reads WHERE business_id = ?`, t.store.businessId),
      sent: t.h.sentTo(t.phone),
    };
    await t.burst(pickup); // Meta delivers the same message again
    await t.burst(pickup);

    expect(t.provider.requests).toHaveLength(4);
    expect(await rows(`SELECT id, status FROM outbound_messages WHERE business_id = ? ORDER BY seq`, t.store.businessId)).toEqual(before.outbox);
    expect(await rows(`SELECT id, job_state FROM inbound_messages WHERE business_id = ?`, t.store.businessId)).toEqual(before.inbound);
    expect(await rows(`SELECT * FROM burst_reads WHERE business_id = ?`, t.store.businessId)).toEqual(before.reads);
    expect(t.h.sentTo(t.phone)).toEqual(before.sent);
    expect(t.h.sentTo(t.phone).at(-1)).toBe(EXPECTED_READBACK);
    // The order is still version 1, waiting on Confirmar: nothing was applied twice.
    const [customer] = await rows<{ id: string }>(`SELECT id FROM customers WHERE business_id = ?`, t.store.businessId);
    const context = { ...t.tenant, customerId: customer!.id, conversationId: "", jobId: "", nowMs: 0 };
    expect((await t.engine.perceptionContext(context)).openOrder?.lines).toHaveLength(4);
  });

  it("a reading that fails is retried; it never saves half a burst, and the honest reply comes after the last try", async () => {
    const t = await firstOrderTrip([READINGS.hola]);
    t.provider.failNext = 3;
    await t.burst(t.text("Hola, quiero hacer un pedido"));
    for (let n = 0; n < 3; n++) {
      t.h.clock.advance(30_000);
      await t.h.deliver(t.h.takeRingsFor(t.store.businessId));
    }
    expect(t.provider.requests).toHaveLength(3);
    expect(t.h.sentTo(t.phone)).toEqual(["Perdón, no pude revisar tu mensaje. ¿Me lo mandás otra vez?"]);
    expect(await rows(`SELECT 1 FROM burst_reads WHERE business_id = ?`, t.store.businessId)).toEqual([]);
    expect(t.h.log.fields("job_attempt_failed").map((fields) => fields.reason)).toContain("ReadingFailedError");
  });

  it("uses no reader without MODEL_API_KEY, or with an engine that can't tell perception about the order", async () => {
    const engine = new MemoryEngine();
    const deps = { clock: { now: () => 0 }, log: { info() {}, warn() {}, error() {} } };
    expect(buildOrderReading(testEnv({ MODEL_API_KEY: "" } as Partial<Env>), engine, deps)).toBeNull();
    const provider = new RecordedProvider([]);
    expect(buildOrderReading(testEnv(), engine, deps, { provider })).not.toBeNull();
    expect(buildOrderReading(testEnv(), new LedgerEngine(), deps, { provider })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Photos and voice notes read for real: bytes downloaded (fake source) into R2, read back for the
// reader; voice notes decoded (real Opus decoder) and transcribed (fake transcriber). No network.

const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const ogg = (bytes: Uint8Array): MediaBytes => ({ bytes: bytes.slice().buffer as ArrayBuffer, contentType: "audio/ogg; codecs=opus" });

/** The photo's list and the voice note's addition, each line pointing at its own message. */
const PHOTO_AND_VOICE = {
  observations: [
    {
      kind: "customer_order",
      lines: [
        line("3 lb arroz", "arroz", "3", "libra", box(0, [0.08, 0.22, 0.6, 0.3])),
        line("dos libras de azúcar", "azúcar", "2", "libra", quote(1, "dos libras de azúcar")),
      ],
      issues: [],
    },
  ],
};

/** Muse Voice Transcribe's place. `during` runs inside a call, as if the call took that long. */
class FakeTranscriber implements Transcriber {
  calls = 0;
  failures = 0;
  during: ((call: number) => Promise<void>) | null = null;

  async transcribe(audio: TranscriberAudio): Promise<Transcript> {
    this.calls++;
    await this.during?.(this.calls);
    if (this.failures > 0) {
      this.failures--;
      throw new Error("transcriber unavailable");
    }
    return { text: TRANSCRIPT, audioDurationMs: audio.durationMs };
  }
}

async function mediaTrip(readings: unknown[]) {
  const store = await seedStore({ members: [] });
  const phone = newPhone();
  const engine = new MemoryEngine(() => [], { catalog: CATALOG });
  const provider = new RecordedProvider(readings);
  const transcriber = new FakeTranscriber();
  const mediaSource = new FakeMediaSource();
  mediaSource.respond = async (id) => {
    if (id.startsWith("voice")) return ogg(toneOgg());
    if (id.startsWith("broken")) return ogg(new TextEncoder().encode("not a voice note"));
    if (id.startsWith("heic")) return { bytes: PHOTO.slice().buffer, contentType: "image/heic" };
    return { bytes: PHOTO.slice().buffer, contentType: "image/jpeg" };
  };
  const h = harness({ engine, modelProvider: provider, mediaSource, transcriber });
  const at = () => ({ from: phone, id: wamid(), timestampS: nowS(h) });
  const photoMsg = (mediaId = "photo-1") => imageMessage({ ...at(), mediaId });
  const voiceMsg = (mediaId = "voice-1") => audioMessage({ ...at(), mediaId });
  const deliver = () => h.deliver(h.takeRingsFor(store.businessId));
  const burst = async (...messages: readonly unknown[]) => {
    h.clock.advance(1_000);
    for (const message of messages) {
      h.clock.advance(200);
      await h.post(webhook(store.phoneNumberId, { messages: [message] }));
    }
    h.clock.advance(SETTLED_MS);
    await deliver();
  };
  /** Lets every retry come due and run. */
  const retries = async (n: number) => {
    for (let i = 0; i < n; i++) {
      h.clock.advance(30_000);
      await deliver();
    }
  };
  const reads = () =>
    rows<{ inbound_message_id: string; read_by_job_id: string }>(
      `SELECT inbound_message_id, read_by_job_id FROM burst_reads WHERE business_id = ?`,
      store.businessId,
    );
  return { h, store, phone, engine, provider, transcriber, burst, deliver, retries, reads, photoMsg, voiceMsg };
}

/** D1's clock can't be moved, so time passing for a lease is the lease's end moving back. */
async function leaseTimePasses(conversationId: string, ms: number): Promise<void> {
  await env.DB.prepare(`UPDATE conversations SET lease_until_ms = lease_until_ms - ? WHERE id = ? AND lease_id IS NOT NULL`)
    .bind(ms, conversationId)
    .run();
}

describe("photos and voice notes in an order", () => {
  it("a photo and a voice note: one model call with both, one reading, one reply", async () => {
    const t = await mediaTrip([PHOTO_AND_VOICE]);
    await t.burst(t.photoMsg(), t.voiceMsg());

    expect(t.transcriber.calls).toBe(1);
    expect(t.provider.requests).toHaveLength(1);
    const images = t.provider.requests[0]!.user.filter((part) => part.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ mimeType: "image/jpeg" });
    expect(new Uint8Array((images[0] as { bytes: ArrayBuffer }).bytes)).toEqual(PHOTO);
    expect(t.provider.textOf(0)).toContain("[0] foto:");
    expect(t.provider.textOf(0)).toContain(`[1] nota de voz (transcripcion): ${JSON.stringify(TRANSCRIPT)}`);

    // One reading saved both messages, and the one reply went out once.
    const reads = await t.reads();
    expect(reads).toHaveLength(2);
    expect(new Set(reads.map((read) => read.read_by_job_id)).size).toBe(1);
    expect(t.h.sentTo(t.phone)).toEqual([ASK_NAME]);
    expect(await rows(`SELECT 1 FROM outbound_messages WHERE business_id = ?`, t.store.businessId)).toHaveLength(1);
    // The voice note's line came from its transcript, the photo's from the photo.
    const [customer] = await rows<{ id: string }>(`SELECT id FROM customers WHERE business_id = ?`, t.store.businessId);
    const context = { businessId: t.store.businessId, customerId: customer!.id, conversationId: "", jobId: "", nowMs: 0 };
    expect((await t.engine.perceptionContext(context)).openOrder?.lines).toHaveLength(2);
    // Logs carry IDs, never the transcript or a media URL.
    expect(t.h.log.lines.join("\n")).not.toMatch(/azúcar|agregale|https?:/i);
  });

  it("a 70-second transcription finishes once: the lease outlasts it, and a second consumer finds it busy", async () => {
    const t = await mediaTrip([PHOTO_AND_VOICE]);
    t.transcriber.during = async (call) => {
      if (call !== 1) return;
      const conversation = await conversationOf(t.store.businessId);
      t.h.clock.advance(70_000);
      await leaseTimePasses(conversation.conversationId, 70_000);
      // Another doorbell for the conversation arrives mid-transcription.
      await t.h.deliver([{ conversation, delaySeconds: 0 }]);
    };
    await t.burst(t.photoMsg(), t.voiceMsg());
    await t.deliver(); // the busy consumer's re-ring: nothing left to do

    expect(t.transcriber.calls).toBe(1);
    expect(t.provider.requests).toHaveLength(1);
    expect(t.h.sentTo(t.phone)).toEqual([ASK_NAME]);
    expect(await t.reads()).toHaveLength(2);
    expect(t.h.log.events()).not.toContain("stale_write_refused");
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ? AND job_state <> 'done'`, t.store.businessId)).toEqual([]);
  });

  it("a lease lost during a transcription still stops the stale consumer: one reading, one reply", async () => {
    const t = await mediaTrip([PHOTO_AND_VOICE]);
    t.transcriber.during = async (call) => {
      if (call !== 1) return;
      const conversation = await conversationOf(t.store.businessId);
      await expireLease(conversation.conversationId); // stalled past even the longer lease
      await t.h.deliver([{ conversation, delaySeconds: 0 }]); // a new consumer takes over and finishes
    };
    await t.burst(t.photoMsg(), t.voiceMsg());

    expect(t.transcriber.calls).toBe(2);
    // The stale consumer stopped before its (paid) model call; the new one read the burst once.
    expect(t.provider.requests).toHaveLength(1);
    expect(t.h.sentTo(t.phone)).toEqual([ASK_NAME]);
    expect(await t.reads()).toHaveLength(2);
    expect(t.h.log.fields("stale_write_refused").map((fields) => fields.reason)).toEqual(["lease_lost"]);
  });

  it("a voice note that can't be transcribed gets the honest reply after the retries; resent, it isn't read twice", async () => {
    const t = await mediaTrip([PHOTO_AND_VOICE]);
    t.transcriber.failures = 3;
    await t.burst(t.photoMsg(), t.voiceMsg("voice-1"));
    await t.retries(3);

    expect(t.transcriber.calls).toBe(3);
    expect(t.provider.requests).toHaveLength(0);
    expect(t.h.sentTo(t.phone)).toEqual(["Perdón, no pude escuchar tu nota de voz. ¿Me la mandás otra vez?"]);
    // Only the voice note counts as read: the photo waits for the customer's next message.
    expect(await t.reads()).toHaveLength(1);

    await t.burst(t.voiceMsg("voice-2"));
    expect(t.transcriber.calls).toBe(4); // the new note only
    expect(t.provider.requests).toHaveLength(1);
    expect(t.provider.requests[0]!.user.filter((part) => part.type === "image")).toHaveLength(1);
    expect(t.provider.textOf(0)).toContain("MENSAJES (2;");
    expect(t.h.sentTo(t.phone)).toEqual(["Perdón, no pude escuchar tu nota de voz. ¿Me la mandás otra vez?", ASK_NAME]);
    expect(await t.reads()).toHaveLength(3);
  });

  it("a broken voice note isn't retried: the honest reply comes at once, with no transcription", async () => {
    const t = await mediaTrip([]);
    await t.burst(t.voiceMsg("broken-1"));

    expect(t.transcriber.calls).toBe(0);
    expect(t.provider.requests).toHaveLength(0);
    expect(t.h.sentTo(t.phone)).toEqual(["Perdón, no pude escuchar tu nota de voz. ¿Me la mandás otra vez?"]);
    expect(t.h.log.fields("burst_media_unreadable")).toEqual([
      expect.objectContaining({ reason: "OggOpusError", outcome: "permanent" }),
    ]);
    expect(t.h.log.events()).not.toContain("job_deferred");
  });

  it("a photo the model can't take gets the matching reply", async () => {
    const t = await mediaTrip([]);
    await t.burst(t.photoMsg("heic-1"));

    expect(t.provider.requests).toHaveLength(0);
    expect(t.h.sentTo(t.phone)).toEqual(["Perdón, no pude leer tu foto. ¿Me la mandás otra vez?"]);
    expect(t.h.log.events()).not.toContain("job_deferred");
  });
});
