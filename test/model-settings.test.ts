/**
 * Muse Spark settings per call site (reader, planner): reasoning effort and the prompt cache. Each
 * setting reaches the request body only as a value Meta lists ("none" never does), the reservation
 * against the daily cap doesn't depend on the effort, the fixed instructions are the same bytes on
 * every call, and the logs carry the usage counts. No network.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { boundMicroUsd, meteredCall } from "../src/application/metered-call";
import type { ModelCallSettings } from "../src/application/model-settings";
import { BurstReader } from "../src/application/perception/reader";
import { plannerInstructions } from "../src/application/planner/instructions";
import { PlannerModel } from "../src/application/planner/plan-turn";
import type { ModelProvider, ModelRequest, ModelResult, SpendLedger, SpendReservation, Tenant } from "../src/application/ports";
import { buildBurstReader } from "../src/composition";
import { DEFAULT_PLANNER_EFFORT, DEFAULT_READER_EFFORT, readConfig } from "../src/infrastructure/config";
import { D1PretendEngine } from "../src/infrastructure/memory/d1-pretend-engine";
import { MuseSparkProvider } from "../src/integrations/meta/spark";
import * as contract from "./fixtures/contract";
import { catalog, line, noContext, quote, text } from "./fixtures/model/recorded";
import { FakeClock, RecordingLogger } from "./helpers/fakes";
import { harness, testEnv } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

const tenant: Tenant = { businessId: "store-settings" };

const request = (more: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "fijo",
  user: [{ type: "text", text: "hola" }],
  schemaName: "Thing",
  schema: { type: "object" },
  maxOutputTokens: 1_000,
  ...more,
});

/** Muse Spark over a fetch that keeps each body and answers with the given usage. Never the network. */
function sparkWithBodies(usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 5 }) {
  const bodies: Record<string, unknown>[] = [];
  const provider = new MuseSparkProvider({
    apiKey: "test-model-key-not-real",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "{}" } }], usage });
    },
  });
  return { provider, bodies };
}

/** A provider that keeps each request as the application sent it. */
class RecordingProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  readonly requests: ModelRequest[] = [];
  constructor(private readonly answers: unknown[] = []) {}
  async complete(sent: ModelRequest): Promise<ModelResult> {
    this.requests.push(sent);
    return { ok: true, json: this.answers.shift() ?? {}, latencyMs: 1, inputTokens: 100, outputTokens: 50 };
  }
}

/** A ledger that admits everything and remembers what was reserved and settled. */
class OpenLedger implements SpendLedger {
  readonly reserved: number[] = [];
  readonly settled: number[] = [];
  async reserve(t: Tenant, _nowMs: number, microUsd: number): Promise<SpendReservation> {
    this.reserved.push(microUsd);
    return { businessId: t.businessId, day: "2026-11-02", microUsd };
  }
  async settle(_reservation: SpendReservation, actualMicroUsd: number): Promise<void> {
    this.settled.push(actualMicroUsd);
  }
}

const deps = (provider: ModelProvider, settings?: ModelCallSettings) => ({
  provider,
  spend: new OpenLedger(),
  clock: new FakeClock(),
  log: new RecordingLogger(),
  ...(settings === undefined ? {} : { settings }),
});

describe("the request body", () => {
  it("carries the effort and the cache key and retention, named as Meta names them", async () => {
    const { provider, bodies } = sparkWithBodies();
    await provider.complete(request({ reasoningEffort: "low", promptCacheKey: "planner:base@1", promptCacheRetention: "in_memory" }));
    expect(bodies[0]).toMatchObject({ reasoning_effort: "low", prompt_cache_key: "planner:base@1", prompt_cache_retention: "in_memory" });
  });

  it("leaves each one out when it isn't set, so Meta's defaults apply", async () => {
    const { provider, bodies } = sparkWithBodies();
    await provider.complete(request());
    expect(Object.keys(bodies[0]!).sort()).toEqual(["max_tokens", "messages", "model", "response_format"]);
  });

  it("never sends 'none' (Muse Spark answers 400) or any value Meta doesn't list", async () => {
    const { provider, bodies } = sparkWithBodies();
    for (const effort of ["none", "NONE", "", "turbo"]) {
      await provider.complete(request({ reasoningEffort: effort as never, promptCacheRetention: "forever" as never }));
    }
    for (const body of bodies) {
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("prompt_cache_retention");
    }
  });

  it("reads reasoning and cached token counts when Meta reports them", async () => {
    const { provider } = sparkWithBodies({
      prompt_tokens: 4_000,
      completion_tokens: 900,
      prompt_tokens_details: { cached_tokens: 3_072 },
      completion_tokens_details: { reasoning_tokens: 700 },
    });
    expect(await provider.complete(request())).toMatchObject({ ok: true, inputTokens: 4_000, outputTokens: 900, cachedTokens: 3_072, reasoningTokens: 700 });
  });
});

