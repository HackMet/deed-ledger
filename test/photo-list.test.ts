import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { BurstMediaResolver } from "../src/application/order-reading";
import type { ModelProvider, ModelRequest } from "../src/application/ports";
import { MemoryEngine } from "../src/infrastructure/memory/memory-engine";
import { box, line, photo } from "./fixtures/model/recorded";
import { ensureLinesTable } from "./helpers/engines";
import { harness } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { imageMessage, wamid, webhook } from "./helpers/whatsapp";

/**
 * A photo of a handwritten list of 11 items, none with a quantity, the last one cut by the photo's
 * bottom edge (scripts/sim-media/lista-once.jpg). The model's reading is recorded; no network.
 * Bug (Nov 2): a real 11-item list was answered "Anotado ✅ tus 10 productos" and nothing said one
 * was missing. Every line the reader returns must reach the order, and a line it could only partly
 * read must be asked about, never dropped.
 */
const ITEMS = ["arroz", "frijoles", "azucar", "cafe", "leche", "huevos", "jabon", "pan", "aceite", "cebolla", "sal"];
const rowBox = (i: number) => box(0, [0.1, 0.12 + i * 0.07, 0.5, 0.18 + i * 0.07]);

const reading = (lines: unknown[], issues: unknown[] = []) => ({
  observations: [{ kind: "customer_order", lines, issues }],
});
const allLines = () => ITEMS.map((item, i) => line(item, item, null, null, rowBox(i)));

class RecordedProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  constructor(private readonly json: unknown) {}
  async complete(_request: ModelRequest) {
    return { ok: true, json: this.json, latencyMs: 7_000, inputTokens: 3_950, outputTokens: 1_500 } as const;
  }
}

const media: BurstMediaResolver = { async resolve() { return photo(); } };

beforeAll(ensureLinesTable);

async function send(json: unknown): Promise<string[]> {
  const store = await seedStore({ members: [] });
  const phone = newPhone();
  await env.DB.prepare(`INSERT INTO customers (id, business_id, phone, created_at_ms, introduced_at_ms) VALUES (?, ?, ?, 0, 1)`)
    .bind(crypto.randomUUID(), store.businessId, phone)
    .run();
  const h = harness({ engine: new MemoryEngine(() => [], { catalog: [] }), modelProvider: new RecordedProvider(json), burstMedia: media });
  h.clock.advance(1_000);
  await h.post(webhook(store.phoneNumberId, { messages: [imageMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), mediaId: "list" })] }));
  h.clock.advance(4_000);
  await h.deliver(h.takeRingsFor(store.businessId));
  return h.sentTo(phone).map((sent) => String(sent));
}

describe("a photo of a list with no quantities", () => {
  it("every line the reader returns reaches the order", async () => {
    const [reply] = await send(reading(allLines()));
    // Each of the 11 is named once, on its own line of the quantities question.
    const named = reply!.split("\n").filter((row) => row.startsWith("• "));
    expect(named).toEqual(ITEMS.map((item) => `• ${item.charAt(0).toUpperCase()}${item.slice(1)}`));
  });

  it("a line cut by the photo's edge, read as illegible, is asked about and kept", async () => {
    const lines = allLines();
    lines[10] = line("sa", "sa", null, null, box(0, [0.1, 0.94, 0.3, 1]));
    const [reply] = await send(reading(lines, [{ code: "illegible", line: 10, evidence: box(0, [0.1, 0.94, 0.3, 1]) }]));
    expect(reply).toMatch(/No alcancé a leer bien sa/);
  });

  it("a line whose box runs past the photo's edge is not dropped without a word", async () => {
    const lines = allLines();
    lines[10] = line("sal", "sal", null, null, box(0, [0.1, 0.94, 0.3, 1.03]));
    const replies = await send(reading(lines));
    // The ten read still need amounts (four by name, the rest counted), the eleventh is asked about.
    expect(replies).toEqual(["Me falta saber cuánto querés de arroz, frijoles, azucar, cafe y 6 más.\n\nNo alcancé a leer bien sal. ¿Me lo escribís?"]);
  });
});
