import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MemberContext } from "../src/application/engine";
import { staffKey } from "../src/application/engine/order-engine";
import { readerConfiguration } from "../src/application/perception/agent";
import { PLANNER_MODE_PROMPT, PROMPT_VERSION } from "../src/application/perception/prompt";
import type { ActionEnvelope, ConsoleAction } from "../src/domain/contract/actions";
import type { BurstReading } from "../src/domain/contract/observation";
import { agentIdOf, type AgentConfiguration } from "../src/domain/agent-id";
import { sha256Hex } from "../src/domain/sha256";
import { firstOrder, ids, staleReady } from "./fixtures/contract";
import { AGENT_ID, engine, newStore, placeFirstOrder, save, T0, tap } from "./helpers/orders";

const configuration: AgentConfiguration = {
  model: "muse-spark-1.3",
  promptVersions: ["order-v2", "console-v1", "order-v2-nopick-names-ref"],
  schemaNames: ["BurstReading"],
};

describe("sha256Hex (the agent id's hash, in plain code)", () => {
  it("matches the standard vectors for the empty string and 'abc'", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches Web Crypto at every padding boundary, with multi-byte text", async () => {
    for (let length = 0; length <= 130; length++) {
      for (const text of ["a".repeat(length), "ñ".repeat(length)]) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        expect(sha256Hex(text)).toBe(hex);
      }
    }
  });
});

describe("agentIdOf (C11)", () => {
  it("is 8 lowercase hex characters", () => {
    expect(agentIdOf(configuration)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("gives the same id for the same configuration, however it is built", () => {
    expect(agentIdOf({ ...configuration, promptVersions: [...configuration.promptVersions] })).toBe(agentIdOf(configuration));
  });

  it("does not depend on the order of the prompt versions or schema names (both are sorted)", () => {
    const shuffled = { ...configuration, promptVersions: [...configuration.promptVersions].reverse(), schemaNames: ["Zeta", "BurstReading"] };
    const sorted = { ...configuration, schemaNames: ["BurstReading", "Zeta"] };
    expect(agentIdOf(shuffled)).toBe(agentIdOf(sorted));
  });

  it("gives a different id when one prompt version changes", () => {
    const changed = { ...configuration, promptVersions: ["order-v3", "console-v1", "order-v2-nopick-names-ref"] };
    expect(agentIdOf(changed)).not.toBe(agentIdOf(configuration));
  });

  it("gives a different id when the model or a schema name changes", () => {
    expect(agentIdOf({ ...configuration, model: "muse-spark-1.4" })).not.toBe(agentIdOf(configuration));
    expect(agentIdOf({ ...configuration, schemaNames: ["BurstReadingV2"] })).not.toBe(agentIdOf(configuration));
  });

  it("does not confuse the fields: moving a value between the lists changes the id", () => {
    const moved = { model: "muse-spark-1.3", promptVersions: ["order-v2"], schemaNames: ["console-v1", "order-v2-nopick-names-ref", "BurstReading"] };
    expect(agentIdOf(moved)).not.toBe(agentIdOf(configuration));
  });
});

describe("readerConfiguration: the configuration the burst reader sends", () => {
  it("lists every prompt version the reader can use and the reader's schema name", () => {
    const reader = readerConfiguration("muse-spark-1.3");
    expect([...reader.promptVersions].sort()).toEqual([...Object.values(PROMPT_VERSION), PLANNER_MODE_PROMPT.version].sort());
    expect(reader.schemaNames).toEqual(["BurstReading"]);
  });

  it("changes the id when a prompt version the reader uses is changed", () => {
    const reader = readerConfiguration("muse-spark-1.3");
    const bumped = { ...reader, promptVersions: reader.promptVersions.map((version) => `${version}+1`) };
    expect(agentIdOf(bumped)).not.toBe(agentIdOf(reader));
  });
});

/** The kinds and agent ids of one order's facts, oldest first. */
const factAgents = async (orderId: string) =>
  (
    await env.DB.prepare(
      `SELECT kind, agent_id FROM facts WHERE json_extract(body_json, '$.orderId') = ? ORDER BY recorded_at_ms, rowid`,
    )
      .bind(orderId)
      .all<{ kind: string; agent_id: string | null }>()
  ).results;

const staff = (s: Awaited<ReturnType<typeof newStore>>, nowMs: number): MemberContext => ({
  businessId: s.businessId,
  memberId: ids.staff,
  role: "staff",
  canApproveFiado: false,
  nowMs,
});

const startPreparing = (orderId: string, version: number): ActionEnvelope<ConsoleAction> => {
  const action = { type: "start_preparing", orderId, version } as const;
  return { ...staleReady, operationKey: staffKey(action), action };
};

describe("C11: the engine stamps the agent on every customer fact", () => {
  it("gives a burst's order_version and the customer's confirm the agent id", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    expect(await factAgents(v1.orderId)).toEqual([{ kind: "order_version", agent_id: AGENT_ID }]);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), tap(v1.orderId, 1)));
    expect(await factAgents(v1.orderId)).toEqual([
      { kind: "order_version", agent_id: AGENT_ID },
      { kind: "order_confirm", agent_id: AGENT_ID },
    ]);
  });

  it("leaves a staff tap's fact with no agent id", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), tap(v1.orderId, 1)));
    await save(await engine.onConsoleAction(staff(s, T0 + 5000), startPreparing(v1.orderId, 1)));
    expect(await factAgents(v1.orderId)).toEqual([
      { kind: "order_version", agent_id: AGENT_ID },
      { kind: "order_confirm", agent_id: AGENT_ID },
      { kind: "order_status", agent_id: null },
    ]);
  });

  it("ignores an agent id the reading carries: the engine stamps its own", async () => {
    const s = await newStore();
    // A model's output that names an agent (in the reading or in an observation) must not change the stamp.
    const injected = {
      ...firstOrder,
      agent_id: "deadbeef",
      agentId: "deadbeef",
      observations: firstOrder.observations.map((observation) => ({ ...observation, agent_id: "deadbeef" })),
    } as unknown as BurstReading;
    const v1 = await placeFirstOrder(s, ids.customer, T0, injected);
    expect(await factAgents(v1.orderId)).toEqual([{ kind: "order_version", agent_id: AGENT_ID }]);
  });

  it("refuses, in the schema, an agent id that is not 8 lowercase hex characters", async () => {
    const s = await newStore();
    for (const [index, bad] of ["ABCDEF12", "abc", "5e1d0c3g", "5e1d0c3a0", ""].entries()) {
      const insert = env.DB.prepare(
        `INSERT INTO facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json, agent_id)
         VALUES (?, ?, 'order_version', ?, ?, 0, 0, '{}', ?)`,
      ).bind(`bad-agent-${index}`, s.businessId, `bad-agent-key-${index}`, ids.customer, bad);
      await expect(insert.run()).rejects.toThrow();
    }
  });
});