describe("worker settings", () => {
  const settingsOf = (vars: Record<string, string>) => readConfig(testEnv(vars as unknown as Partial<Env>));
  const planner = { CONVERSATION: "planner" };

  it("blank variables give the measured defaults on the planner path, with no cache retention", () => {
    expect([DEFAULT_READER_EFFORT, DEFAULT_PLANNER_EFFORT]).toEqual(["low", "minimal"]);
    const config = settingsOf(planner);
    expect(config.readerModel).toEqual({ reasoningEffort: "low" });
    expect(config.plannerModel).toEqual({ reasoningEffort: "minimal" });
  });

  it("the classic path's reader keeps the model's own effort unless the variable sets one", () => {
    expect(settingsOf({}).readerModel).toEqual({});
    expect(settingsOf({ READER_REASONING_EFFORT: "medium" }).readerModel).toEqual({ reasoningEffort: "medium" });
  });

  it("takes each of Meta's efforts per call, and 'default' sends none", () => {
    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      const config = settingsOf({ ...planner, READER_REASONING_EFFORT: effort, PLANNER_REASONING_EFFORT: "default", PROMPT_CACHE_RETENTION: "24h" });
      expect(config.readerModel).toEqual({ reasoningEffort: effort, promptCacheRetention: "24h" });
      expect(config.plannerModel).toEqual({ promptCacheRetention: "24h" });
    }
  });

  it("'none' or a typo falls back to the default, never to 'none'", () => {
    for (const effort of ["none", "None", "lo", "fast"]) {
      const config = settingsOf({ ...planner, READER_REASONING_EFFORT: effort, PLANNER_REASONING_EFFORT: effort, PROMPT_CACHE_RETENTION: "forever" });
      expect(config.readerModel).toEqual({ reasoningEffort: "low" });
      expect(config.plannerModel).toEqual({ reasoningEffort: "minimal" });
      expect(settingsOf({ READER_REASONING_EFFORT: effort }).readerModel).toEqual({});
    }
  });
});

describe("the metered call", () => {
  it("sends the call site's settings and reserves the same bound at every effort", async () => {
    const reserved: number[] = [];
    for (const settings of [undefined, { reasoningEffort: "minimal" }, { reasoningEffort: "low" }, { reasoningEffort: "xhigh" }] as const) {
      const provider = new RecordingProvider();
      const d = deps(provider, settings);
      await meteredCall(d, tenant, request({ promptCacheKey: "k" }), { promptVersion: "v", logPrefix: "planner" });
      expect(provider.requests[0]!.promptCacheKey).toBe("k");
      expect(provider.requests[0]!.reasoningEffort).toBe(settings?.reasoningEffort);
      reserved.push(...d.spend.reserved);
      // What was spent, not the reservation: 100 in and 50 out at list prices.
      expect(d.spend.settled).toEqual([Math.ceil(100 * 1.25 + 50 * 4.25)]);
    }
    expect(new Set(reserved)).toEqual(new Set([boundMicroUsd(request({ promptCacheKey: "k" }))]));
  });

  it("logs the effort and the usage counts, never content", async () => {
    const { provider } = sparkWithBodies({
      prompt_tokens: 4_000,
      completion_tokens: 900,
      prompt_tokens_details: { cached_tokens: 3_072 },
      completion_tokens_details: { reasoning_tokens: 700 },
    });
    const d = deps(provider, { reasoningEffort: "low" });
    await meteredCall(d, tenant, request({ user: [{ type: "text", text: "me manda arroz" }] }), { promptVersion: "v", logPrefix: "planner" });
    expect(d.log.fields("planner.model_call")).toEqual([
      expect.objectContaining({ outcome: "ok", effort: "low", inputTokens: 4_000, cachedTokens: 3_072, outputTokens: 900, reasoningTokens: 700 }),
    ]);
    expect(d.log.lines.join("\n")).not.toContain("arroz");
  });
});

