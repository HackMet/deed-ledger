import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { EngineResult, MemberContext } from "../src/application/engine";
import { type OrderFactLedger, OrderEngine, staffKey } from "../src/application/engine/order-engine";
import { FactRefusedError, OrderMovedError, PermanentWriteError } from "../src/application/errors";
import type { ActionEnvelope, ConsoleAction } from "../src/domain/contract/actions";
import type { Claim, OrderState } from "../src/domain/contract/outcomes";
import type { FactCommit } from "../src/domain/facts";
import { deriveOrderState } from "../src/domain/order-state";
import { D1FactLedger } from "../src/infrastructure/d1/fact-ledger";
import { guardedBatch } from "../src/infrastructure/d1/fence";
import { ids, moreSugar, staleReady } from "./fixtures/contract";
import {
  changeAndApprove,
  count,
  engine,
  firstPickupOrder,
  footprint,
  newStore,
  placeFirstOrder,
  reviewer,
  reviewTap,
  save,
  store,
  T0,
  tap,
} from "./helpers/orders";

type Store = Awaited<ReturnType<typeof newStore>>;
type StaffType = "start_preparing" | "mark_ready" | "mark_delivered";

const ledger = new D1FactLedger(env.DB);

const member = (s: Store, nowMs = T0 + 10_000): MemberContext => ({
  businessId: s.businessId,
  memberId: ids.staff,
  role: "staff",
  canApproveFiado: false,
  nowMs,
});

const staffTap = (type: StaffType, orderId: string, version: number): ActionEnvelope<ConsoleAction> => {
  const action = { type, orderId, version } as const;
  return { ...staleReady, operationKey: staffKey(action), action };
};

const confirmTap = (orderId: string, version: number) => tap(orderId, version);
const cancelTap = (orderId: string, version: number) =>
  tap(orderId, version, { operationKey: `cancel:${orderId}:v${version}`, action: { type: "cancel_order", orderId, version } });

interface FactRow {
  id: string;
  kind: string;
  operation_key: string;
  actor_user_id: string;
  body: Record<string, unknown>;
  evidence: { kind: string; ref_id: string }[];
  dependsOn: string[];
}

