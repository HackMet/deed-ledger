import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../src/composition";
import { OrderEngine } from "../src/application/engine/order-engine";
import { readConfig } from "../src/infrastructure/config";
import { D1PretendEngine } from "../src/infrastructure/memory/d1-pretend-engine";
import { MemoryEngine } from "../src/infrastructure/memory/memory-engine";
import { testEnv } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";

const withVars = (vars: Record<string, string>) => testEnv(vars as unknown as Partial<Env>);

describe("DEED_ENGINE", () => {
  it("is off unless it reads \"1\"", () => {
    expect(readConfig(testEnv()).deedEngine).toBe(false);
    expect(readConfig(withVars({ DEED_ENGINE: "0" })).deedEngine).toBe(false);
    expect(readConfig(withVars({ DEED_ENGINE: "" })).deedEngine).toBe(false);
    expect(readConfig(withVars({ DEED_ENGINE: "1" })).deedEngine).toBe(true);
  });

  it("with \"1\", the runtime's engine is the real OrderEngine", () => {
    expect(buildRuntime(withVars({ DEED_ENGINE: "1" })).engine).toBeInstanceOf(OrderEngine);
  });

  it("wins over PRETEND_ENGINE and DEV_CONSOLE", () => {
    expect(buildRuntime(withVars({ DEED_ENGINE: "1", PRETEND_ENGINE: "1" })).engine).toBeInstanceOf(OrderEngine);
    expect(buildRuntime(withVars({ DEED_ENGINE: "1", DEV_CONSOLE: "1" })).engine).toBeInstanceOf(OrderEngine);
  });

  it("unset, the engine is exactly as before: none, the pretend engine or the memory engine", () => {
    expect(buildRuntime(testEnv()).engine).toBeNull();
    expect(buildRuntime(withVars({ DEED_ENGINE: "0" })).engine).toBeNull();
    expect(buildRuntime(withVars({ PRETEND_ENGINE: "1" })).engine).toBeInstanceOf(D1PretendEngine);
    expect(buildRuntime(withVars({ DEV_CONSOLE: "1" })).engine).toBeInstanceOf(MemoryEngine);
  });

  it("with \"1\", the engine records its claim checks in deed_checks, so the Deed feed isn't empty outside the demo", async () => {
    const tenant = { businessId: (await seedStore({ members: [{ phone: newPhone(), role: "owner" }] })).businessId };
    const count = async () =>
      (await env.DB.prepare(`SELECT count(*) AS n FROM deed_checks WHERE business_id = ?`).bind(tenant.businessId).first<{ n: number }>())!.n;
    const engine = buildRuntime(withVars({ DEED_ENGINE: "1" })).engine!;
    const before = await count();
    const [held] = await engine.verifyClaims(tenant, [{ type: "order_state", orderId: "no-such-order", version: 1, state: "confirmado" }]);
    expect(held).toBe(false);
    expect(await count()).toBe(before + 1);
  });
});