describe("cache-friendly instructions", () => {
  it("the planner's system prompt is the same bytes for every store and message, keyed by its version", async () => {
    const provider = new RecordingProvider();
    const planner = new PlannerModel(deps(provider));
    await planner.propose({ businessId: "store-a" }, [{ type: "text", text: "TIENDA: Pulperia Ana\nxq-unico-1" }]);
    await planner.propose({ businessId: "store-b" }, [{ type: "text", text: "TIENDA: Mercadito Johan\nxq-unico-2" }]);
    const [first, second] = provider.requests;
    expect(second!.system).toBe(first!.system);
    expect(first!.system).toBe(plannerInstructions().system);
    expect(first!.system).not.toMatch(/store-a|Pulperia|Johan|xq-unico/);
    expect(first!.promptCacheKey).toBe(plannerInstructions().version);
    expect(first!.promptCacheKey).toMatch(/^planner:base@[0-9a-f]{8}\+mercadito@[0-9a-f]{8}$/);
    expect(second!.promptCacheKey).toBe(first!.promptCacheKey);
  });

  it("the reader keys each fixed prompt by its version, never by store or message", async () => {
    const provider = new RecordingProvider();
    const reader = new BurstReader(deps(provider));
    await reader.read({ businessId: "store-a" }, { audience: "customer", messages: [text("arroz")], context: noContext, catalog, withoutLabels: true });
    await reader.read({ businessId: "store-b" }, { audience: "customer", messages: [text("frijoles")], context: noContext, catalog, withoutLabels: true });
    await reader.read({ businessId: "store-a" }, { audience: "customer", messages: [text("arroz")], context: noContext, catalog });
    await reader.read({ businessId: "store-a" }, { audience: "console", messages: [text("vendi 2 arroz")], context: contract.packingContext, catalog });
    expect(provider.requests.map((r) => r.promptCacheKey)).toEqual(["reader:order-v2-nopick-names", "reader:order-v2-nopick-names", "reader:order-v2", "reader:console-v1"]);
    expect(provider.requests[1]!.system).toBe(provider.requests[0]!.system);
  });
});

describe("the order path, from the Worker's variables", () => {
  it("the reader and the planner each send their own effort; the console's reader keeps Meta's default", async () => {
    const store = await seedStore({ members: [] });
    const phone = newPhone();
    await env.DB.prepare(`INSERT INTO customers (id, business_id, phone, created_at_ms, introduced_at_ms, name_asked_at_ms) VALUES (?, ?, ?, 0, 1, 1)`)
      .bind(crypto.randomUUID(), store.businessId, phone)
      .run();
    const said = "2 libras de arroz";
    const provider = new RecordingProvider([
      // Planner-mode reader schema: every line carries other_names.
      { observations: [{ kind: "customer_order", lines: [{ ...line(said, "arroz", "2", "libra", quote(0, said)), other_names: [] }], issues: [] }] },
      { ops: [], move: "ask", ask: { kind: "fulfillment", lines: [] }, say: "" },
    ]);
    // The two-call path (a text burst would otherwise be read and planned in one call, D-52).
    const vars = { CONVERSATION: "planner", PLANNER_FAST_TEXT: "0", READER_REASONING_EFFORT: "low", PLANNER_REASONING_EFFORT: "minimal", PROMPT_CACHE_RETENTION: "in_memory" };
    const engine = new D1PretendEngine(env.DB, { catalog: [{ productId: "p-arroz", names: ["Arroz 1 lb"], aliases: [], barcode: null, price: 1800 }] });
    const h = harness({ engine, modelProvider: provider, env: testEnv(vars as unknown as Partial<Env>) });

    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body: said })] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));

    expect(provider.requests.map((r) => [r.schemaName, r.reasoningEffort, r.promptCacheRetention, r.promptCacheKey])).toEqual([
      ["BurstReading", "low", "in_memory", "reader:order-v2-nopick-names"],
      ["TurnProposal", "minimal", "in_memory", plannerInstructions().version],
    ]);
    expect(h.log.fields("planner.model_call")).toEqual([expect.objectContaining({ effort: "minimal", inputTokens: 100, outputTokens: 50 })]);

    const consoleProvider = new RecordingProvider();
    const consoleReader = buildBurstReader(testEnv(vars as unknown as Partial<Env>), { clock: new FakeClock(), log: new RecordingLogger() }, { provider: consoleProvider });
    await consoleReader.read({ businessId: store.businessId }, { audience: "console", messages: [text("vendi 2 arroz")], context: contract.packingContext, catalog });
    expect(consoleProvider.requests[0]).not.toHaveProperty("reasoningEffort");
  });
});