/** An order's facts, oldest first, with their evidence and edges. */
async function factsOf(businessId: string, orderId: string): Promise<FactRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, operation_key, actor_user_id, body_json FROM facts
     WHERE business_id = ? AND json_extract(body_json, '$.orderId') = ? ORDER BY recorded_at_ms, rowid`,
  )
    .bind(businessId, orderId)
    .all<{ id: string; kind: string; operation_key: string; actor_user_id: string; body_json: string }>();
  return Promise.all(
    results.map(async (row) => ({
      id: row.id,
      kind: row.kind,
      operation_key: row.operation_key,
      actor_user_id: row.actor_user_id,
      body: JSON.parse(row.body_json) as Record<string, unknown>,
      evidence: (
        await env.DB.prepare(`SELECT kind, ref_id FROM fact_evidence WHERE business_id = ? AND fact_id = ? ORDER BY kind, ref_id`)
          .bind(businessId, row.id)
          .all<{ kind: string; ref_id: string }>()
      ).results,
      dependsOn: (
        await env.DB.prepare(`SELECT depends_on_fact_id AS id FROM fact_dependencies WHERE business_id = ? AND fact_id = ?`)
          .bind(businessId, row.id)
          .all<{ id: string }>()
      ).results.map((dep) => dep.id),
    })),
  );
}

const closureOf = (factId: string) =>
  env.DB.prepare(`SELECT closed_by_fact_id AS closedBy, reason FROM fact_closures WHERE fact_id = ?`).bind(factId).first<{ closedBy: string; reason: string }>();

const orderRow = (orderId: string) =>
  env.DB.prepare(`SELECT state, current_version, version_fact_id, confirm_fact_id FROM orders WHERE id = ?`)
    .bind(orderId)
    .first<{ state: OrderState; current_version: number; version_fact_id: string | null; confirm_fact_id: string | null }>();

/** The state the facts derive, next to the cache's. */
async function derivedAndCached(s: Store, orderId: string) {
  const row = (await orderRow(orderId))!;
  const derived = deriveOrderState(await store.orderFacts(s.context(), orderId), row.current_version, row.state);
  return { derived, cached: row.state };
}

const factCount = (businessId: string) => count(`facts WHERE business_id = ?`, businessId);

/** Saves a result after checking it carries the order commit and exactly one fact commit after it. */
async function saveTransition(result: EngineResult) {
  expect(result.commits).toHaveLength(2);
  await save(result);
}

/** An engine whose ledger rewrites each fact before building its commit: how a P1 failure is staged. */
const engineWith = (rewrite: (fact: FactCommit) => FactCommit) => {
  const tampered: OrderFactLedger = { statementsFor: (scope, fact, nowMs) => ledger.statementsFor(scope, rewrite(fact), nowMs) };
  return new OrderEngine({ store, ids: { newId: () => crypto.randomUUID() }, ledger: tampered });
};

describe("K2b: every order transition is exactly one fact, in the same batch", () => {
  it("writes the right kind, edge and evidence for each transition, under the operation's own key", async () => {
    const s = await newStore();
    const burstContext = s.context();
    // K13: picked up, so the order can be delivered at the end.
    const burst = await engine.onBurst(burstContext, firstPickupOrder, s.matches);
    if (burst.outcome.type !== "readback") throw new Error(`expected readback, got ${burst.outcome.type}`);
    await saveTransition(burst);
    const v1 = burst.outcome.order;
    let facts = await factsOf(s.businessId, v1.orderId);
    expect(facts).toHaveLength(1);
    const version = facts[0]!;
    expect(version).toMatchObject({
      kind: "order_version",
      operation_key: `burst:${burstContext.jobId}`,
      actor_user_id: ids.customer,
      body: { orderId: v1.orderId, version: 1 },
      dependsOn: [],
    });
    expect(version.evidence).toEqual([{ kind: "inbound_message", ref_id: burstContext.jobId }]);
    expect(await count(`operations WHERE business_id = ? AND operation_key = ?`, s.businessId, version.operation_key)).toBe(1);
    expect(await orderRow(v1.orderId)).toMatchObject({ version_fact_id: version.id, confirm_fact_id: null });

    const confirmContext = s.context({ nowMs: T0 + 1000 });
    await saveTransition(await engine.onCustomerAction(confirmContext, confirmTap(v1.orderId, 1)));
    facts = await factsOf(s.businessId, v1.orderId);
    expect(facts).toHaveLength(2);
    const confirm = facts[1]!;
    expect(confirm).toEqual({
      id: expect.any(String),
      kind: "order_confirm",
      operation_key: `confirm:${v1.orderId}:v1`,
      actor_user_id: ids.customer,
      body: { orderId: v1.orderId, version: 1, resumeState: "confirmado" },
      evidence: [{ kind: "inbound_message", ref_id: confirmContext.jobId }],
      dependsOn: [version.id],
    });
    expect(await orderRow(v1.orderId)).toMatchObject({ version_fact_id: version.id, confirm_fact_id: confirm.id });

    const steps: [StaffType, string][] = [
      ["start_preparing", "preparing"],
      ["mark_ready", "ready"],
      ["mark_delivered", "delivered"],
    ];
    for (const [index, [type, status]] of steps.entries()) {
      const tapped = staffTap(type, v1.orderId, 1);
      await saveTransition(await engine.onConsoleAction(member(s, T0 + 10_000 + index), tapped));
      facts = await factsOf(s.businessId, v1.orderId);
      expect(facts).toHaveLength(3 + index);
      expect(facts.at(-1)).toEqual({
        id: expect.any(String),
        kind: "order_status",
        operation_key: tapped.operationKey,
        actor_user_id: ids.staff,
        body: { orderId: v1.orderId, version: 1, status },
        evidence: [{ kind: "member", ref_id: ids.staff }],
        dependsOn: [confirm.id],
      });
      expect(await derivedAndCached(s, v1.orderId)).toEqual({
        derived: (await orderRow(v1.orderId))!.state,
        cached: (await orderRow(v1.orderId))!.state,
      });
    }
    expect((await orderRow(v1.orderId))!.state).toBe("entregado");
    // One fact per operations row the order wrote.
    expect(await factCount(s.businessId)).toBe(await count(`operations WHERE business_id = ?`, s.businessId));
  });

  it("a line mark records the line, the mark and the substitute on the order_status fact", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), confirmTap(v1.orderId, 1)));
    await save(await engine.onConsoleAction(member(s), staffTap("start_preparing", v1.orderId, 1)));
    const action = { type: "mark_line", orderId: v1.orderId, version: 1, lineId: "L3", mark: "ofrecer_otro", substituteProductId: "p-mazola" } as const;
    await saveTransition(await engine.onConsoleAction(member(s, T0 + 11_000), { ...staleReady, operationKey: staffKey(action), action }));
    expect((await factsOf(s.businessId, v1.orderId)).at(-1)).toMatchObject({
      kind: "order_status",
      body: { orderId: v1.orderId, version: 1, line: "L3", mark: "ofrecer_otro", substituteProductId: "p-mazola" },
    });
    expect(await derivedAndCached(s, v1.orderId)).toEqual({ derived: "preparando", cached: "preparando" });
  });

  it("the order commit's guard fails: no fact row is written", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    const result = await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), confirmTap(v1.orderId, 1));
    // The order moves after the read: the order commit's guard (state as read) no longer holds.
    await env.DB.prepare(`UPDATE orders SET state = 'armando' WHERE id = ?`).bind(v1.orderId).run();
    const before = await factCount(s.businessId);
    await expect(save(result)).rejects.toBeInstanceOf(OrderMovedError);
    expect(await factCount(s.businessId)).toBe(before);
    expect(await count(`facts WHERE business_id = ? AND kind = 'order_confirm'`, s.businessId)).toBe(0);
  });

  it("P1 fails on a customer fact with no inbound_message: no orders change", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    const before = { footprint: await footprint(s.businessId), row: await orderRow(v1.orderId), facts: await factCount(s.businessId) };
    const noMessage = engineWith((fact) => ({ ...fact, evidence: [{ kind: "member", refId: "someone", contentSha256: null }] }));
    const result = await noMessage.onCustomerAction(s.context({ nowMs: T0 + 1000 }), confirmTap(v1.orderId, 1));
    await expect(save(result)).rejects.toBeInstanceOf(PermanentWriteError);
    expect({ footprint: await footprint(s.businessId), row: await orderRow(v1.orderId), facts: await factCount(s.businessId) }).toEqual(before);

    // Zero evidence fails too, whatever the kind.
    const none = engineWith((fact) => ({ ...fact, evidence: [] }));
    await expect(save(await none.onCustomerAction(s.context({ nowMs: T0 + 1000 }), confirmTap(v1.orderId, 1)))).rejects.toBeInstanceOf(
      PermanentWriteError,
    );
    expect(await orderRow(v1.orderId)).toEqual(before.row);
  });

  it("P1 fails on a staff fact without exactly one member: no orders change", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), confirmTap(v1.orderId, 1)));
    const before = { footprint: await footprint(s.businessId), row: await orderRow(v1.orderId), facts: await factCount(s.businessId) };
    const twoMembers = engineWith((fact) => ({
      ...fact,
      evidence: [...fact.evidence, { kind: "member", refId: "member-other", contentSha256: null }],
    }));
    await expect(save(await twoMembers.onConsoleAction(member(s), staffTap("start_preparing", v1.orderId, 1)))).rejects.toBeInstanceOf(
      PermanentWriteError,
    );
    const asMessage = engineWith((fact) => ({ ...fact, evidence: [{ kind: "inbound_message", refId: "msg", contentSha256: null }] }));
    await expect(save(await asMessage.onConsoleAction(member(s), staffTap("start_preparing", v1.orderId, 1)))).rejects.toBeInstanceOf(
      PermanentWriteError,
    );
    expect({ footprint: await footprint(s.businessId), row: await orderRow(v1.orderId), facts: await factCount(s.businessId) }).toEqual(before);
  });

  it("v2 depends on v1 and closes it superseded; v1's confirm dies with it, v2 stays live", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), confirmTap(v1.orderId, 1)));
    // K12: after confirming, v2 comes from an approved change request.
    await changeAndApprove(s, moreSugar, T0 + 2000);
    const [version1, confirm1, , review, version2, confirm2] = await factsOf(s.businessId, v1.orderId);
    expect(version2).toMatchObject({ kind: "order_version", body: { orderId: v1.orderId, version: 2 } });
    expect(version2!.dependsOn.sort()).toEqual([version1!.id, review!.id].sort());
    expect(await closureOf(version1!.id)).toEqual({ closedBy: version2!.id, reason: "superseded" });
    expect(await orderRow(v1.orderId)).toMatchObject({ version_fact_id: version2!.id, confirm_fact_id: confirm2!.id });
    const live = new Map((await store.orderFacts(s.context(), v1.orderId)).map((fact) => [fact.id, fact.live]));
    expect(live).toEqual(new Map([[version1!.id, false], [confirm1!.id, false], [version2!.id, true], [confirm2!.id, true]]));

    // A v3 rests on v2 through the chain: the gate lets it through, and v2 is superseded in turn.
    await changeAndApprove(s, moreSugar, T0 + 4000);
    const facts = await factsOf(s.businessId, v1.orderId);
    expect(await closureOf(version2!.id)).toEqual({ closedBy: facts.at(-2)!.id, reason: "superseded" });
    expect(await derivedAndCached(s, v1.orderId)).toEqual({ derived: "confirmado", cached: "confirmado" });
  });

  it("a cancel closes the live confirm when confirmed, the version otherwise", async () => {
    const s = await newStore();
    const confirmed = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), confirmTap(confirmed.orderId, 1)));
    await saveTransition(await engine.onCustomerAction(s.context({ nowMs: T0 + 2000 }), cancelTap(confirmed.orderId, 1)));
    const [version, confirm, cancel] = await factsOf(s.businessId, confirmed.orderId);
    expect(cancel).toMatchObject({ kind: "order_cancel", body: { orderId: confirmed.orderId, version: 1 }, dependsOn: [] });
    expect(cancel!.evidence.map((e) => e.kind)).toEqual(["inbound_message"]);
    expect(await closureOf(confirm!.id)).toEqual({ closedBy: cancel!.id, reason: "cancelled" });
    expect(await closureOf(version!.id)).toBeNull();
    expect(await derivedAndCached(s, confirmed.orderId)).toEqual({ derived: "cancelado", cached: "cancelado" });

    const pending = await placeFirstOrder(s, "customer-pending");
    const pendingContext = s.context({ customerId: "customer-pending", nowMs: T0 + 3000 });
    await saveTransition(
      await engine.onCustomerAction(pendingContext, {
        ...cancelTap(pending.orderId, 1),
        actor: { type: "customer", customerId: "customer-pending" },
      }),
    );
    const [pendingVersion, pendingCancel] = await factsOf(s.businessId, pending.orderId);
    expect(await closureOf(pendingVersion!.id)).toEqual({ closedBy: pendingCancel!.id, reason: "cancelled" });
    expect(await derivedAndCached(s, pending.orderId)).toEqual({ derived: "cancelado", cached: "cancelado" });
  });

  it("R3: mark_ready after a cancel is refused by G4 inside the batch, with the engine's read bypassed", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), confirmTap(v1.orderId, 1)));
    const confirmId = (await orderRow(v1.orderId))!.confirm_fact_id!;
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 2000 }), cancelTap(v1.orderId, 1)));

    const ready: FactCommit = {
      factId: crypto.randomUUID(),
      kind: "order_status",
      operationKey: staffKey({ type: "mark_ready", orderId: v1.orderId, version: 1 }),
      draft: null,
      actorUserId: ids.staff,
      validFromMs: T0 + 3000,
      body: { orderId: v1.orderId, version: 1, status: "ready" },
      evidence: [{ kind: "member", refId: ids.staff, contentSha256: null }],
      dependsOn: [confirmId],
      closes: null,
      movements: [],
    };
    const commit = ledger.statementsFor({ businessId: s.businessId }, ready, T0 + 3000);
    const before = await factCount(s.businessId);
    await expect(guardedBatch(env.DB, commit.guards, commit.statements, commit.post)).rejects.toEqual(
      new FactRefusedError("dependency_not_live"),
    );
    expect(await factCount(s.businessId)).toBe(before);

    // The same tap on a live confirm goes through: the refusal is the cancel, not the shape.
    const other = await placeFirstOrder(s, "customer-other");
    await save(
      await engine.onCustomerAction(s.context({ customerId: "customer-other", nowMs: T0 + 1000 }), {
        ...confirmTap(other.orderId, 1),
        actor: { type: "customer", customerId: "customer-other" },
      }),
    );
    const live = ledger.statementsFor(
      { businessId: s.businessId },
      { ...ready, factId: crypto.randomUUID(), operationKey: "live-tap", dependsOn: [(await orderRow(other.orderId))!.confirm_fact_id!] },
      T0 + 3000,
    );
    const beforeLive = await factCount(s.businessId);
    await guardedBatch(env.DB, live.guards, live.statements, live.post);
    expect(await factCount(s.businessId)).toBe(beforeLive + 1);
  });

  it("D-38: preparando, a change and a re-confirm: the facts derive the cache's state at every step", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s, ids.customer, T0, firstPickupOrder);
    const states: { derived: OrderState; cached: OrderState }[] = [await derivedAndCached(s, v1.orderId)];
    const step = async (result: Promise<EngineResult>, commits = 2) => {
      const saved = await result;
      expect(saved.commits).toHaveLength(commits);
      await save(saved);
      states.push(await derivedAndCached(s, v1.orderId));
    };
    await step(engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), confirmTap(v1.orderId, 1)));
    await step(engine.onConsoleAction(member(s, T0 + 2000), staffTap("start_preparing", v1.orderId, 1)));
    // K12: the change is a request, then approved: the review, v2 and v2's confirm, with the order commit.
    const requested = await engine.onBurst(s.context({ nowMs: T0 + 3000 }), moreSugar, []);
    await step(Promise.resolve(requested));
    const requestId = requested.outcome.type === "order_status" ? requested.outcome.order!.openChangeRequest!.id : "";
    await step(engine.onConsoleAction(reviewer(s, T0 + 4000), reviewTap(requestId)), 4);
    await step(engine.onConsoleAction(member(s, T0 + 5000), staffTap("mark_ready", v1.orderId, 2)));
    await step(engine.onConsoleAction(member(s, T0 + 6000), staffTap("mark_delivered", v1.orderId, 2)));

    expect(states.map((x) => x.cached)).toEqual(["por_confirmar", "confirmado", "preparando", "preparando", "preparando", "listo", "entregado"]);
    expect(states.map((x) => x.derived)).toEqual(states.map((x) => x.cached));

    // The trap: the preparing tap rested on v1's confirm, dead since v2; the approval's confirm holds preparando.
    const facts = await store.orderFacts(s.context(), v1.orderId);
    expect(facts.find((f) => f.kind === "order_status" && f.status === "preparing")?.live).toBe(false);
    expect(facts.find((f) => f.kind === "order_confirm" && f.version === 2)).toMatchObject({ live: true, resumeState: "preparando" });
  });

  it("R5: verifyClaims answers from liveness: true, then false after a cancel and after a supersede", async () => {
    const s = await newStore();
    const stateClaim = (orderId: string, version: number, state: OrderState): Claim => ({ type: "order_state", orderId, version, state });
    const totalClaim = (orderId: string, version: number, total: number): Claim => ({ type: "order_total", orderId, version, total });
    const price = (orderId: string, version: number) =>
      env.DB.prepare(`UPDATE order_versions SET total_centavos = 34500 WHERE order_id = ? AND version = ?`).bind(orderId, version).run();

    // Cancelled while waiting: the version itself is closed; only "it is cancelled" is backed any more.
    const waiting = await placeFirstOrder(s, "customer-waiting");
    await price(waiting.orderId, 1);
    const waitingClaims = [stateClaim(waiting.orderId, 1, "por_confirmar"), totalClaim(waiting.orderId, 1, 34_500)];
    expect(await engine.verifyClaims(s.context(), waitingClaims)).toEqual([true, true]);
    await save(
      await engine.onCustomerAction(s.context({ customerId: "customer-waiting" }), {
        ...cancelTap(waiting.orderId, 1),
        actor: { type: "customer", customerId: "customer-waiting" },
      }),
    );
    expect(await engine.verifyClaims(s.context(), [...waitingClaims, stateClaim(waiting.orderId, 1, "cancelado")])).toEqual([false, false, true]);

    // Cancelled after confirming: the cancel closes only the confirm and the version stays live, yet the
    // live cancel takes the whole order back: the total is no longer backed, "cancelado" is (both paths alike).
    const confirmed = await placeFirstOrder(s, "customer-confirmed");
    const asConfirmed = (nowMs: number) => s.context({ customerId: "customer-confirmed", nowMs });
    const confirmedActor = { type: "customer", customerId: "customer-confirmed" } as const;
    await save(await engine.onCustomerAction(asConfirmed(T0 + 500), { ...confirmTap(confirmed.orderId, 1), actor: confirmedActor }));
    await price(confirmed.orderId, 1);
    const confirmedClaims = [stateClaim(confirmed.orderId, 1, "confirmado"), totalClaim(confirmed.orderId, 1, 34_500)];
    expect(await engine.verifyClaims(s.context(), confirmedClaims)).toEqual([true, true]);
    await save(await engine.onCustomerAction(asConfirmed(T0 + 600), { ...cancelTap(confirmed.orderId, 1), actor: confirmedActor }));
    expect((await orderRow(confirmed.orderId))!.state).toBe("cancelado");
    expect(await engine.verifyClaims(s.context(), [...confirmedClaims, stateClaim(confirmed.orderId, 1, "cancelado")])).toEqual([
      false,
      false,
      true,
    ]);

    // Superseded: v1's claims go false; v2's are true.
    const v1 = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), confirmTap(v1.orderId, 1)));
    await price(v1.orderId, 1);
    const v1Claims = [stateClaim(v1.orderId, 1, "confirmado"), totalClaim(v1.orderId, 1, 34_500)];
    expect(await engine.verifyClaims(s.context(), v1Claims)).toEqual([true, true]);
    // K12: a request alone changes nothing the customer was told; the approval supersedes v1.
    await save(await engine.onBurst(s.context({ nowMs: T0 + 2000 }), moreSugar, []));
    expect(await engine.verifyClaims(s.context(), v1Claims)).toEqual([true, true]);
    await changeAndApprove(s, moreSugar, T0 + 3000);
    expect(await engine.verifyClaims(s.context(), v1Claims)).toEqual([false, false]);
    expect(await engine.verifyClaims(s.context(), [stateClaim(v1.orderId, 2, "confirmado")])).toEqual([true]);

    // The ledger, not the cache, answers: close v2's fact behind the cache's back and the claim fails.
    const v2Fact = (await orderRow(v1.orderId))!.version_fact_id!;
    await env.DB.prepare(
      `INSERT INTO fact_closures (business_id, fact_id, closed_by_fact_id, reason, closed_at_ms) VALUES (?, ?, 'test', 'cancelled', 0)`,
    )
      .bind(s.businessId, v2Fact)
      .run();
    expect((await orderRow(v1.orderId))!.state).toBe("confirmado");
    expect(await engine.verifyClaims(s.context(), [stateClaim(v1.orderId, 2, "confirmado")])).toEqual([false]);

    // A cache state the facts don't derive is not backed either.
    const other = await placeFirstOrder(s, "customer-other");
    await env.DB.prepare(`UPDATE orders SET state = 'listo' WHERE id = ?`).bind(other.orderId).run();
    expect(await engine.verifyClaims(s.context(), [stateClaim(other.orderId, 1, "listo"), stateClaim(other.orderId, 1, "por_confirmar")])).toEqual([
      false,
      true,
    ]);
  });

  it("a repeated key writes no second fact, by the read and by the batch", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    const first = await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), confirmTap(v1.orderId, 1));
    await save(first);
    const after = await factCount(s.businessId);
    const again = await engine.onCustomerAction(s.context({ nowMs: T0 + 1500 }), confirmTap(v1.orderId, 1));
    expect(again.outcome.type).toBe("duplicate");
    expect(again.commits).toEqual([]);
    // The same batch run twice (a race past the read) fails as a whole.
    await expect(save(first)).rejects.toThrow();
    // Only the fact commit, past the order's guards: the facts' UNIQUE operation key settles it.
    await expect(save({ ...first, commits: [first.commits[1]!] })).rejects.toBeInstanceOf(PermanentWriteError);
    expect(await factCount(s.businessId)).toBe(after);
    expect(await count(`facts WHERE business_id = ? AND operation_key = ?`, s.businessId, `confirm:${v1.orderId}:v1`)).toBe(1);
  });
});
