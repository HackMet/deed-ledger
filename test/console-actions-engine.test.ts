import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MemberContext } from "../src/application/engine";
import { staffKey } from "../src/application/engine/order-engine";
import type { ActionEnvelope, ConsoleAction } from "../src/domain/contract/actions";
import type { Claim, OrderState } from "../src/domain/contract/outcomes";
import { addAndPickup, ids, moreSugar, noHayAceite, offerMazola, staleReady } from "./fixtures/contract";
import { changeAndApprove, count, engine, footprint, newStore, placeFirstOrder, save, store, T0, tap } from "./helpers/orders";

type Store = Awaited<ReturnType<typeof newStore>>;

/** The customer's confirming tap on a version, saved. */
async function confirm(s: Store, orderId: string, version: number, nowMs = T0 + 1000, customerId: string = ids.customer) {
  await save(
    await engine.onCustomerAction(s.context({ customerId, nowMs }), {
      ...tap(orderId, version),
      actor: { type: "customer", customerId },
    }),
  );
}

/** The customer's cancel tap, saved. */
async function cancel(s: Store, orderId: string, version: number) {
  const result = await engine.onCustomerAction(
    s.context(),
    tap(orderId, version, { operationKey: `cancel:${orderId}:v${version}`, action: { type: "cancel_order", orderId, version } }),
  );
  expect(result.outcome.type).toBe("order_cancelled");
  await save(result);
}

/** No line is priced yet, so a total only exists once a test sets one. */
const priceVersion = (orderId: string, version: number, total: number) =>
  env.DB.prepare(`UPDATE order_versions SET total_centavos = ? WHERE order_id = ? AND version = ?`).bind(total, orderId, version).run();

const stateClaim = (orderId: string, version: number, state: OrderState): Claim => ({ type: "order_state", orderId, version, state });
const totalClaim = (orderId: string, version: number, total: number): Claim => ({ type: "order_total", orderId, version, total });

describe("verifyClaims: true only when the records back the claim now", () => {
  it("backs order_state and order_total, then turns false after a cancel", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await confirm(s, v1.orderId, 1);
    await priceVersion(v1.orderId, 1, 34_500);

    expect(
      await engine.verifyClaims(s.context(), [
        stateClaim(v1.orderId, 1, "confirmado"),
        totalClaim(v1.orderId, 1, 34_500),
        stateClaim(v1.orderId, 1, "listo"),
        totalClaim(v1.orderId, 1, 34_400),
      ]),
    ).toEqual([true, true, false, false]);

    await cancel(s, v1.orderId, 1);
    expect(
      await engine.verifyClaims(s.context(), [stateClaim(v1.orderId, 1, "confirmado"), stateClaim(v1.orderId, 1, "cancelado")]),
    ).toEqual([false, true]);
  });

  it("turns false after a change makes a new version", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await confirm(s, v1.orderId, 1);
    await priceVersion(v1.orderId, 1, 34_500);
    const claims = [stateClaim(v1.orderId, 1, "confirmado"), totalClaim(v1.orderId, 1, 34_500)];
    expect(await engine.verifyClaims(s.context(), claims)).toEqual([true, true]);

    // K12: approved, at the same total: the same state and total, but on v2, so v1's claims turn false.
    await changeAndApprove(s, moreSugar, T0 + 2000);
    await priceVersion(v1.orderId, 2, 34_500);
    expect(await engine.verifyClaims(s.context(), claims)).toEqual([false, false]);
    expect(
      await engine.verifyClaims(s.context(), [stateClaim(v1.orderId, 2, "confirmado"), totalClaim(v1.orderId, 2, 34_500)]),
    ).toEqual([true, true]);
  });

  it("is false for an unknown total, what isn't stored, an unknown shape and another store's order", async () => {
    const s = await newStore();
    const other = await newStore();
    const v1 = await placeFirstOrder(s);
    const claims = [
      // The total is unknown (no line priced): it never equals anything.
      totalClaim(v1.orderId, 1, 0),
      { type: "unit_price", productId: "p", price: 100 },
      { type: "availability", productId: "p", availability: "hay" },
      { type: "payment_confirmed", paymentClaimId: "c", amount: 100 },
      { type: "balance", customerId: ids.customer, balance: 0 },
      { type: "store_hours", hours: [] },
      { type: "made_up" },
      null,
      { type: "order_state", orderId: 7, version: 1, state: "por_confirmar" },
    ] as unknown as Claim[];
    expect(await engine.verifyClaims(s.context(), claims)).toEqual(claims.map(() => false));

    // The same claim is true here and false from another store.
    expect(await engine.verifyClaims(s.context(), [stateClaim(v1.orderId, 1, "por_confirmar")])).toEqual([true]);
    expect(await engine.verifyClaims(other.context(), [stateClaim(v1.orderId, 1, "por_confirmar")])).toEqual([false]);
    expect(await engine.verifyClaims(s.context(), [])).toEqual([]);
  });
});

