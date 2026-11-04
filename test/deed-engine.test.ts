/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../src/composition";
import { OrderEngine } from "../src/application/engine/order-engine";
import { plannerSourceOf } from "../src/application/planner/source";
import { readConfig } from "../src/infrastructure/config";
import { PlannedDeedEngine } from "../src/infrastructure/d1/planned-deed-engine";
import { D1StoreSetupRepository } from "../src/infrastructure/d1/store-setup-repository";
import type { BurstReading } from "../src/domain/contract/observation";
import { D1PretendEngine } from "../src/infrastructure/memory/d1-pretend-engine";
import { MemoryEngine } from "../src/infrastructure/memory/memory-engine";
import { testEnv } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import wranglerConfig from "../wrangler.jsonc?raw";
import simConfig from "../scripts/lib/sim.mjs?raw";

const withVars = (vars: Record<string, string>) => testEnv(vars as unknown as Partial<Env>);

describe("DEED_ENGINE", () => {
  it("a deployed Worker runs on the real engine with nothing else to set, and the simulator keeps its own", () => {
    expect(wranglerConfig).toMatch(/"DEED_ENGINE":\s*"1"/);
    expect(simConfig).toMatch(/DEED_ENGINE:\s*"0"/);
  });

  it("is off unless it reads \"1\"", () => {
    expect(readConfig(testEnv()).deedEngine).toBe(false);
    expect(readConfig(withVars({ DEED_ENGINE: "0" })).deedEngine).toBe(false);
    expect(readConfig(withVars({ DEED_ENGINE: "" })).deedEngine).toBe(false);
    expect(readConfig(withVars({ DEED_ENGINE: "1" })).deedEngine).toBe(true);
  });

  it("with \"1\", the runtime's engine is the real OrderEngine", () => {
    expect(buildRuntime(withVars({ DEED_ENGINE: "1" })).engine).toBeInstanceOf(OrderEngine);
  });

  it("with CONVERSATION=planner, the planner runs on it (PlannedDeedEngine); classic stays the bare OrderEngine", () => {
    const planned = buildRuntime(withVars({ DEED_ENGINE: "1", CONVERSATION: "planner" })).engine!;
    expect(planned).toBeInstanceOf(PlannedDeedEngine);
    expect(plannerSourceOf(planned)).not.toBeNull();
    expect(plannerSourceOf(buildRuntime(withVars({ DEED_ENGINE: "1", CONVERSATION: "classic" })).engine!)).toBeNull();
  });

  it("with CONVERSATION=planner, the ledger under the planner reads the store's stock, as the classic branch does", async () => {
    const tenant = { businessId: (await seedStore({ members: [{ phone: newPhone(), role: "owner" }] })).businessId };
    const setup = new D1StoreSetupRepository(env.DB);
    await setup.addProduct(tenant, { name: "Arroz 1 lb", otherNames: [], price: null }, 0);
    const arroz = (await setup.listProducts(tenant))[0]!.productId;
    await env.DB.prepare(`INSERT INTO stock_balances (business_id, product_id, qty_milli, updated_at_ms) VALUES (?, ?, 0, 0)`).bind(tenant.businessId, arroz).run();
    const engine = buildRuntime(withVars({ DEED_ENGINE: "1", CONVERSATION: "planner" })).engine!;
    const context = { ...tenant, customerId: "cust-stock", conversationId: "conv-stock", jobId: crypto.randomUUID(), nowMs: 1_000 };
    const evidence = { source: "text", message: 0, start: 0, end: 1 } as const;
    const reading = {
      observations: [
        { kind: "customer_order", lines: [{ text: "2 de arroz", name: "arroz", quantity: "2", unit: null, restrictedCategory: false, evidence }], issues: [] },
        { kind: "fulfillment", mode: "pickup", pin: null, placeText: null, sameAsBefore: false, issues: [] },
      ],
      calls: [],
    } as unknown as BurstReading;
    const result = await engine.onBurst(context, reading, [{ observation: 0, line: 0, productId: arroz, how: "exact_name" }], {
      move: "readback",
      ask: null,
      assumed: [],
      say: "",
      basis: null,
    });
    expect(result.outcome.type).toBe("readback");
    if (result.outcome.type !== "readback") return;
    expect(result.outcome.order.lines[0]?.availability).toBe("se_acabo");
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
