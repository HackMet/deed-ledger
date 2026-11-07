/**
 * A photo's caption is part of what the customer said (found by the latency lane, Nov 2): it
 * reaches the reader as its own text message right after the photo, quoted as data like any other
 * message, on the classic path and the planner path alike. Recorded model answers, no network: the
 * recorded reader reports pickup only when the caption is in what it was sent.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BurstMediaResolver } from "../src/application/order-reading";
import type { ModelProvider, ModelRequest } from "../src/application/ports";
import { D1PretendEngine } from "../src/infrastructure/memory/d1-pretend-engine";
import { MemoryEngine, type PretendProduct } from "../src/infrastructure/memory/memory-engine";
import { box, line, photo } from "./fixtures/model/recorded";
import { harness, testEnv } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { imageMessage, wamid, webhook } from "./helpers/whatsapp";

const CATALOG: readonly PretendProduct[] = [{ productId: "p-arroz", names: ["Arroz 1 lb"], aliases: ["arroz"], barcode: null, price: 1800 }];
const CAPTION = "lo paso a traer";

/** Reads the list from the photo, and pickup only if the caption came with it, as its own message. */
class CaptionAwareProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  readonly requests: ModelRequest[] = [];
  async complete(request: ModelRequest) {
    this.requests.push(request);
    if (request.schemaName === "TurnProposal") {
      return this.answer({ ops: [{ op: "add", line: "N1", product: "P1", quantity: "3", suggested_quantity: null }], move: "readback", ask: { kind: "none", lines: [] }, say: "" });
    }
    const texts = request.user.flatMap((part) => (part.type === "text" ? [part.text] : []));
    const captioned = texts.some((text) => text === `[1] texto: ${JSON.stringify(CAPTION)}`);
    const otherNames = (request.schema as { properties: { observations: { items: { anyOf: { properties: Record<string, unknown> }[] } } } }).properties.observations.items.anyOf[0]!
      .properties.lines as { items: { properties: Record<string, unknown> } };
    const more = "other_names" in otherNames.items.properties ? { other_names: [] } : {};
    return this.answer({
      observations: [
        { kind: "customer_order", lines: [line("3 arroz", "arroz", "3", null, box(0, [0.1, 0.1, 0.6, 0.2]), more)], issues: [] },
        ...(captioned ? [{ kind: "fulfillment", mode: "pickup", place_text: null, same_as_before: false, issues: [] }] : []),
      ],
    });
  }
  private answer(json: unknown) {
    return { ok: true, json, latencyMs: 1_000, inputTokens: 1_000, outputTokens: 200 } as const;
  }
}

const media: BurstMediaResolver = { async resolve() { return photo(); } };

async function photoWithCaption(conversation: "classic" | "planner") {
  const store = await seedStore({ members: [] });
  const phone = newPhone();
  await env.DB.prepare(`INSERT INTO customers (id, business_id, phone, created_at_ms, introduced_at_ms, name_asked_at_ms) VALUES (?, ?, ?, 0, 1, 1)`)
    .bind(crypto.randomUUID(), store.businessId, phone)
    .run();
  const provider = new CaptionAwareProvider();
  const engine = conversation === "planner" ? new D1PretendEngine(env.DB, { catalog: CATALOG }) : new MemoryEngine(() => [], { catalog: CATALOG });
  const h = harness({ engine, modelProvider: provider, burstMedia: media, env: testEnv({ CONVERSATION: conversation } as unknown as Partial<Env>) });
  h.clock.advance(1_000);
  await h.post(webhook(store.phoneNumberId, { messages: [imageMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), mediaId: "list", caption: CAPTION })] }));
  h.clock.advance(4_000);
  await h.deliver(h.takeRingsFor(store.businessId));
  return { replies: h.sentTo(phone), reader: provider.requests[0]! };
}

describe("a photo's caption", () => {
  it.each(["classic", "planner"] as const)("reaches the reader right after the photo, so 'lo paso a traer' is never asked again (%s)", async (conversation) => {
    const { replies, reader } = await photoWithCaption(conversation);
    const parts = reader.user.map((part) => (part.type === "text" ? part.text : "<image>"));
    expect(parts.slice(-3)).toEqual(["[0] foto:", "<image>", `[1] texto: ${JSON.stringify(CAPTION)}`]);
    expect(replies.at(-1)).toContain("Lo pasás a traer a la tienda.");
    expect(replies.at(-1)).not.toContain("¿Lo recogés en la tienda o te lo llevamos?");
  });
});
