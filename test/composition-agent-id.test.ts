import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { buildRuntime } from "../src/composition";
import { readerConfiguration } from "../src/application/perception/agent";
import { agentIdOf, type AgentConfiguration } from "../src/domain/agent-id";
import { SPARK_MODEL } from "../src/integrations/meta/spark";
import { firstOrder } from "./fixtures/contract";
import { newStore, save } from "./helpers/orders";

// Counts every hash of a configuration. composition.ts hashes once when the module loads (B2), so after the
// import the count must not move while runtimes are built.
const hashes = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/domain/agent-id", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/domain/agent-id")>();
  return {
    ...actual,
    agentIdOf: (configuration: AgentConfiguration) => {
      hashes.count++;
      return actual.agentIdOf(configuration);
    },
  };
});

const PRODUCTION_ID = () => agentIdOf(readerConfiguration(SPARK_MODEL));
const deedEnv = { ...env, DEED_ENGINE: "1" } as unknown as Env;

describe("C11: the agent id is computed once, when the Worker starts (B2)", () => {
  it("hashes once when composition loads, and not again for each runtime built", async () => {
    // A fresh copy of composition, so its load runs under the mock whatever ran before in this worker.
    vi.resetModules();
    const before = hashes.count;
    const { buildRuntime: build } = await import("../src/composition");
    const loaded = hashes.count;
    expect(loaded - before).toBe(1);
    for (let i = 0; i < 3; i++) build(deedEnv);
    expect(hashes.count).toBe(loaded);
  });
});

describe("C11: the production wiring stamps the production agent id (N2)", () => {
  it("the engine buildRuntime makes stamps the production id on a customer's order_version", async () => {
    const s = await newStore();
    const runtime = buildRuntime(deedEnv);
    const result = await runtime.engine!.onBurst(s.context(), firstOrder, s.matches);
    await save(result);
    const stamped = await env.DB.prepare(`SELECT agent_id FROM facts WHERE business_id = ? AND kind = 'order_version'`)
      .bind(s.businessId)
      .all<{ agent_id: string | null }>();
    expect(stamped.results).toEqual([{ agent_id: PRODUCTION_ID() }]);
  });
});
