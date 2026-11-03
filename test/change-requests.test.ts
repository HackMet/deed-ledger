import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MemberContext } from "../src/application/engine";
import { staffKey } from "../src/application/engine/order-engine";
import { FactRefusedError, PermanentWriteError } from "../src/application/errors";
import { changeRequestKey, lineDiff, reviewKey, reviewReason } from "../src/domain/change-request";
import type { ActionEnvelope, ConsoleAction } from "../src/domain/contract/actions";
import type { BurstReading } from "../src/domain/contract/observation";
import type { OrderLineView, OrderView } from "../src/domain/contract/outcomes";
import { CHANGE_AFTER_READY } from "../src/domain/copy";
import type { FactCommit } from "../src/domain/facts";
import { D1FactLedger } from "../src/infrastructure/d1/fact-ledger";
import { D1OrderTrail } from "../src/infrastructure/d1/order-trail";
import { guardedBatch } from "../src/infrastructure/d1/fence";
import { addAndPickup, ids, moreSugar, staleReady } from "./fixtures/contract";
import { count, engine, footprint, newStore, placeFirstOrder, reviewer, reviewTap, save, store, T0, tap } from "./helpers/orders";

type Store = Awaited<ReturnType<typeof newStore>>;

const ledger = new D1FactLedger(env.DB);
const trail = new D1OrderTrail(env.DB);

const staff = (s: Store, nowMs: number): MemberContext => ({ ...reviewer(s, nowMs), role: "staff" });
const staffTap = (type: "start_preparing" | "mark_ready", orderId: string, version = 1): ActionEnvelope<ConsoleAction> => {
  const action = { type, orderId, version } as const;
  return { ...staleReady, operationKey: staffKey(action), action };
};

/** "que sean 4 de azúcar": L4 from 2 to 4. (The fixture's moreSugar sets L3 to the 3 it already has.) */
const sugarToFour: BurstReading = {
  ...moreSugar,
  observations: [
    {
      kind: "order_change",
      edits: [{ op: "set_quantity", target: { ref: "L4", said: "azúcar" }, quantity: "4", evidence: { source: "text", message: 0, start: 0, end: 20 } }],
      issues: [],
    },
  ],
};

/** A confirmed order, then the customer's "que sean 4 de azúcar" after confirming, saved as a request. */
async function requested(s: Store) {
  const v1 = await placeFirstOrder(s);
  await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), tap(v1.orderId, 1)));
  const jobId = crypto.randomUUID();
  const result = await engine.onBurst(s.context({ nowMs: T0 + 2000, jobId }), sugarToFour, []);
  await save(result);
  const order = result.outcome.type === "order_status" ? result.outcome.order : null;
  return { v1, jobId, result, order: order!, requestId: order!.openChangeRequest!.id };
}

const fact = (id: string) =>
  env.DB.prepare(`SELECT kind, operation_key, actor_user_id, body_json FROM facts WHERE id = ?`)
    .bind(id)
    .first<{ kind: string; operation_key: string; actor_user_id: string; body_json: string }>()
    .then((row) => row && { ...row, body: JSON.parse(row.body_json) as Record<string, unknown> });
const evidenceOf = (id: string) =>
  env.DB.prepare(`SELECT kind, ref_id FROM fact_evidence WHERE fact_id = ? ORDER BY kind`).bind(id).all().then((r) => r.results);
const dependsOf = (id: string) =>
  env.DB.prepare(`SELECT depends_on_fact_id AS id FROM fact_dependencies WHERE fact_id = ?`).bind(id).all<{ id: string }>().then((r) => r.results.map((x) => x.id));
const closureOf = (id: string) =>
  env.DB.prepare(`SELECT closed_by_fact_id AS closedBy, reason FROM fact_closures WHERE fact_id = ?`).bind(id).first();
const colourOf = async (s: Store, orderId: string) => (await trail.listOrders(s.context())).find((row) => row.orderId === orderId)?.colour;
const factsOfKind = (businessId: string, kind: string) =>
  env.DB.prepare(`SELECT id, body_json FROM facts WHERE business_id = ? AND kind = ? ORDER BY rowid`).bind(businessId, kind).all<{ id: string; body_json: string }>().then((r) => r.results);