/** Moves an order the way staff will (item 3 of #12 builds the taps); here only the read is under test. */
const setState = (orderId: string, state: OrderState) =>
  env.DB.prepare(`UPDATE orders SET state = ? WHERE id = ?`).bind(state, orderId).run();

describe("preparationList: confirmado, preparando and listo, oldest confirmation first", () => {
  it("lists the three states in confirmation order and leaves out cancelled and unconfirmed orders", async () => {
    const s = await newStore();
    const other = await newStore();
    const ready = await placeFirstOrder(s, "customer-ready");
    const packing = await placeFirstOrder(s, "customer-packing");
    const waiting = await placeFirstOrder(s, "customer-waiting");
    const cancelled = await placeFirstOrder(s, "customer-cancelled");
    await placeFirstOrder(s, "customer-unconfirmed");
    await placeFirstOrder(other, "customer-elsewhere");
    // Confirmed out of creation order: the list follows the first confirmation.
    await confirm(s, waiting.orderId, 1, T0 + 1000, "customer-waiting");
    await confirm(s, cancelled.orderId, 1, T0 + 1500, "customer-cancelled");
    await confirm(s, ready.orderId, 1, T0 + 2000, "customer-ready");
    await confirm(s, packing.orderId, 1, T0 + 3000, "customer-packing");
    await confirm(other, (await store.openOrder(other.context(), "customer-elsewhere"))!.view.orderId, 1, T0, "customer-elsewhere");
    await setState(ready.orderId, "listo");
    await setState(packing.orderId, "preparando");
    await setState(cancelled.orderId, "cancelado");

    const list = await engine.preparationList(s.context());
    expect(list.map((card) => [card.order.orderId, card.order.state, card.confirmedAtMs])).toEqual([
      [waiting.orderId, "confirmado", T0 + 1000],
      [ready.orderId, "listo", T0 + 2000],
      [packing.orderId, "preparando", T0 + 3000],
    ]);
    // Each card carries the order exactly as the customer's reader builds it, and no name yet.
    for (const card of list) {
      const customerId = card.order.orderId === waiting.orderId ? "customer-waiting" : card.order.orderId === ready.orderId ? "customer-ready" : "customer-packing";
      expect(card.order).toEqual((await store.customerOrder(s.context(), customerId, card.order.orderId))?.view);
      expect(card.customerName).toBeNull();
      expect(card.changedLineIds).toEqual([]);
    }
    expect(list[0]?.order.queuePosition).toBe(1);
    expect(list[1]?.order.queuePosition).toBeNull();
  });

  it("reports the lines that changed in the current version", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await confirm(s, v1.orderId, 1);
    // "Y otro jabón" plus pickup: v2 adds L5 and keeps L1-L4 as they were.
    await changeAndApprove(s, addAndPickup, T0 + 2000);

    // A quantity edited in place on v2 counts too, and a line equal to v1 doesn't.
    await env.DB.prepare(`UPDATE order_lines SET qty_milli = 5000 WHERE order_id = ? AND version = 2 AND line_no = 2`).bind(v1.orderId).run();
    const [card] = await engine.preparationList(s.context());
    expect(card?.order).toMatchObject({ orderId: v1.orderId, version: 2, state: "confirmado" });
    expect(card?.changedLineIds).toEqual(["L2", "L5"]);
    // Still listed at its first confirmation (D-38).
    expect(card?.confirmedAtMs).toBe(T0 + 1000);

    // Each compared field on its own: unit, the customer's words, the product (null counts as a value).
    const edit = (sql: string, lineNo: number) =>
      env.DB.prepare(`UPDATE order_lines SET ${sql} WHERE order_id = ? AND version = 2 AND line_no = ?`).bind(v1.orderId, lineNo).run();
    await edit(`unit = 'caja'`, 1);
    await edit(`customer_text = '3 lb arroz blanco'`, 3);
    await edit(`product_id = NULL`, 4);
    expect((await engine.preparationList(s.context()))[0]?.changedLineIds).toEqual(["L1", "L2", "L3", "L4", "L5"]);

    // v3 is compared with v2, not v1: only the line it adds is new.
    await changeAndApprove(s, addAndPickup, T0 + 4000);
    expect((await engine.preparationList(s.context()))[0]?.changedLineIds).toEqual(["L6"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Staff on the preparation list.

const member = (s: Store, over: Partial<MemberContext> = {}): MemberContext => ({
  businessId: s.businessId,
  memberId: ids.staff,
  role: "staff",
  canApproveFiado: false,
  nowMs: T0 + 10_000,
  ...over,
});

type StaffAction = Extract<ConsoleAction, { type: "start_preparing" | "mark_line" | "mark_ready" | "mark_delivered" }>;

/** A staff tap shaped like the fixtures', carrying the key the engine derives for it. */
function staffTap(action: StaffAction, over: Partial<ActionEnvelope<ConsoleAction>> = {}): ActionEnvelope<ConsoleAction> {
  return { ...staleReady, operationKey: staffKey(action), action, ...over };
}

const step = (type: "start_preparing" | "mark_ready" | "mark_delivered", orderId: string, version = 1): StaffAction => ({ type, orderId, version });

const orderRow = (orderId: string) =>
  env.DB.prepare(`SELECT state, current_version, first_confirmed_at_ms, ready_at_ms, delivered_at_ms FROM orders WHERE id = ?`)
    .bind(orderId)
    .first();

const lastAudit = (orderId: string) =>
  env.DB.prepare(`SELECT kind, actor_id, at_ms, detail_json FROM audit_events WHERE subject_id = ? ORDER BY at_ms DESC, rowid DESC LIMIT 1`)
    .bind(orderId)
    .first<{ kind: string; actor_id: string; at_ms: number; detail_json: string }>()
    .then((row) => row && { ...row, detail: JSON.parse(row.detail_json) as unknown });

/** A confirmed order of the fixture's customer, as staff see it. */
async function confirmedOrder(s: Store) {
  const v1 = await placeFirstOrder(s);
  await confirm(s, v1.orderId, 1);
  return (await store.order(s.context(), v1.orderId))!.view;
}

describe("onConsoleAction: staff move an order along the list, every refusal answered by a read", () => {
  it("saves start_preparing, mark_line, mark_ready and mark_delivered with their rows, audits and notices", async () => {
    const s = await newStore();
    const confirmed = await confirmedOrder(s);
    const { orderId } = confirmed;
    expect(confirmed).toMatchObject({ state: "confirmado", queuePosition: 1 });

    const start = await engine.onConsoleAction(member(s), staffTap(step("start_preparing", orderId)));
    const preparing = { ...confirmed, state: "preparando" as const };
    expect(start.outcome).toEqual({ type: "action_saved", order: preparing });
    expect(start.notices).toEqual([]);
    // The order commit carries no post guards; its order_status fact carries P1 only (K2b).
    expect(start.commits.map((c) => c.post?.length ?? 0)).toEqual([0, 1]);
    await save(start);
    expect(await orderRow(orderId)).toEqual({
      state: "preparando",
      current_version: 1,
      first_confirmed_at_ms: T0 + 1000,
      ready_at_ms: null,
      delivered_at_ms: null,
    });
    expect(await lastAudit(orderId)).toMatchObject({
      kind: "order_preparing",
      actor_id: ids.staff,
      at_ms: T0 + 10_000,
      detail: { from: "confirmado", to: "preparando", version: 1 },
    });
    expect((await store.order(s.context(), orderId))?.view).toEqual(preparing);

    // Line marks keep preparando; the customer hears about a missing line and an offered one.
    const marks = [
      // The fixtures' marks, aimed at this order's lines.
      { type: "mark_line", orderId, version: 1, lineId: "L2", mark: "no_hay", substituteProductId: null },
      { type: "mark_line", orderId, version: 1, lineId: "L3", mark: "ofrecer_otro", substituteProductId: "product-mazola-1l" },
      { type: "mark_line", orderId, version: 1, lineId: "L4", mark: "listo", substituteProductId: null },
    ] as const satisfies readonly StaffAction[];
    expect(marks.map(({ mark, substituteProductId }) => ({ mark, substituteProductId })).slice(0, 2)).toEqual(
      [noHayAceite.action, offerMazola.action].map((a) => ({ mark: "mark" in a ? a.mark : null, substituteProductId: "substituteProductId" in a ? a.substituteProductId : null })),
    );
    const noticesOf = [] as unknown[];
    for (const [index, mark] of marks.entries()) {
      const marked = await engine.onConsoleAction(member(s, { nowMs: T0 + 11_000 + index }), staffTap(mark));
      expect(marked.outcome).toEqual({ type: "action_saved", order: preparing });
      expect(marked.commits.map((c) => c.post?.length ?? 0)).toEqual([0, 1]);
      noticesOf.push(marked.notices);
      await save(marked);
      expect(await lastAudit(orderId)).toMatchObject({
        kind: "order_line_marked",
        actor_id: ids.staff,
        detail: { from: "preparando", to: "preparando", version: 1, lineId: mark.lineId, mark: mark.mark, substituteProductId: mark.substituteProductId },
      });
    }
    expect(noticesOf).toEqual([
      [{ customerId: ids.customer, notice: { type: "line_unavailable", order: preparing, lineId: "L2" } }],
      [{ customerId: ids.customer, notice: { type: "substitute_offered", order: preparing, lineId: "L3" } }],
      [],
    ]);
    expect(await orderRow(orderId)).toMatchObject({ state: "preparando" });

    const ready = await engine.onConsoleAction(member(s, { nowMs: T0 + 20_000 }), staffTap(step("mark_ready", orderId)));
    const listo = { ...confirmed, state: "listo" as const, queuePosition: null };
    expect(ready).toMatchObject({
      outcome: { type: "action_saved", order: listo },
      notices: [{ customerId: ids.customer, notice: { type: "order_ready", order: listo } }],
    });
    await save(ready);
    expect(await orderRow(orderId)).toMatchObject({ state: "listo", ready_at_ms: T0 + 20_000, delivered_at_ms: null });
    expect(await lastAudit(orderId)).toMatchObject({ kind: "order_ready", actor_id: ids.staff, detail: { from: "preparando", to: "listo" } });
    expect((await store.order(s.context(), orderId))?.view).toEqual(listo);

    const owner = member(s, { memberId: "member-owner", role: "owner", nowMs: T0 + 30_000 });
    const delivered = await engine.onConsoleAction(
      owner,
      staffTap(step("mark_delivered", orderId), { actor: { type: "member", memberId: "member-owner", role: "owner" } }),
    );
    const entregado = { ...listo, state: "entregado" as const };
    expect(delivered).toMatchObject({ outcome: { type: "action_saved", order: entregado }, notices: [] });
    await save(delivered);
    expect(await orderRow(orderId)).toEqual({
      state: "entregado",
      current_version: 1,
      first_confirmed_at_ms: T0 + 1000,
      ready_at_ms: T0 + 20_000,
      delivered_at_ms: T0 + 30_000,
    });
    expect(await lastAudit(orderId)).toMatchObject({ kind: "order_delivered", actor_id: "member-owner", detail: { from: "listo", to: "entregado" } });
    // Off the list once delivered.
    expect(await engine.preparationList(s.context())).toEqual([]);
    expect(await footprint(s.businessId)).toEqual({ orders: 1, versions: 1, lines: 4, operations: 8, audit: 8 });
  });

  it("refuses mark_ready on a cancelled order from the read: invalid_state, nothing written", async () => {
    const s = await newStore();
    const confirmed = await confirmedOrder(s);
    await cancel(s, confirmed.orderId, 1);
    const before = await footprint(s.businessId);

    const refused = await engine.onConsoleAction(member(s), staffTap(step("mark_ready", confirmed.orderId)));
    expect(refused).toEqual({
      outcome: { type: "rejected", reason: "invalid_state", order: { ...confirmed, state: "cancelado", queuePosition: null } },
      notices: [],
      commits: [],
    });
    // Each other step from the wrong state is refused the same way.
    for (const type of ["start_preparing", "mark_delivered"] as const) {
      expect((await engine.onConsoleAction(member(s), staffTap(step(type, confirmed.orderId)))).outcome).toMatchObject({
        type: "rejected",
        reason: "invalid_state",
      });
    }
    const line = { type: "mark_line", orderId: confirmed.orderId, version: 1, lineId: "L1", mark: "listo", substituteProductId: null } as const;
    expect((await engine.onConsoleAction(member(s), staffTap(line))).outcome).toMatchObject({ reason: "invalid_state" });
    expect(await footprint(s.businessId)).toEqual(before);
  });

  it("lets the guard settle a race the read could not see: a cancel lands between the read and the save", async () => {
    const s = await newStore();
    const confirmed = await confirmedOrder(s);
    const start = await engine.onConsoleAction(member(s), staffTap(step("start_preparing", confirmed.orderId)));
    expect(start.outcome.type).toBe("action_saved");
    await cancel(s, confirmed.orderId, 1);
    const before = await footprint(s.businessId);

    await expect(save(start)).rejects.toThrow(/order_moved/);
    expect(await footprint(s.businessId)).toEqual(before);
    expect(await orderRow(confirmed.orderId)).toMatchObject({ state: "cancelado" });
  });

  it("answers a double tap from the read: duplicate with the first outcome, saved once", async () => {
    const s = await newStore();
    const confirmed = await confirmedOrder(s);
    const envelope = staffTap(step("start_preparing", confirmed.orderId));
    const first = await engine.onConsoleAction(member(s), envelope);
    await save(first);
    const before = await footprint(s.businessId);

    // The order is preparando now, so only the key read can answer this (a state check would say invalid_state).
    const again = await engine.onConsoleAction(member(s), envelope);
    expect(again).toEqual({ outcome: { type: "duplicate", first: first.outcome }, notices: [], commits: [] });
    await save(again);
    expect(await footprint(s.businessId)).toEqual(before);
    expect(await count(`operations WHERE business_id = ? AND operation_key = ?`, s.businessId, envelope.operationKey)).toBe(1);
  });

  it("refuses a tap on an older version as stale_version with the current view", async () => {
    const s = await newStore();
    const confirmed = await confirmedOrder(s);
    await changeAndApprove(s, addAndPickup, T0 + 2000);
    const v2 = (await store.order(s.context(), confirmed.orderId))!.view;
    expect(v2).toMatchObject({ version: 2, state: "confirmado" });
    const before = await footprint(s.businessId);

    const stale = await engine.onConsoleAction(member(s), staffTap(step("start_preparing", confirmed.orderId, 1)));
    expect(stale).toEqual({ outcome: { type: "rejected", reason: "stale_version", order: v2 }, notices: [], commits: [] });
    expect(await footprint(s.businessId)).toEqual(before);
  });

  it("refuses another store's order, a key it didn't derive, an unknown line and a spoofed actor", async () => {
    const s = await newStore();
    const other = await newStore();
    const confirmed = await confirmedOrder(s);
    const { orderId } = confirmed;
    const before = await footprint(s.businessId);
    const start = step("start_preparing", orderId);
    const refusal = (reason: string, order: unknown = null) => ({ outcome: { type: "rejected", reason, order }, notices: [], commits: [] });

    // Staff of another store: the order doesn't resolve there.
    expect(await engine.onConsoleAction(member(other), staffTap(start))).toEqual(refusal("not_found"));
    // D-44: the fixture's own key, a key for another action, and one for another order.
    for (const operationKey of [noHayAceite.operationKey, staffKey(step("mark_ready", orderId)), staffKey(step("start_preparing", "order-x"))]) {
      expect(await engine.onConsoleAction(member(s), staffTap(start, { operationKey }))).toEqual(refusal("not_allowed"));
    }
    const ghost = { type: "mark_line", orderId, version: 1, lineId: "L9", mark: "no_hay", substituteProductId: null } as const;
    await save(await engine.onConsoleAction(member(s), staffTap(start)));
    const preparing = (await store.order(s.context(), orderId))!.view;
    expect(await engine.onConsoleAction(member(s), staffTap(ghost))).toEqual(refusal("not_found", preparing));

    // The actor must be the signed-in member, as they are.
    for (const actor of [
      { type: "member", memberId: "member-someone-else", role: "staff" },
      { type: "member", memberId: ids.staff, role: "owner" },
      { type: "customer", customerId: ids.customer },
    ] as const) {
      expect(await engine.onConsoleAction(member(s), staffTap(step("mark_ready", orderId), { actor }))).toEqual(refusal("not_allowed"));
    }
    expect(await footprint(s.businessId)).toEqual({ ...before, operations: before.operations + 1, audit: before.audit + 1 });
  });

  it("refuses every console action that isn't a staff step as not_allowed, without throwing", async () => {
    const s = await newStore();
    const confirmed = await confirmedOrder(s);
    const before = await footprint(s.businessId);
    const actions: ConsoleAction[] = [
      { type: "match_line", orderId: confirmed.orderId, version: 1, lineId: "L1", productId: "p" },
      { type: "confirm_payment", paymentClaimId: "c" },
      { type: "reject_payment", paymentClaimId: "c" },
      { type: "approve_fiado", fiadoClaimId: "f" },
      { type: "propose_price", productId: "p", price: 100 },
      { type: "confirm_price", productId: "p", price: 100 },
      { type: "record_count", productId: "p", count: "3" },
      { type: "confirm_observation", observationId: "o" },
      { type: "set_pause", paused: true },
      { type: "reply_as_store", conversationId: "c", body: "hola" },
    ];
    const owner = member(s, { memberId: "member-owner", role: "owner", canApproveFiado: true });
    for (const action of actions) {
      const envelope = { operationKey: `staff:${action.type}`, actor: { type: "member", memberId: "member-owner", role: "owner" }, action } as const;
      expect(await engine.onConsoleAction(owner, envelope)).toEqual({
        outcome: { type: "rejected", reason: "not_allowed", order: null },
        notices: [],
        commits: [],
      });
    }
    expect(await footprint(s.businessId)).toEqual(before);
  });

  it("D-43: once preparando a customer cancel is refused, and an approved change stays preparando", async () => {
    const s = await newStore();
    const confirmed = await confirmedOrder(s);
    await save(await engine.onConsoleAction(member(s), staffTap(step("start_preparing", confirmed.orderId))));

    const cancelTap = await engine.onCustomerAction(
      s.context(),
      tap(confirmed.orderId, 1, { operationKey: `cancel:${confirmed.orderId}:v1`, action: { type: "cancel_order", orderId: confirmed.orderId, version: 1 } }),
    );
    expect(cancelTap.outcome).toMatchObject({ type: "rejected", reason: "invalid_state", order: { state: "preparando" } });

    await changeAndApprove(s, addAndPickup, T0 + 12_000);
    expect(await orderRow(confirmed.orderId)).toMatchObject({ state: "preparando", current_version: 2 });
    const [card] = await engine.preparationList(s.context());
    expect(card).toMatchObject({ order: { state: "preparando", version: 2 }, changedLineIds: ["L5"], confirmedAtMs: T0 + 1000 });
  });

  it("keys a tap by version: the same line marked again after an approved change is saved, not a duplicate", async () => {
    const s = await newStore();
    const confirmed = await confirmedOrder(s);
    const { orderId } = confirmed;
    await save(await engine.onConsoleAction(member(s), staffTap(step("start_preparing", orderId))));
    const markL2 = (version: number): StaffAction => ({ type: "mark_line", orderId, version, lineId: "L2", mark: "no_hay", substituteProductId: null });
    await save(await engine.onConsoleAction(member(s, { nowMs: T0 + 11_000 }), staffTap(markL2(1))));

    // The customer changes the order and the owner approves it (K12): it stays preparando, at v2.
    await changeAndApprove(s, addAndPickup, T0 + 12_000);
    const v2 = (await store.order(s.context(), orderId))!.view;
    expect(v2).toMatchObject({ state: "preparando", version: 2 });
    const before = await footprint(s.businessId);

    const again = await engine.onConsoleAction(member(s, { nowMs: T0 + 14_000 }), staffTap(markL2(2)));
    expect(again.outcome).toEqual({ type: "action_saved", order: v2 });
    expect(staffKey(markL2(2))).not.toBe(staffKey(markL2(1)));
    expect(again.notices).toEqual([{ customerId: ids.customer, notice: { type: "line_unavailable", order: v2, lineId: "L2" } }]);
    await save(again);
    expect(await footprint(s.businessId)).toEqual({ ...before, operations: before.operations + 1, audit: before.audit + 1 });
    expect(await count(`operations WHERE business_id = ? AND operation_key = ?`, s.businessId, staffKey(markL2(2)))).toBe(1);
    expect(await lastAudit(orderId)).toMatchObject({
      kind: "order_line_marked",
      actor_id: ids.staff,
      at_ms: T0 + 14_000,
      detail: { from: "preparando", to: "preparando", version: 2, lineId: "L2", mark: "no_hay" },
    });
  });
});
