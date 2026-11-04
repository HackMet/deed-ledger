import { describe, expect, it } from "vitest";
import { readerConfiguration } from "../src/application/perception/agent";
import { PLANNER_MODE_PROMPT, PROMPT_VERSION } from "../src/application/perception/prompt";
import { agentIdOf, type AgentConfiguration } from "../src/domain/agent-id";
import { sha256Hex } from "../src/domain/sha256";

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
