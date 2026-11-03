import { env } from "cloudflare:workers";
import type { BurstMediaResolver } from "../../src/application/order-reading";
import type { ModelProvider, ModelRequest } from "../../src/application/ports";
import { D1StoreSetupRepository } from "../../src/infrastructure/d1/store-setup-repository";
import { D1PretendEngine } from "../../src/infrastructure/memory/d1-pretend-engine";
import { harness, testEnv } from "./harness";
import { newPhone, seedStore } from "./seed";
import { audioMessage, textMessage, wamid, webhook } from "./whatsapp";

/** A recorded answer: fixed JSON, or JSON built from what the model was sent (to check it got the context). */
export type Recorded = unknown | ((request: ModelRequest, text: string) => unknown);

/** Answers each call by its schema, in order. Never the network. */
export class RecordedProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  readonly requests: ModelRequest[] = [];
  constructor(private readonly answers: Record<string, Recorded[]>) {}
  async complete(request: ModelRequest) {
    this.requests.push(request);
    const next = (this.answers[request.schemaName] ?? []).shift();
    if (next === undefined) throw new Error(`no recorded ${request.schemaName} left`);
    const text = request.user.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    const json = typeof next === "function" ? (next as (r: ModelRequest, t: string) => unknown)(request, text) : next;
    return { ok: true, json, latencyMs: 3_000, inputTokens: 4_000, outputTokens: 700 } as const;
  }
  textOf(n: number): string {
    return this.requests[n]!.user.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  }
}

export interface StoreProductSpec {
  readonly name: string;
  readonly price: number | null;
  readonly soldBy?: "unit" | "weight";
  readonly noHay?: boolean;
}

/**
 * A planner-mode store on local D1 (products set up as the owner would), one introduced customer
 * whose name was asked before, and the real Worker with recorded model answers.
 */
export async function plannerStore(
  products: readonly StoreProductSpec[],
  answers: Record<string, Recorded[]>,
  options: { readonly fastText?: boolean; readonly transcript?: string } = {},
) {
  const store = await seedStore({ members: [] });
  const tenant = { businessId: store.businessId };
  const phone = newPhone();
  const customerId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO customers (id, business_id, phone, created_at_ms, introduced_at_ms, name_asked_at_ms) VALUES (?, ?, ?, 0, 1, 1)`)
    .bind(customerId, store.businessId, phone)
    .run();
  const setup = new D1StoreSetupRepository(env.DB);
  for (const p of products) await setup.addProduct(tenant, { name: p.name, otherNames: [], price: p.price }, 1);
  const saved = await setup.listProducts(tenant);
  for (const p of products) {
    const product = saved.find((s) => s.name === p.name)!;
    if (p.soldBy !== undefined) await setup.updateProduct(tenant, product.productId, { name: product.name, otherNames: [], price: product.price }, 2, { soldBy: p.soldBy, usualQuantity: null });
    if (p.noHay === true) await setup.setNoHay(tenant, product.productId, true, 3);
  }
  const provider = new RecordedProvider(answers);
  const media: BurstMediaResolver = { async resolve() { return { type: "transcript", text: options.transcript ?? "" }; } };
  const h = harness({
    engine: new D1PretendEngine(env.DB, { setup }),
    modelProvider: provider,
    burstMedia: media,
    env: testEnv({ CONVERSATION: "planner", PLANNER_FAST_TEXT: options.fastText === false ? "0" : "1" } as unknown as Partial<Env>),
  });
  const at = () => ({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000) });
  const send = async (message: unknown) => {
    h.clock.advance(1_000);
    await h.post(webhook(store.phoneNumberId, { messages: [message] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
  };
  return {
    h,
    store,
    tenant,
    phone,
    customerId,
    provider,
    say: (body: string) => send(textMessage({ ...at(), body })),
    voice: () => send(audioMessage({ ...at(), mediaId: "voice" })),
    replies: () => h.sentTo(phone),
    last: () => h.sentTo(phone).at(-1) ?? "",
  };
}