describe("K12: a change after confirming is a request the owner or staff answer with a reason", () => {
  it("records the request on the live confirm, keeps the order, and shows it yellow with the diff", async () => {
    const s = await newStore();
    const { v1, jobId, result, order, requestId } = await requested(s);
    expect(result.outcome.type).toBe("order_status");
    // The order is untouched: same version, same lines, confirmado, in its place.
    expect(order).toMatchObject({ orderId: v1.orderId, version: 1, state: "confirmado", queuePosition: 1 });
    expect(order.lines).toEqual(v1.lines);
    expect(order.openChangeRequest!.diff).toEqual({
      added: [],
      removed: [],
      changed: [{ before: v1.lines[3], after: { ...v1.lines[3], quantity: "4" } }],
    });
    expect((await store.order(s.context(), v1.orderId))!.view).toEqual(order);

    const confirmId = (await env.DB.prepare(`SELECT confirm_fact_id AS id FROM orders WHERE id = ?`).bind(v1.orderId).first<{ id: string }>())!.id;
    expect(await fact(requestId)).toMatchObject({
      kind: "change_request",
      operation_key: changeRequestKey(v1.orderId, jobId),
      actor_user_id: ids.customer,
      body: { orderId: v1.orderId, version: 1 },
    });
    expect(await evidenceOf(requestId)).toEqual([{ kind: "inbound_message", ref_id: jobId }]);
    expect(await dependsOf(requestId)).toEqual([confirmId]);
    expect(await colourOf(s, v1.orderId)).toBe("yellow");
    expect(await count(`order_versions WHERE order_id = ?`, v1.orderId)).toBe(1);
  });

  it("approve: a new version superseding the old, its confirm, the review with the reason; yellow back to normal", async () => {
    const s = await newStore();
    const { v1, jobId, requestId } = await requested(s);
    const before = (await env.DB.prepare(`SELECT version_fact_id AS v, confirm_fact_id AS c FROM orders WHERE id = ?`).bind(v1.orderId).first<{ v: string; c: string }>())!;

    const approved = await engine.onConsoleAction(reviewer(s, T0 + 5000), reviewTap(requestId, "approve", "  Sí hay azúcar  "));
    expect(approved.outcome.type).toBe("action_saved");
    const v2 = approved.outcome.type === "action_saved" ? approved.outcome.order! : ({} as OrderView);
    expect(v2).toMatchObject({ orderId: v1.orderId, version: 2, state: "confirmado", queuePosition: 1, openChangeRequest: null });
    expect(v2.lastReview).toEqual({ decision: "approve", reason: "Sí hay azúcar", atMs: T0 + 5000 });
    expect(v2.lines.map((l) => l.quantity)).toEqual(["1", "3", "3", "4"]);
    expect(approved.notices).toEqual([{ customerId: ids.customer, notice: { type: "change_approved", order: v2 } }]);
    // The order commit, then the review, the version and the confirm: four commits, one batch.
    expect(approved.commits).toHaveLength(4);
    await save(approved);

    const after = (await env.DB.prepare(`SELECT state, current_version, version_fact_id AS v, confirm_fact_id AS c FROM orders WHERE id = ?`).bind(v1.orderId).first<{ state: string; current_version: number; v: string; c: string }>())!;
    expect(after).toMatchObject({ state: "confirmado", current_version: 2 });
    const [review] = await factsOfKind(s.businessId, "change_review");
    expect(await fact(review!.id)).toMatchObject({
      operation_key: reviewKey(requestId),
      actor_user_id: ids.staff,
      body: { orderId: v1.orderId, version: 1, changeRequestId: requestId, decision: "approve", reason: "Sí hay azúcar" },
    });
    expect(await evidenceOf(review!.id)).toEqual([{ kind: "member", ref_id: ids.staff }]);
    expect(await dependsOf(review!.id)).toEqual([requestId]);
    expect(await closureOf(requestId)).toEqual({ closedBy: review!.id, reason: "superseded" });
    // v2 rests on v1 and on the review, and supersedes v1; its confirm rests on v2 and on the customer's message.
    expect((await dependsOf(after.v)).sort()).toEqual([before.v, review!.id].sort());
    expect(await closureOf(before.v)).toEqual({ closedBy: after.v, reason: "superseded" });
    expect(await fact(after.c)).toMatchObject({ kind: "order_confirm", body: { version: 2, resumeState: "confirmado" } });
    expect(await dependsOf(after.c)).toEqual([after.v]);
    expect(await evidenceOf(after.c)).toEqual([{ kind: "inbound_message", ref_id: jobId }]);
    const live = new Map((await store.orderFacts(s.context(), v1.orderId)).map((f) => [f.id, f.live]));
    expect([live.get(before.v), live.get(before.c), live.get(after.v), live.get(after.c)]).toEqual([false, false, true, true]);

    expect(await colourOf(s, v1.orderId)).toBe("none");
    expect((await store.order(s.context(), v1.orderId))!.view).toEqual({ ...v2, lastReview: { ...v2.lastReview!, atMs: expect.any(Number) } });
    expect(await engine.verifyClaims(s.context(), [{ type: "order_state", orderId: v1.orderId, version: 2, state: "confirmado" }])).toEqual([true]);
    // Staff carry on at v2: their tap rests on the approval's confirm.
    await save(await engine.onConsoleAction(staff(s, T0 + 6000), staffTap("start_preparing", v1.orderId, 2)));
    expect(await count(`orders WHERE id = ? AND state = 'preparando'`, v1.orderId)).toBe(1);
  });

  it("approve while preparando keeps preparando: the request window covers it", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), tap(v1.orderId, 1)));
    await save(await engine.onConsoleAction(staff(s, T0 + 1500), staffTap("start_preparing", v1.orderId)));
    const result = await engine.onBurst(s.context({ nowMs: T0 + 2000 }), addAndPickup, []);
    expect(result.outcome).toMatchObject({ type: "order_status", order: { state: "preparando", version: 1 } });
    await save(result);
    const requestId = (await factsOfKind(s.businessId, "change_request"))[0]!.id;
    const approved = await engine.onConsoleAction(reviewer(s, T0 + 3000), reviewTap(requestId));
    await save(approved);
    expect(approved.outcome).toMatchObject({ order: { state: "preparando", version: 2, fulfillment: { mode: "pickup" } } });
    expect(await count(`orders WHERE id = ? AND state = 'preparando' AND current_version = 2`, v1.orderId)).toBe(1);
  });

  it("decline: the order stays on its version, the reason is stored and goes in the notice", async () => {
    const s = await newStore();
    const { v1, order, requestId } = await requested(s);
    const reason = "Ya no queda azúcar de esa marca";
    const declined = await engine.onConsoleAction(staff(s, T0 + 5000), {
      ...reviewTap(requestId, "decline", reason),
      actor: { type: "member", memberId: ids.staff, role: "staff" },
    });
    const expected: OrderView = { ...order, openChangeRequest: null, lastReview: { decision: "decline", reason, atMs: T0 + 5000 } };
    expect(declined.outcome).toEqual({ type: "action_saved", order: expected });
    expect(declined.notices).toEqual([{ customerId: ids.customer, notice: { type: "change_declined", order: expected, reason } }]);
    expect(declined.commits).toHaveLength(2);
    const versionsBefore = await count(`order_versions WHERE order_id = ?`, v1.orderId);
    await save(declined);

    expect(await count(`order_versions WHERE order_id = ?`, v1.orderId)).toBe(versionsBefore);
    expect((await store.order(s.context(), v1.orderId))!.view).toEqual(expected);
    const [review] = await factsOfKind(s.businessId, "change_review");
    expect(JSON.parse(review!.body_json)).toMatchObject({ decision: "decline", reason, changeRequestId: requestId });
    expect(await closureOf(requestId)).toEqual({ closedBy: review!.id, reason: "superseded" });
    // The confirm and the version are untouched and live; the colour is normal again.
    const live = (await store.orderFacts(s.context(), v1.orderId)).every((f) => f.live);
    expect(live).toBe(true);
    expect(await colourOf(s, v1.orderId)).toBe("none");
  });

  it("a review after a cancel: refused by the read, and by the gate (G4) when the read is bypassed", async () => {
    const s = await newStore();
    const { v1, requestId } = await requested(s);
    // Read before the cancel lands: the engine says yes and builds the commits.
    const raced = await engine.onConsoleAction(reviewer(s, T0 + 4000), reviewTap(requestId));
    expect(raced.outcome.type).toBe("action_saved");
    await save(
      await engine.onCustomerAction(
        s.context({ nowMs: T0 + 4500 }),
        tap(v1.orderId, 1, { operationKey: `cancel:${v1.orderId}:v1`, action: { type: "cancel_order", orderId: v1.orderId, version: 1 } }),
      ),
    );

    // The read now: the request died with the confirm.
    const cancelled = (await store.order(s.context(), v1.orderId))!.view;
    expect(cancelled.openChangeRequest).toBeNull();
    const refused = await engine.onConsoleAction(reviewer(s, T0 + 5000), reviewTap(requestId));
    expect(refused).toEqual({ outcome: { type: "rejected", reason: "invalid_state", order: cancelled }, notices: [], commits: [] });

    // The batch built before the cancel: nothing of it is written.
    const before = { ...(await footprint(s.businessId)), facts: await count(`facts WHERE business_id = ?`, s.businessId) };
    await expect(save(raced)).rejects.toThrow();
    // The review fact alone, past every read and the order guard: G4 refuses it.
    const review: FactCommit = {
      factId: crypto.randomUUID(),
      kind: "change_review",
      operationKey: reviewKey(requestId),
      draft: null,
      actorUserId: ids.staff,
      validFromMs: T0 + 5000,
      body: { orderId: v1.orderId, version: 1, changeRequestId: requestId, decision: "approve", reason: "ok" },
      evidence: [{ kind: "member", refId: ids.staff, contentSha256: null }],
      dependsOn: [requestId],
      closes: { factId: requestId, reason: "superseded" },
      movements: [],
    };
    const commit = ledger.statementsFor(s.context(), review, T0 + 5000);
    await expect(guardedBatch(env.DB, commit.guards, commit.statements, commit.post)).rejects.toEqual(new FactRefusedError("dependency_not_live"));
    expect({ ...(await footprint(s.businessId)), facts: await count(`facts WHERE business_id = ?`, s.businessId) }).toEqual(before);
  });

  it("a double tap is a duplicate with the first outcome, whatever the second says; saved once", async () => {
    const s = await newStore();
    const { requestId } = await requested(s);
    const first = await engine.onConsoleAction(reviewer(s, T0 + 5000), reviewTap(requestId, "decline", "No hay"));
    await save(first);
    const before = { ...(await footprint(s.businessId)), facts: await count(`facts WHERE business_id = ?`, s.businessId) };

    for (const again of [reviewTap(requestId, "decline", "No hay"), reviewTap(requestId, "approve", "Mejor sí")]) {
      const second = await engine.onConsoleAction(reviewer(s, T0 + 6000), again);
      expect(second).toEqual({ outcome: { type: "duplicate", first: first.outcome }, notices: [], commits: [] });
    }
    expect({ ...(await footprint(s.businessId)), facts: await count(`facts WHERE business_id = ?`, s.businessId) }).toEqual(before);
    expect(await count(`facts WHERE business_id = ? AND kind = 'change_review'`, s.businessId)).toBe(1);
  });

  it("a change from listo on is refused with the copy, and nothing is saved", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), tap(v1.orderId, 1)));
    await save(await engine.onConsoleAction(staff(s, T0 + 1500), staffTap("start_preparing", v1.orderId)));
    await save(await engine.onConsoleAction(staff(s, T0 + 1600), staffTap("mark_ready", v1.orderId)));
    const ready = (await store.order(s.context(), v1.orderId))!.view;
    const before = { ...(await footprint(s.businessId)), facts: await count(`facts WHERE business_id = ?`, s.businessId) };

    const refused = await engine.onBurst(s.context({ nowMs: T0 + 2000 }), sugarToFour, []);
    expect(refused).toEqual({ outcome: { type: "rejected", reason: "invalid_state", order: ready }, notices: [], commits: [] });
    expect(ready.state).toBe("listo");
    // The reply for this refusal (Q1's default): the spec's words.
    expect(CHANGE_AFTER_READY).toBe("Ya está listo, ¿querés hacer un pedido nuevo?");
    expect({ ...(await footprint(s.businessId)), facts: await count(`facts WHERE business_id = ?`, s.businessId) }).toEqual(before);
  });

  it("approving a request still open once the order is listo is refused, and nothing is saved", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), tap(v1.orderId, 1)));
    await save(await engine.onConsoleAction(staff(s, T0 + 1500), staffTap("start_preparing", v1.orderId)));
    await save(await engine.onBurst(s.context({ nowMs: T0 + 2000 }), addAndPickup, []));
    const requestId = (await factsOfKind(s.businessId, "change_request"))[0]!.id;
    await save(await engine.onConsoleAction(staff(s, T0 + 2500), staffTap("mark_ready", v1.orderId)));
    const ready = (await store.order(s.context(), v1.orderId))!.view;
    expect(ready).toMatchObject({ state: "listo", version: 1, openChangeRequest: { id: requestId } });
    const before = { ...(await footprint(s.businessId)), facts: await count(`facts WHERE business_id = ?`, s.businessId) };

    const approved = await engine.onConsoleAction(reviewer(s, T0 + 3000), reviewTap(requestId));
    expect(approved).toEqual({ outcome: { type: "rejected", reason: "invalid_state", order: ready }, notices: [], commits: [] });
    expect({ ...(await footprint(s.businessId)), facts: await count(`facts WHERE business_id = ?`, s.businessId) }).toEqual(before);
    expect(await count(`orders WHERE id = ? AND state = 'listo' AND current_version = 1`, v1.orderId)).toBe(1);
  });

  it("another store's request id is not_found; a key it didn't derive, a bad reason and a spoofed actor are refused", async () => {
    const s = await newStore();
    const other = await newStore();
    const { order, requestId } = await requested(s);
    const before = { ...(await footprint(s.businessId)), facts: await count(`facts WHERE business_id = ?`, s.businessId) };
    const refusal = (reason: string, view: OrderView | null = null) => ({ outcome: { type: "rejected", reason, order: view }, notices: [], commits: [] });

    expect(await engine.onConsoleAction(reviewer(other, T0 + 5000), reviewTap(requestId))).toEqual(refusal("not_found"));
    expect(await engine.onConsoleAction(reviewer(s, T0 + 5000), reviewTap(crypto.randomUUID()))).toEqual(refusal("not_found"));
    expect(await engine.onConsoleAction(reviewer(s, T0 + 5000), { ...reviewTap(requestId), operationKey: "rev:other" })).toEqual(refusal("not_allowed"));
    for (const reason of ["", "   ", "x".repeat(201)]) {
      expect(await engine.onConsoleAction(reviewer(s, T0 + 5000), reviewTap(requestId, "decline", reason))).toEqual(refusal("not_allowed", order));
    }
    const spoofed = { ...reviewTap(requestId), actor: { type: "member", memberId: "someone-else", role: "owner" } } as const;
    expect(await engine.onConsoleAction(reviewer(s, T0 + 5000), spoofed)).toEqual(refusal("not_allowed"));
    expect({ ...(await footprint(s.businessId)), facts: await count(`facts WHERE business_id = ?`, s.businessId) }).toEqual(before);
    // 200 characters after trimming is still a reason.
    expect(reviewReason(` ${"x".repeat(200)} `)).toBe("x".repeat(200));
  });

  it("another store's change_request naming this store's order never shows in this store's view", async () => {
    const s = await newStore();
    const other = await newStore();
    const { v1, order, requestId } = await requested(s);
    const mine = (await fact(requestId))!;
    // Store B records a later, live request whose body names store A's order: the read must not see it.
    const foreign: FactCommit = {
      factId: crypto.randomUUID(),
      kind: "change_request",
      operationKey: changeRequestKey(v1.orderId, "job-of-other-store"),
      draft: null,
      actorUserId: ids.customer,
      validFromMs: T0 + 3000,
      body: mine.body,
      evidence: [{ kind: "inbound_message", refId: "job-of-other-store", contentSha256: null }],
      dependsOn: [],
      closes: null,
      movements: [],
    };
    const commit = ledger.statementsFor(other.context(), foreign, T0 + 3000);
    await guardedBatch(env.DB, commit.guards, commit.statements, commit.post);
    expect(await count(`facts WHERE business_id = ? AND kind = 'change_request'`, other.businessId)).toBe(1);

    expect((await store.order(s.context(), v1.orderId))!.view).toEqual(order);
    expect(order.openChangeRequest!.id).toBe(requestId);
  });

  it("a second change while one waits replaces it, adding to what the customer asked for", async () => {
    const s = await newStore();
    const { v1, requestId } = await requested(s);
    const second = await engine.onBurst(s.context({ nowMs: T0 + 3000 }), addAndPickup, []);
    await save(second);
    const open = second.outcome.type === "order_status" ? second.outcome.order!.openChangeRequest! : null;
    expect(open!.id).not.toBe(requestId);
    expect(await closureOf(requestId)).toEqual({ closedBy: open!.id, reason: "superseded" });
    expect(open!.diff.changed.map((c) => c.after.quantity)).toEqual(["4"]);
    expect(open!.diff.added.map((l) => l.text)).toEqual(["un jabón más"]);
    // The old request can't be answered any more; the new one can.
    expect((await engine.onConsoleAction(reviewer(s, T0 + 4000), reviewTap(requestId))).outcome).toMatchObject({ type: "rejected", reason: "invalid_state" });
    await save(await engine.onConsoleAction(reviewer(s, T0 + 4000), reviewTap(open!.id)));
    expect((await store.order(s.context(), v1.orderId))!.view.lines.map((l) => [l.text, l.quantity])).toEqual([
      ...v1.lines.map((l, i) => [l.text, i === 3 ? "4" : l.quantity]),
      ["un jabón más", "1"],
    ]);
  });
});

