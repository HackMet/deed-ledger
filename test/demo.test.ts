import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import firstOrderDeliveryFile from "../demo/recordings/first-order-delivery.json";
import firstOrderFile from "../demo/recordings/first-order.json";
import moreSugarFile from "../demo/recordings/more-sugar.json";
import pickupFile from "../demo/recordings/pickup.json";
import sizeAnswerFile from "../demo/recordings/size-answer.json";
import whenReadyFile from "../demo/recordings/when-ready.json";
import { demoRuntime } from "../demo/worker";
import { parseRecordings, recordedPerceptionHandler, recordingsFromBase64 } from "../demo/recorded-perception";
import type { CustomerContext, Engine, EngineResult, LineMatch } from "../src/application/engine";
import { fixturePerceptionHandler } from "../src/application/engine/fixture-perception-handler";
import { OrderEngine } from "../src/application/engine/order-engine";
import type { JobInput } from "../src/application/ports";
import type { BurstReading } from "../src/domain/contract/observation";
import { buildRuntime } from "../src/composition";
import { RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { MemoryEngine } from "../src/infrastructure/memory/memory-engine";
import { firstOrder, firstOrderMatches, moreSugar, pickup, sizeAnswer, whenReady } from "./fixtures/contract";
import { newPhone, seedStore } from "./helpers/seed";

const files: readonly unknown[] = [firstOrderFile, firstOrderDeliveryFile, moreSugarFile, pickupFile, sizeAnswerFile, whenReadyFile];
const recordings = parseRecordings(files);
const byName = (name: string) => recordings.find((r) => r.name === name)!;

const input = (textBody: string | null, over: Partial<JobInput["job"]> = {}): JobInput => ({
  lease: { businessId: "store-demo", conversationId: "conversation-a", leaseId: "lease-1" },
  job: {
    id: crypto.randomUUID(),
    kind: "text",
    textBody,
    replyId: null,
    contextMessageId: null,
    mediaAssetId: null,
    orderTsS: 0,
    receivedAtMs: 0,
    attempts: 0,
    retryAfterMs: null,
    ...over,
  },
  isNewestOfBurst: true,
});

/** An engine that records what perception handed it and answers a fixed readback. */
function spyEngine() {
  const bursts: { context: CustomerContext; reading: BurstReading; matches: readonly LineMatch[] }[] = [];
  const engine = {
    async onBurst(context: CustomerContext, reading: BurstReading, matches: readonly LineMatch[]): Promise<EngineResult> {
      bursts.push({ context, reading, matches });
      return { outcome: { type: "ask", question: "pickup_or_delivery", line: null, order: null }, notices: [], commits: [] };
    },
  } as unknown as Engine;
  return { engine, bursts };
}

const noOpenOrder = { openOrder: async () => null };
const clock = { now: () => 1_000 };

describe("demo recordings (K10)", () => {
  it("every file is a fixture, and the copied ones hold the contract fixture unchanged", () => {
    expect(recordings.map((r) => r.source)).toEqual(files.map(() => "fixture"));
    expect(byName("firstOrder").reading).toEqual(firstOrder);
    expect(byName("firstOrder").matches).toEqual(firstOrderMatches);
    expect(byName("moreSugar").reading).toEqual(moreSugar);
    expect(byName("pickup").reading).toEqual(pickup);
    expect(byName("sizeAnswer").reading).toEqual(sizeAnswer);
    expect(byName("whenReady").reading).toEqual(whenReady);
    // The delivery reading is hand-built: the first order plus a delivery fulfillment, said so in its note.
    const delivery = byName("firstDeliveryOrder");
    expect(delivery.reading.observations.slice(0, -1)).toEqual(firstOrder.observations);
    expect(delivery.reading.observations.at(-1)).toMatchObject({ kind: "fulfillment", mode: "delivery" });
    expect(delivery.note).toMatch(/by hand/);
  });

  it("a malformed recording is refused, not skipped", () => {
    expect(() => parseRecordings([{ ...firstOrderFile, source: "guess" }])).toThrow(/source/);
    expect(() => parseRecordings([{ ...firstOrderFile, reading: { observations: [] } }])).toThrow(/reading/);
    expect(() => parseRecordings([{ ...firstOrderFile, matches: [{ observation: 0 }] }])).toThrow(/matches/);
    expect(() => recordedPerceptionHandler({ engine: spyEngine().engine, orders: noOpenOrder, clock, recordings: [...recordings, byName("pickup")] })).toThrow(
      /same text/,
    );
  });
});

describe("recorded perception (K10)", () => {
  it("hands the engine the recorded reading and matches for each scripted text", async () => {
    for (const recording of recordings) {
      const { engine, bursts } = spyEngine();
      const handler = recordedPerceptionHandler({ engine, orders: noOpenOrder, clock, recordings });
      // The customer's own spacing, case and accents don't change which recording answers.
      const said = `  ${recording.text.toUpperCase()}  `;
      const outcome = await handler.handle(input(said));
      expect(bursts).toHaveLength(1);
      expect(bursts[0]!.reading).toBe(recording.reading);
      expect(bursts[0]!.matches).toBe(recording.matches);
      expect(bursts[0]!.context).toMatchObject({ businessId: "store-demo", customerId: "conversation-a", conversationId: "conversation-a" });
      expect(outcome.replies?.[0]?.body).toBe("¿Lo pasás a traer o te lo llevamos?");
    }
  });

  it("answers anything else with the placeholder, never a guess", async () => {
    for (const said of ["Quiero hacer un pedido", "mejor que sean 4 libras de azúcar", "hola", ""]) {
      const { engine, bursts } = spyEngine();
      const outcome = await recordedPerceptionHandler({ engine, orders: noOpenOrder, clock, recordings }).handle(input(said));
      expect(bursts).toHaveLength(0);
      expect(outcome).toEqual({ replies: [{ body: RECEIVED_PLACEHOLDER, ttlMs: expect.any(Number), closesBurst: true }] });
    }
    const { engine, bursts } = spyEngine();
    const photo = await recordedPerceptionHandler({ engine, orders: noOpenOrder, clock, recordings }).handle(input(null, { kind: "image" }));
    expect(bursts).toHaveLength(0);
    expect(photo.replies?.[0]?.body).toBe(RECEIVED_PLACEHOLDER);
  });

  it("leaves confirmar and cancelar to the fixture handler's exact words", async () => {
    for (const said of ["confirmar", "Cancelar."]) {
      const { engine, bursts } = spyEngine();
      const recorded = await recordedPerceptionHandler({ engine, orders: noOpenOrder, clock, recordings }).handle(input(said));
      const fixture = await fixturePerceptionHandler({ engine, orders: noOpenOrder, clock }).handle(input(said));
      expect(bursts).toHaveLength(0);
      expect(recorded).toEqual(fixture);
      expect(recorded.replies?.[0]?.body).toMatch(/No tengo un pedido abierto/);
    }
  });

  it("loads a muse recording unchanged, and it replaces the fixture for the same text", async () => {
    const museFile = {
      source: "muse",
      name: "moreSugarFromMuse",
      text: "Mejor que sean 3 libras de azúcar",
      reading: { ...moreSugar, calls: [{ model: "muse-spark-1.3", promptVersion: "order-v2", latencyMs: 1400, inputTokens: 900, outputTokens: 120 }] },
      matches: [],
    };
    const [muse] = parseRecordings([structuredClone(museFile)]);
    expect(muse).toEqual(museFile);

    const { engine, bursts } = spyEngine();
    const handler = recordedPerceptionHandler({ engine, orders: noOpenOrder, clock, recordings: [...recordings, muse!] });
    await handler.handle(input("mejor que sean 3 libras de azúcar"));
    expect(bursts[0]!.reading).toBe(muse!.reading);
  });

  it("reads the runner's DEMO_RECORDINGS (base64 of a UTF-8 JSON array)", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(files));
    const encoded = btoa(String.fromCharCode(...bytes));
    expect(recordingsFromBase64(encoded)).toEqual(recordings);
    expect(recordingsFromBase64("")).toEqual([]);
    expect(recordingsFromBase64(undefined)).toEqual([]);
  });
});

describe("the demo runtime (K10)", () => {
  it("runs the real OrderEngine, not the pretend one, even with DEV_CONSOLE set", () => {
    const runtime = demoRuntime(env, recordings);
    expect(runtime.engine).toBeInstanceOf(OrderEngine);
    expect(runtime.engine).not.toBeInstanceOf(MemoryEngine);
    expect(demoRuntime({ ...env, DEV_CONSOLE: "1" } as unknown as Env, recordings).engine).toBeInstanceOf(OrderEngine);
  });

  it("its job handler is the recorded one: a recorded text reaches the engine on D1", async () => {
    const store = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
    const job = { ...input(byName("firstOrder").text), lease: { businessId: store.businessId, conversationId: "conversation-demo", leaseId: "lease-1" } };
    const outcome = await demoRuntime(env, recordings).deps.jobHandler.handle(job);
    expect(outcome.replies?.[0]?.body).toMatch(/^Esto entendí de tu pedido:/);
    expect(outcome.commits?.length).toBeGreaterThan(0);
    // The app's default handler does not know this text.
    const appDefault = await buildRuntime(env).deps.jobHandler.handle(job);
    expect(appDefault.replies?.[0]?.body).toBe(RECEIVED_PLACEHOLDER);
  });
});
