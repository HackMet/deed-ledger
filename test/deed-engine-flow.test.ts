/**
 * DEED_ENGINE=1 end to end: Angel's real reader reads a customer's text burst (a recorded Muse Spark
 * answer, no network) and the order engine answers it. Each order step saves one fact.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "../src/application/ports";
import { line, quote } from "./fixtures/model/recorded";
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

async function setUp(readings: unknown[]) {
  const store = await seedStore({ members: [] });
  const phone = newPhone();
  const customerId = await seedIntroducedCustomer(store, phone);
  await env.DB.prepare(`UPDATE customers SET name = 'Ana', name_saved_at_ms = 1 WHERE id = ?`).bind(customerId).run();
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
  return { h, store, phone, say, factKinds };
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