describe("G4b: a dependency written in the same batch is checked after the statements", () => {
  it("refuses a fact whose same-batch dependency never got written, and admits it when it is", async () => {
    const s = await newStore();
    const { requestId } = await requested(s);
    const base = (factId: string, dependsOn: string): FactCommit => ({
      factId,
      kind: "change_review",
      operationKey: `g4b:${factId}`,
      draft: null,
      actorUserId: ids.staff,
      validFromMs: T0,
      body: { orderId: "none" },
      evidence: [{ kind: "member", refId: ids.staff, contentSha256: null }],
      dependsOn: [dependsOn],
      sameBatch: [dependsOn],
      closes: null,
      movements: [],
    });
    const facts = () => count(`facts WHERE business_id = ?`, s.businessId);
    const before = await facts();
    // Its dependency is announced as same-batch but nothing writes it: G4 skipped it, G4b refuses
    // (after the rollback the fact is gone, so it surfaces as P1 does: a permanent write error).
    const orphan = ledger.statementsFor(s.context(), base(crypto.randomUUID(), crypto.randomUUID()), T0);
    await expect(guardedBatch(env.DB, orphan.guards, orphan.statements, orphan.post)).rejects.toBeInstanceOf(PermanentWriteError);
    expect(await facts()).toBe(before);

    // Written first in the same batch, resting on the live request: admitted.
    const firstId = crypto.randomUUID();
    const first = ledger.statementsFor(s.context(), { ...base(firstId, requestId), sameBatch: [] }, T0);
    const second = ledger.statementsFor(s.context(), base(crypto.randomUUID(), firstId), T0);
    await guardedBatch(env.DB, [...first.guards, ...second.guards], [...first.statements, ...second.statements], [...first.post!, ...second.post!]);
    expect(await facts()).toBe(before + 2);
  });
});

