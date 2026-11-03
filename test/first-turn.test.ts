import { describe, expect, it } from "vitest";
import type { Tenant } from "../src/application/ports";
import type { Observation } from "../src/domain/contract/observation";
import { renderOutcome } from "../src/domain/replies";
import { MemoryEngine } from "../src/infrastructure/memory/memory-engine";

const WHAT_TO_ORDER = "¿Qué te mando? Escribime la lista, mandame una foto o una nota de voz.";

const tenant = (): Tenant => ({ businessId: crypto.randomUUID() });
const contextOf = (t: Tenant, nameAsked = false) => ({
  ...t,
  customerId: "c-1",
  conversationId: "conv-1",
  jobId: crypto.randomUUID(),
  nowMs: 1,
  customerName: null,
  customerNameAsked: nameAsked,
});

async function reply(engine: MemoryEngine, t: Tenant, observations: Observation[], nameAsked = false) {
  const { outcome } = await engine.onBurst(contextOf(t, nameAsked), { observations, calls: [] }, []);
  return renderOutcome(outcome, { customerId: "c-1" })?.body ?? null;
}

const greeting: Observation = { kind: "other", issues: [] } as unknown as Observation;
const name = (value: string): Observation =>
  ({ kind: "customer_name", name: value, evidence: { source: "text", message: 0, start: 0, end: value.length }, issues: [] }) as unknown as Observation;

describe("the first turn, before there's an order", () => {
  it("asks what they want, not their name, when they say they want to order", async () => {
    expect(await reply(new MemoryEngine(() => []), tenant(), [greeting])).toBe(WHAT_TO_ORDER);
  });

  it("answers a customer who gives only their name: never silence", async () => {
    // Even when the name was asked before (an older flow, or a retried job).
    const engine = new MemoryEngine(() => []);
    const t = tenant();
    expect(await reply(engine, t, [name("Angel Rodas")], true)).toBe(WHAT_TO_ORDER);
    expect(await reply(engine, t, [name("Angel Rodas")], false)).toBe(WHAT_TO_ORDER);
  });
});
