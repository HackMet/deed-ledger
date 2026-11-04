import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import firstOrderDeliveryFile from "../demo/recordings/first-order-delivery.json";
import firstOrderFile from "../demo/recordings/first-order.json";
import moreSugarFile from "../demo/recordings/more-sugar.json";
import pickupFile from "../demo/recordings/pickup.json";
import sizeAnswerFile from "../demo/recordings/size-answer.json";
import whenReadyFile from "../demo/recordings/when-ready.json";
import { DEMO_AGENT_ID } from "../demo/agent";
import { demoRuntime } from "../demo/worker";
import { agentIdOf } from "../src/domain/agent-id";
import { readerConfiguration } from "../src/application/perception/agent";
import { SPARK_MODEL } from "../src/integrations/meta/spark";
import { noticeIs, noticeOf, readbackQuantity, refusedForTheOrder } from "../demo/checks.mjs";
import { parseRecordings, recordedPerceptionHandler, recordingsFromBase64, render } from "../demo/recorded-perception";
import type { CustomerContext, Engine, EngineResult, LineMatch } from "../src/application/engine";
import { fixturePerceptionHandler } from "../src/application/engine/fixture-perception-handler";
import { OrderEngine } from "../src/application/engine/order-engine";
import type { JobInput } from "../src/application/ports";
import type { BurstReading } from "../src/domain/contract/observation";
import type { EngineOutcome } from "../src/domain/contract/outcomes";
import { buildRuntime } from "../src/composition";
import { RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { MemoryEngine } from "../src/infrastructure/memory/memory-engine";
import {
  askFulfillment,
  askSize,
  duplicateConfirm,
  firstOrder,
  firstOrderMatches,
  moreSugar,
  orderChanged,
  orderConfirmed,
  orderStatus,
  pickup,
  readback,
  sizeAnswer,
  staleRejected,
  whenReady,
} from "./fixtures/contract";
import { save } from "./helpers/orders";
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
    location: null,
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

/** The reading with its one set_quantity edit aimed at another line label. */
function retarget(reading: BurstReading, ref: string): BurstReading {
  const copy = structuredClone(reading) as unknown as { observations: { edits: { target: { ref: string } }[] }[] };
  copy.observations[0]!.edits[0]!.target.ref = ref;
  return copy as unknown as BurstReading;
}

/** An engine whose every burst answers the given outcome. */
function answering(outcome: EngineOutcome): Engine {
  return { onBurst: async () => ({ outcome, notices: [], commits: [] }) } as unknown as Engine;
}

const noOpenOrder = { openOrder: async () => null };
const clock = { now: () => 1_000 };

describe("demo recordings (K10)", () => {
  it("every file is a fixture, and the copied ones hold the contract fixture unchanged", () => {
    expect(recordings.map((r) => r.source)).toEqual(files.map(() => "fixture"));
    expect(byName("firstOrder").reading).toEqual(firstOrder);
    expect(byName("firstOrder").matches).toEqual(firstOrderMatches);
    // moreSugar is hand-built: the fixture's change aimed at L4, the azúcar of the demo's first order.
    const sugar = byName("moreSugar");
    expect(sugar.reading).toEqual(retarget(moreSugar, "L4"));
    expect(sugar.note).toMatch(/by hand/);
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

describe("the demo's agent id (C11)", () => {
  it("names the recordings, so it differs from the production agent's id (B3)", () => {
    expect(DEMO_AGENT_ID).toMatch(/^[0-9a-f]{8}$/);
    expect(DEMO_AGENT_ID).not.toBe(agentIdOf(readerConfiguration(SPARK_MODEL)));
  });

  it("the demo's engine stamps the demo id on the customer's facts (N3)", async () => {
    const store = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
    const lease = { businessId: store.businessId, conversationId: `conversation-${crypto.randomUUID()}`, leaseId: "lease-1" };
    const v1 = await demoRuntime(env, recordings).deps.jobHandler.handle({ ...input(byName("firstOrder").text), lease });
    expect(v1.commits?.length).toBeGreaterThan(0);
    await save({ outcome: { type: "readback", order: null as never }, notices: [], commits: v1.commits! });
    const stamped = await env.DB.prepare(`SELECT agent_id FROM facts WHERE business_id = ? AND kind = 'order_version'`)
      .bind(store.businessId)
      .all<{ agent_id: string | null }>();
    expect(stamped.results).toEqual([{ agent_id: DEMO_AGENT_ID }]);
  });
});

describe("the demo's change and replies (K10 fix 1)", () => {
  it("moreSugar changes the azúcar line from 2 to 3 on the real engine, and nothing else", async () => {
    const store = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
    const handler = demoRuntime(env, recordings).deps.jobHandler;
    const lease = { businessId: store.businessId, conversationId: `conversation-${crypto.randomUUID()}`, leaseId: "lease-1" };
    const v1 = await handler.handle({ ...input(byName("firstOrder").text), lease });
    expect(v1.commits?.length).toBeGreaterThan(0);
    await save({ outcome: { type: "readback", order: null as never }, notices: [], commits: v1.commits! });
    const v2 = await demoRuntime(env, recordings).deps.jobHandler.handle({ ...input(byName("moreSugar").text), lease });
    const before = v1.replies![0]!.body;
    const after = v2.replies![0]!.body;
    expect(readbackQuantity(before, "dos libras de azúcar")).toBe("2");
    expect(readbackQuantity(after, "dos libras de azúcar")).toBe("3");
    // The other lines read as before: the change touched only the azúcar.
    const others = (reply: string) => reply.split("\n").filter((l) => l.startsWith("• ") && !l.includes("azúcar"));
    expect(others(after)).toEqual(others(before));
  });

  it("reads the unmatched aceite once, with its quantity and the product's words", async () => {
    const store = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
    const handler = demoRuntime(env, recordings).deps.jobHandler;
    const lease = { businessId: store.businessId, conversationId: `conversation-${crypto.randomUUID()}`, leaseId: "lease-1" };
    const v1 = await handler.handle({ ...input(byName("firstOrder").text), lease });
    const lines = v1.replies![0]!.body.split("\n");
    expect(lines).toContain("• 1 aceite clover");
    expect(lines.some((line) => /^• 1 1 /u.test(line))).toBe(false);
  });

  it("answers each outcome in the same words as the fixture perception handler", async () => {
    const outcomes = [askFulfillment, askSize, readback, orderConfirmed, orderStatus, orderChanged, duplicateConfirm, staleRejected];
    for (const outcome of outcomes) {
      const engine = answering(outcome);
      const fixture = await fixturePerceptionHandler({ engine, orders: noOpenOrder, clock }).handle(input("Quiero hacer un pedido"));
      const recorded = await recordedPerceptionHandler({ engine, orders: noOpenOrder, clock, recordings }).handle(input(byName("firstOrder").text));
      expect(recorded.replies?.[0]?.body).toBe(fixture.replies?.[0]?.body);
      expect(recorded.replies?.[0]?.body).toBe(render(outcome));
    }
    expect(render(readback)).toContain("• 2 Azúcar 1 lb");
  });
});

describe("the demo runner's checks (K10 fix 1)", () => {
  it("counts a staff tap as refused for the order only on aviso=estado or aviso=cambio", () => {
    expect(refusedForTheOrder("/console/preparacion?aviso=estado#order-1")).toBe(true);
    expect(refusedForTheOrder("/console/preparacion?aviso=cambio")).toBe(true);
    // A refusal for the key, the actor or a missing order says nothing about the order's state.
    expect(refusedForTheOrder("/console/preparacion?aviso=permiso#order-1")).toBe(false);
    expect(refusedForTheOrder("/console/preparacion?aviso=falta")).toBe(false);
    expect(refusedForTheOrder("/console/preparacion#order-1")).toBe(false);
    expect(refusedForTheOrder("400")).toBe(false);
    expect(refusedForTheOrder(null)).toBe(false);
  });

  it("reads the notice a redirect carries, and tells the adversary's wrong notices apart from the right ones", () => {
    expect(noticeOf("/console/pedidos/o-1?aviso=permiso")).toBe("permiso");
    expect(noticeOf("/console/preparacion/o-1#o-1")).toBeNull();
    expect(noticeOf("400")).toBeNull();
    // A forged key is refused as not_allowed (permiso); a state refusal (estado) is the wrong notice for it.
    expect(noticeIs("/console/pedidos/o-1?aviso=permiso", "permiso")).toBe(true);
    expect(noticeIs("/console/pedidos/o-1?aviso=estado", "permiso")).toBe(false);
    // A duplicate answers with no notice; a notice where none is due is wrong too.
    expect(noticeIs("/console/preparacion/o-1", null)).toBe(true);
    expect(noticeIs("/console/preparacion/o-1?aviso=guardar", null)).toBe(false);
    expect(noticeIs(null, "cambio")).toBe(false);
  });

  it("reads a product's quantity off a readback, null when the line is not there", () => {
    const reply = "Esto entendí de tu pedido:\n• 1 aceite clover\n• 3 Azúcar 1 lb\n¿Lo confirmo? Confirmar / Corregir / Cancelar";
    expect(readbackQuantity(reply, "Azúcar 1 lb")).toBe("3");
    expect(readbackQuantity(reply, "Arroz 1 lb")).toBeNull();
    expect(readbackQuantity(null, "Azúcar 1 lb")).toBeNull();
  });
});