describe("lineDiff: lines pair by product or words, not by label", () => {
  const line = (text: string, quantity: string, productId: string | null = null): OrderLineView => ({
    lineId: "",
    text,
    productId,
    productName: null,
    quantity,
    unit: null,
    unitPrice: null,
    availability: "no_se",
    restricted: false,
    mark: null,
    substitute: null,
  });

  it("names added, removed and changed lines; a shifted label is not a change", () => {
    const arroz = line("arroz", "1", "p-arroz");
    const azucar = line("azúcar", "1", "p-azucar");
    const jabon = line("jabón", "2");
    expect(lineDiff([arroz, azucar, jabon], [azucar, { ...jabon, quantity: "3" }, line("aceite", "1")])).toEqual({
      added: [line("aceite", "1")],
      removed: [arroz],
      changed: [{ before: jabon, after: { ...jabon, quantity: "3" } }],
    });
    expect(lineDiff([arroz], [arroz])).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe("migration 0024: facts gains the K12 and K14 kinds, keeping every row", () => {
  /** The migration's own statements, aimed at a scratch copy so the shared table is left alone. */
  const scratch = (sql: string) => sql.replaceAll(/\bfacts_new\b/g, "k12_facts_new").replaceAll(/\bfacts\b/g, "k12_facts");

  it("rebuilds a 0023-shaped table with the same rows, in the same order, and the wider CHECK", async () => {
    const m23 = env.TEST_MIGRATIONS.find((m) => m.name === "0023_order_facts.sql")!;
    const m24 = env.TEST_MIGRATIONS.find((m) => m.name === "0024_change_requests.sql")!;
    // 0023's facts table, as it was before 0024.
    const create23 = m23.queries.find((q) => q.includes("CREATE TABLE facts_new"))!.replace("facts_new", "k12_facts");
    await env.DB.prepare(`DROP TABLE IF EXISTS k12_facts`).run();
    await env.DB.prepare(create23).run();
    // Every kind 0023 allowed, from a store the engine wrote, plus a receipt-like row.
    const s = await newStore();
    const { requestId } = await requested(s);
    await save(await engine.onConsoleAction(reviewer(s, T0 + 5000), reviewTap(requestId)));
    await env.DB.prepare(
      `INSERT INTO k12_facts SELECT id, business_id, kind, operation_key, draft_id, draft_revision, actor_user_id, valid_from_ms,
         recorded_at_ms, body_json FROM facts WHERE business_id = ? AND kind IN ('order_version', 'order_confirm', 'order_cancel', 'order_status')
       ORDER BY rowid`,
    )
      .bind(s.businessId)
      .run();
    for (const kind of ["receipt", "cancellation", "price", "business_info"]) {
      await env.DB.prepare(
        `INSERT INTO k12_facts (id, business_id, kind, operation_key, draft_id, draft_revision, actor_user_id, valid_from_ms, recorded_at_ms, body_json)
         VALUES (?, ?, ?, ?, 'draft-1', 2, 'user-1', 1, 2, '{"n":1}')`,
      )
        .bind(crypto.randomUUID(), s.businessId, kind, `key:${kind}`)
        .run();
    }
    const rows = () => env.DB.prepare(`SELECT * FROM k12_facts ORDER BY rowid`).all().then((r) => r.results);
    const before = await rows();
    expect(before.length).toBeGreaterThanOrEqual(8);
    await expect(
      env.DB.prepare(`INSERT INTO k12_facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json)
        VALUES ('x', ?, 'change_request', 'k', 'u', 0, 0, '{}')`).bind(s.businessId).run(),
    ).rejects.toThrow(/CHECK/);

    for (const query of m24.queries) await env.DB.prepare(scratch(query)).run();

    expect(await rows()).toEqual(before);
    for (const kind of ["change_request", "change_review", "receipt_review"]) {
      await env.DB.prepare(
        `INSERT INTO k12_facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json)
         VALUES (?, ?, ?, ?, 'u', 0, 0, '{}')`,
      )
        .bind(crypto.randomUUID(), s.businessId, kind, `new:${kind}`)
        .run();
    }
    await expect(
      env.DB.prepare(`INSERT INTO k12_facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json)
        VALUES ('y', ?, 'made_up', 'k2', 'u', 0, 0, '{}')`).bind(s.businessId).run(),
    ).rejects.toThrow(/CHECK/);
    // The uniqueness the ledger relies on survives the rebuild.
    await expect(
      env.DB.prepare(`INSERT INTO k12_facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json)
        VALUES ('z', ?, 'price', 'key:price', 'u', 0, 0, '{}')`).bind(s.businessId).run(),
    ).rejects.toThrow(/UNIQUE/);
    expect(await env.DB.prepare(`SELECT name FROM sqlite_master WHERE name = 'k12_facts_new'`).first()).toBeNull();
    await env.DB.prepare(`DROP TABLE k12_facts`).run();

    // The real table carries the new kinds.
    const sql = (await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'facts'`).first<{ sql: string }>())!.sql;
    for (const kind of ["change_request", "change_review", "receipt_review", "order_status", "receipt"]) expect(sql).toContain(`'${kind}'`);
  });
});
