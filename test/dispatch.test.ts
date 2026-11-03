import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MemberContext } from "../src/application/engine";
import { staffKey } from "../src/application/engine/order-engine";
import type { ActionEnvelope, ConsoleAction } from "../src/domain/contract/actions";
import type { BurstReading } from "../src/domain/contract/observation";
import type { OrderState, OrderView } from "../src/domain/contract/outcomes";
import { CANCEL_AFTER_DISPATCH } from "../src/domain/copy";
import { deriveOrderState } from "../src/domain/order-state";
import { firstOrder, ids, moreSugar } from "./fixtures/contract";
import { count, engine, firstDeliveryOrder, firstPickupOrder, footprint, newStore, placeFirstOrder, save, store, T0, tap } from "./helpers/orders";
import { newPhone } from "./helpers/seed";

type Store = Awaited<ReturnType<typeof newStore>>;
type Step = "start_preparing" | "mark_ready" | "dispatch" | "mark_delivered";

/** A member of the store, named the way the store knows them; inactive when `active` is false. */
async function addMember(businessId: string, name: string | null, active = true): Promise<string> {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, phone, display_name, created_at_ms) VALUES (?, ?, ?, 0)`).bind(userId, newPhone(), name),
    env.DB.prepare(`INSERT INTO memberships (business_id, user_id, role, active, created_at_ms) VALUES (?, ?, 'staff', ?, 0)`).bind(
      businessId,
      userId,
      active ? 1 : 0,
    ),
  ]);
  return userId;
}

const member = (s: Store, nowMs: number): MemberContext => ({
  businessId: s.businessId,
  memberId: ids.staff,
  role: "staff",
  canApproveFiado: false,
  nowMs,
});

function stepTap(type: Step, orderId: string, courierMemberId = ""): ActionEnvelope<ConsoleAction> {
  const action = type === "dispatch" ? ({ type, orderId, version: 1, courierMemberId } as const) : ({ type, orderId, version: 1 } as const);
  return { operationKey: staffKey(action), actor: { type: "member", memberId: ids.staff, role: "staff" }, action };
}

/** An order placed with `reading`, confirmed, and taken through `steps`, every result saved. */
async function orderAt(s: Store, reading: BurstReading, steps: readonly Step[], courier = "") {
  const v1 = await placeFirstOrder(s, ids.customer, T0, reading);
  await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), tap(v1.orderId, 1)));
  for (const [i, type] of steps.entries()) {
    const result = await engine.onConsoleAction(member(s, T0 + 10_000 + i * 1000), stepTap(type, v1.orderId, courier));
    if (result.outcome.type !== "action_saved") throw new Error(`${type}: ${JSON.stringify(result.outcome)}`);
    await save(result);
  }
  return (await store.order(s.context(), v1.orderId))!;
}

/** The order's order_status facts, oldest first, with their edges. */
async function statusFacts(businessId: string, orderId: string) {
  const { results } = await env.DB.prepare(
    `SELECT f.id, f.body_json, (SELECT json_group_array(d.depends_on_fact_id) FROM fact_dependencies d
       WHERE d.business_id = f.business_id AND d.fact_id = f.id) AS deps
     FROM facts f WHERE f.business_id = ? AND f.kind = 'order_status' AND json_extract(f.body_json, '$.orderId') = ? ORDER BY f.rowid`,
  )
    .bind(businessId, orderId)
    .all<{ id: string; body_json: string; deps: string }>();
  return results.map((row) => ({ id: row.id, body: JSON.parse(row.body_json) as Record<string, unknown>, dependsOn: JSON.parse(row.deps) as string[] }));
}

async function derivedAndCached(s: Store, orderId: string): Promise<{ derived: OrderState; cached: OrderState }> {
  const row = (await env.DB.prepare(`SELECT state, current_version FROM orders WHERE id = ?`).bind(orderId).first<{ state: OrderState; current_version: number }>())!;
  return { derived: deriveOrderState(await store.orderFacts(s.context(), orderId), row.current_version, row.state), cached: row.state };
}

const written = async (s: Store) => ({ ...(await footprint(s.businessId)), facts: await count(`facts WHERE business_id = ?`, s.businessId) });

describe("K13: a delivery order goes listo → en_camino → entregado with a courier; pickup goes listo → entregado", () => {
  it("delivery: the dispatch rests on the ready tap and records the courier, the delivery rests on the dispatch", async () => {
    const s = await newStore();
    const marvin = await addMember(s.businessId, "Marvin");
    const ready = await orderAt(s, firstDeliveryOrder, ["start_preparing", "mark_ready"]);
    const { orderId } = ready.view;
    expect(ready.view).toMatchObject({ state: "listo", fulfillment: { mode: "delivery" } });

    const dispatched = await engine.onConsoleAction(member(s, T0 + 20_000), stepTap("dispatch", orderId, marvin));
    const enCamino: OrderView = { ...ready.view, state: "en_camino" };
    expect(dispatched.outcome).toEqual({ type: "action_saved", order: enCamino });
    expect(dispatched.notices).toEqual([{ customerId: ids.customer, notice: { type: "order_dispatched", order: enCamino, courierName: "Marvin" } }]);
    expect(dispatched.commits.map((c) => c.post?.length ?? 0)).toEqual([0, 1]);
    await save(dispatched);
    expect((await store.order(s.context(), orderId))!.view).toEqual(enCamino);
    expect(await derivedAndCached(s, orderId)).toEqual({ derived: "en_camino", cached: "en_camino" });
    expect(
      await env.DB.prepare(`SELECT kind, detail_json FROM audit_events WHERE subject_id = ? ORDER BY rowid DESC LIMIT 1`).bind(orderId).first(),
    ).toEqual({ kind: "order_dispatched", detail_json: JSON.stringify({ from: "listo", to: "en_camino", version: 1, courierMemberId: marvin }) });

    const delivered = await engine.onConsoleAction(member(s, T0 + 30_000), stepTap("mark_delivered", orderId));
    expect(delivered).toMatchObject({ outcome: { type: "action_saved", order: { ...enCamino, state: "entregado" } }, notices: [] });
    await save(delivered);
    expect(await derivedAndCached(s, orderId)).toEqual({ derived: "entregado", cached: "entregado" });

    const facts = await statusFacts(s.businessId, orderId);
    const confirmId = ready.confirmFactId!;
    const [readyFact, dispatchFact, deliveredFact] = facts.slice(1);
    expect(readyFact!.body).toEqual({ orderId, version: 1, status: "ready" });
    expect(dispatchFact).toEqual({
      id: expect.any(String),
      body: { orderId, version: 1, status: "dispatched", courierMemberId: marvin },
      dependsOn: expect.arrayContaining([confirmId, readyFact!.id]),
    });
    expect(dispatchFact!.dependsOn).toHaveLength(2);
    expect(deliveredFact).toEqual({ id: expect.any(String), body: { orderId, version: 1, status: "delivered" }, dependsOn: expect.arrayContaining([confirmId, dispatchFact!.id]) });
    expect(deliveredFact!.dependsOn).toHaveLength(2);
    // One fact per operations row.
    expect(await count(`facts WHERE business_id = ?`, s.businessId)).toBe(await count(`operations WHERE business_id = ?`, s.businessId));
  });

  it("pickup: listo → entregado in one tap, resting on the confirm", async () => {
    const s = await newStore();
    const ready = await orderAt(s, firstPickupOrder, ["start_preparing", "mark_ready"]);
    const delivered = await engine.onConsoleAction(member(s, T0 + 20_000), stepTap("mark_delivered", ready.view.orderId));
    expect(delivered).toMatchObject({ outcome: { type: "action_saved", order: { state: "entregado" } }, notices: [] });
    await save(delivered);
    expect(await derivedAndCached(s, ready.view.orderId)).toEqual({ derived: "entregado", cached: "entregado" });
    expect((await statusFacts(s.businessId, ready.view.orderId)).at(-1)!.dependsOn).toEqual([ready.confirmFactId]);
  });

  it("a pickup order is never dispatched, and an order with no fulfillment is neither dispatched nor delivered", async () => {
    const s = await newStore();
    const marvin = await addMember(s.businessId, "Marvin");
    const pickupReady = await orderAt(s, firstPickupOrder, ["start_preparing", "mark_ready"]);
    const before = await written(s);
    expect(await engine.onConsoleAction(member(s, T0 + 20_000), stepTap("dispatch", pickupReady.view.orderId, marvin))).toEqual({
      outcome: { type: "rejected", reason: "invalid_state", order: pickupReady.view },
      notices: [],
      commits: [],
    });

    const t = await newStore();
    const unknown = await orderAt(t, firstOrder, ["start_preparing", "mark_ready"]);
    expect(unknown.view.fulfillment).toBeNull();
    const courier = await addMember(t.businessId, "Marvin");
    for (const tapped of [stepTap("dispatch", unknown.view.orderId, courier), stepTap("mark_delivered", unknown.view.orderId)]) {
      expect((await engine.onConsoleAction(member(t, T0 + 20_000), tapped)).outcome).toEqual({
        type: "rejected",
        reason: "invalid_state",
        order: unknown.view,
      });
    }
    expect(await written(s)).toEqual(before);
    expect(await derivedAndCached(t, unknown.view.orderId)).toEqual({ derived: "listo", cached: "listo" });
  });

  it("the courier must be an active member of this store: another store's, an inactive one and a made-up id are not_found", async () => {
    const s = await newStore();
    const other = await newStore();
    const elsewhere = await addMember(other.businessId, "Otra tienda");
    const gone = await addMember(s.businessId, "Ya no trabaja", false);
    const ready = await orderAt(s, firstDeliveryOrder, ["start_preparing", "mark_ready"]);
    const before = await written(s);
    for (const courier of [elsewhere, gone, "member-made-up", 7 as unknown as string]) {
      expect(await engine.onConsoleAction(member(s, T0 + 20_000), stepTap("dispatch", ready.view.orderId, courier))).toEqual({
        outcome: { type: "rejected", reason: "not_found", order: ready.view },
        notices: [],
        commits: [],
      });
    }
    expect(await written(s)).toEqual(before);
  });

  it("a delivery order isn't delivered before it is dispatched", async () => {
    const s = await newStore();
    const ready = await orderAt(s, firstDeliveryOrder, ["start_preparing", "mark_ready"]);
    const before = await written(s);
    expect((await engine.onConsoleAction(member(s, T0 + 20_000), stepTap("mark_delivered", ready.view.orderId))).outcome).toEqual({
      type: "rejected",
      reason: "invalid_state",
      order: ready.view,
    });
    expect(await written(s)).toEqual(before);
  });

  it("once en_camino, the customer can't cancel or change it: refused with the order, nothing saved", async () => {
    const s = await newStore();
    const marvin = await addMember(s.businessId, "Marvin");
    const out = await orderAt(s, firstDeliveryOrder, ["start_preparing", "mark_ready", "dispatch"], marvin);
    const { orderId } = out.view;
    expect(out.view.state).toBe("en_camino");
    const before = await written(s);
    const cancel = await engine.onCustomerAction(
      s.context({ nowMs: T0 + 40_000 }),
      tap(orderId, 1, { operationKey: `cancel:${orderId}:v1`, action: { type: "cancel_order", orderId, version: 1 } }),
    );
    expect(cancel).toEqual({ outcome: { type: "rejected", reason: "invalid_state", order: out.view }, notices: [], commits: [] });
    // The reply renders this refusal with the copy (Angel's renderer); the engine never writes text.
    expect(CANCEL_AFTER_DISPATCH).toBe("Ya va en camino; hablá con la tienda.");
    const change = await engine.onBurst(s.context({ nowMs: T0 + 41_000 }), moreSugar, []);
    expect(change.outcome).toEqual({ type: "rejected", reason: "invalid_state", order: out.view });
    expect(change.commits).toEqual([]);
    expect(await written(s)).toEqual(before);
  });

  it("a repeated dispatch is a duplicate with the first outcome, whoever it names; saved once", async () => {
    const s = await newStore();
    const marvin = await addMember(s.businessId, "Marvin");
    const lesly = await addMember(s.businessId, "Lesly");
    const ready = await orderAt(s, firstDeliveryOrder, ["start_preparing", "mark_ready"]);
    const first = await engine.onConsoleAction(member(s, T0 + 20_000), stepTap("dispatch", ready.view.orderId, marvin));
    await save(first);
    const before = await written(s);
    for (const courier of [marvin, lesly]) {
      expect(await engine.onConsoleAction(member(s, T0 + 21_000), stepTap("dispatch", ready.view.orderId, courier))).toEqual({
        outcome: { type: "duplicate", first: first.outcome },
        notices: [],
        commits: [],
      });
    }
    expect(await written(s)).toEqual(before);
    expect((await statusFacts(s.businessId, ready.view.orderId)).at(-1)!.body).toMatchObject({ courierMemberId: marvin });
  });

  it("a dispatch decided on a ready tap that died since is refused by the gate (G4): nothing written", async () => {
    const s = await newStore();
    const marvin = await addMember(s.businessId, "Marvin");
    const ready = await orderAt(s, firstDeliveryOrder, ["start_preparing", "mark_ready"]);
    const raced = await engine.onConsoleAction(member(s, T0 + 20_000), stepTap("dispatch", ready.view.orderId, marvin));
    expect(raced.outcome.type).toBe("action_saved");
    // No customer step closes a ready tap today; close it directly, the way a future one would.
    const readyId = (await statusFacts(s.businessId, ready.view.orderId)).at(-1)!.id;
    await env.DB.prepare(
      `INSERT INTO fact_closures (business_id, fact_id, closed_by_fact_id, reason, closed_at_ms) VALUES (?, ?, 'not-its-ancestor', 'cancelled', ?)`,
    )
      .bind(s.businessId, readyId, T0 + 20_500)
      .run();
    const before = await written(s);
    await expect(save(raced)).rejects.toThrow();
    expect(await written(s)).toEqual(before);
    // And the read now says so first (D-42): the order is listo with no live ready tap to rest on.
    expect((await engine.onConsoleAction(member(s, T0 + 21_000), stepTap("dispatch", ready.view.orderId, marvin))).outcome).toMatchObject({
      type: "rejected",
      reason: "invalid_state",
    });
  });
});

describe("migration 0025: orders.state gains en_camino, keeping every row", () => {
  /** The migration's statements, aimed at a scratch copy so the shared table is left alone. */
  const scratch = (sql: string) => sql.replaceAll(/\borders_new\b/g, "k13_orders_new").replaceAll(/\borders\b/g, "k13_orders");

  it("rebuilds a 0023-shaped orders table with the same rows, in the same order, and the wider CHECK", async () => {
    const m21 = env.TEST_MIGRATIONS.find((m) => m.name === "0021_orders.sql")!;
    const m25 = env.TEST_MIGRATIONS.find((m) => m.name === "0025_dispatch.sql")!;
    await env.DB.prepare(`DROP TABLE IF EXISTS k13_orders`).run();
    await env.DB.prepare(scratch(m21.queries.find((q) => q.includes("CREATE TABLE orders ("))!)).run();
    await env.DB.prepare(`ALTER TABLE k13_orders ADD COLUMN version_fact_id TEXT`).run();
    await env.DB.prepare(`ALTER TABLE k13_orders ADD COLUMN confirm_fact_id TEXT`).run();
    const s = await newStore();
    const states = ["por_confirmar", "confirmado", "preparando", "armando", "listo", "entregado", "cancelado"];
    for (const [i, state] of states.entries()) {
      await env.DB.prepare(
        `INSERT INTO k13_orders (id, business_id, customer_id, state, current_version, first_confirmed_at_ms, ready_at_ms, delivered_at_ms,
           created_at_ms, version_fact_id, confirm_fact_id) VALUES (?, ?, 'c', ?, ?, ?, NULL, ?, ?, ?, NULL)`,
      )
        .bind(`order-${9 - i}`, s.businessId, state, i + 1, i * 10, i % 2 === 0 ? null : i, i, `vf-${i}`)
        .run();
    }
    const insertEnCamino = () =>
      env.DB.prepare(`INSERT INTO k13_orders (id, business_id, customer_id, state, current_version, created_at_ms) VALUES ('x', ?, 'c', 'en_camino', 1, 0)`)
        .bind(s.businessId)
        .run();
    await expect(insertEnCamino()).rejects.toThrow(/CHECK/);
    const rows = () => env.DB.prepare(`SELECT * FROM k13_orders ORDER BY rowid`).all().then((r) => r.results);
    const before = await rows();

    for (const query of m25.queries) await env.DB.prepare(scratch(query)).run();

    expect(await rows()).toEqual(before);
    await insertEnCamino();
    await expect(
      env.DB.prepare(`INSERT INTO k13_orders (id, business_id, customer_id, state, current_version, created_at_ms) VALUES ('y', ?, 'c', 'en_envio', 1, 0)`)
        .bind(s.businessId)
        .run(),
    ).rejects.toThrow(/CHECK/);
    await env.DB.prepare(`DROP TABLE k13_orders`).run();
  });
});
