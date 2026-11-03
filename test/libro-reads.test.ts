import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Claim } from "../src/domain/contract/outcomes";
import { D1LibroReads } from "../src/infrastructure/d1/libro-reads";
import { firstOrder, ids } from "./fixtures/contract";
import { T0, engine, newStore, placeFirstOrder, save, tap } from "./helpers/orders";

type Store = Awaited<ReturnType<typeof newStore>>;

const channelAccountOf = async (businessId: string) =>
  (await env.DB.prepare(`SELECT id FROM channel_accounts WHERE business_id = ?`).bind(businessId).first<{ id: string }>())!.id;

/** An outbox reply of the store carrying `claims` (null: a reply with no claims), with its delivery as given. */
async function insertReply(
  businessId: string,
  id: string,
  claims: readonly Claim[] | null,
  over: { providerStatus?: string | null; blockedAtMs?: number | null; status?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO outbound_messages (id, business_id, channel_account_id, recipient_hash, seq, kind, body_text, dedupe_key, status,
       expires_at_ms, created_at_ms, updated_at_ms, sent_at_ms, claims_json, provider_status, provider_status_at_s, claims_blocked_at_ms)
     VALUES (?, ?, ?, 'hash-synthetic', (SELECT COALESCE(MAX(seq), 0) + 1 FROM outbound_messages), 'reply', 'Tu pedido está confirmado.',
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      businessId,
      await channelAccountOf(businessId),
      `dedupe:${id}`,
      over.status ?? "sent",
      T0 + 3_600_000,
      T0 + 1_000,
      T0 + 1_000,
      T0 + 1_500,
      claims === null ? null : JSON.stringify(claims),
      over.providerStatus ?? null,
      over.providerStatus === undefined || over.providerStatus === null ? null : T0 / 1000 + 2,
      over.blockedAtMs ?? null,
    )
    .run();
}

async function insertCheck(businessId: string, id: string, over: { orderId: string; source: string; result: "pass" | "fail"; reason?: string; decidingFactId?: string }) {
  await env.DB.prepare(
    `INSERT INTO deed_checks (business_id, id, at_ms, source, subject_fact_id, order_id, claim_kind, result, reason_code, deciding_fact_id, operation_key)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?)`,
  )
    .bind(
      businessId,
      id,
      T0 + 2_000,
      over.source,
      over.orderId,
      over.result,
      over.result === "pass" ? null : (over.reason ?? "invalid_state"),
      over.decidingFactId ?? null,
      `staff:${over.orderId}:1:mark_ready`,
    )
    .run();
}

/** A placed order, confirmed by the customer: the store's order with its version and confirm facts. */
async function confirmedOrder(s: Store): Promise<{ orderId: string; confirmId: string }> {
  const placed = await placeFirstOrder(s, ids.customer, T0, firstOrder);
  await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1_000 }), tap(placed.orderId, 1)));
  const confirm = await env.DB.prepare(`SELECT id FROM facts WHERE business_id = ? AND kind = 'order_confirm' AND json_extract(body_json, '$.orderId') = ?`)
    .bind(s.businessId, placed.orderId)
    .first<{ id: string }>();
  return { orderId: placed.orderId, confirmId: confirm!.id };
}

const listo = (orderId: string, version = 1): Claim => ({ type: "order_state", orderId, version, state: "confirmado" });

describe("D1LibroReads: the order's replies, found through their claims", () => {
  it("returns the replies that carry a claim about this order, and no others", async () => {
    const s = await newStore();
    const { orderId } = await confirmedOrder(s);
    await insertReply(s.businessId, "m-mine", [listo(orderId)], { providerStatus: "delivered" });
    await insertReply(s.businessId, "m-other-order", [listo("order-elsewhere")]);
    await insertReply(s.businessId, "m-no-claims", null);
    const input = await new D1LibroReads(env.DB).read({ businessId: s.businessId }, orderId);
    expect(input?.replies.map((r) => r.id)).toEqual(["m-mine"]);
    expect(input?.replies[0]?.providerStatus).toBe("delivered");
    expect(input?.replies[0]?.claims).toEqual([listo(orderId)]);
  });

  it("leaves out a reply whose claims were blocked at send time: its delivery is of the safe reply", async () => {
    const s = await newStore();
    const { orderId } = await confirmedOrder(s);
    await insertReply(s.businessId, "m-blocked", [listo(orderId)], { blockedAtMs: T0 + 1_200, providerStatus: "delivered" });
    const input = await new D1LibroReads(env.DB).read({ businessId: s.businessId }, orderId);
    expect(input?.replies).toEqual([]);
  });
});

describe("D1LibroReads: the book and the world", () => {
  it("reads the order's facts with their liveness, and the member or session that witnessed each", async () => {
    const s = await newStore();
    const { orderId, confirmId } = await confirmedOrder(s);
    await env.DB.prepare(`INSERT INTO fact_evidence (business_id, fact_id, kind, ref_id) VALUES (?, ?, 'member', 'member-staff-1')`)
      .bind(s.businessId, confirmId)
      .run();
    const input = await new D1LibroReads(env.DB).read({ businessId: s.businessId }, orderId);
    const confirm = input?.facts.find((fact) => fact.id === confirmId);
    expect(confirm).toMatchObject({ kind: "order_confirm", version: 1, live: true, resumeState: "confirmado" });
    expect(confirm?.witness).toEqual({ kind: "member", refId: "member-staff-1" });
    expect(input?.facts.find((fact) => fact.kind === "order_version")?.witness).toBeNull();
  });

  it("reads the refused attempts on the order as refusals, never the claim checks", async () => {
    const s = await newStore();
    const { orderId, confirmId } = await confirmedOrder(s);
    await insertCheck(s.businessId, "chk-refused", { orderId, source: "gate", result: "fail", reason: "invalid_state", decidingFactId: confirmId });
    await insertCheck(s.businessId, "chk-claim", { orderId, source: "verify_claims", result: "fail", reason: "not_backed" });
    const input = await new D1LibroReads(env.DB).read({ businessId: s.businessId }, orderId);
    expect(input?.refusals).toEqual([
      { id: "chk-refused", atMs: T0 + 2_000, reason: "invalid_state", decidingFactId: confirmId, operationKey: `staff:${orderId}:1:mark_ready` },
    ]);
  });

  it("reads the order's lines per version, with a counted flag and the quantity as a decimal", async () => {
    const s = await newStore();
    const { orderId } = await confirmedOrder(s);
    const input = await new D1LibroReads(env.DB).read({ businessId: s.businessId }, orderId);
    expect(input?.lines.length).toBeGreaterThan(0);
    for (const line of input?.lines ?? []) {
      expect(line.version).toBe(1);
      expect(typeof line.counted).toBe("boolean");
      expect(line.quantity === null || /^\d+(\.\d{1,3})?$/.test(line.quantity)).toBe(true);
    }
  });
});

describe("D1LibroReads: isolation and absence", () => {
  it("never shows another store's replies, facts or checks on this order", async () => {
    const mine = await newStore();
    const { orderId, confirmId } = await confirmedOrder(mine);
    const theirs = await newStore();
    await insertReply(theirs.businessId, "m-theirs", [listo(orderId)], { providerStatus: "delivered" });
    await insertCheck(theirs.businessId, "chk-theirs", { orderId, source: "gate", result: "fail", decidingFactId: confirmId });
    const input = await new D1LibroReads(env.DB).read({ businessId: mine.businessId }, orderId);
    expect(input?.replies).toEqual([]);
    expect(input?.refusals).toEqual([]);
    expect(input?.facts.every((fact) => fact.id !== "m-theirs")).toBe(true);
  });

  it("answers null for another store's order, and for an order that does not exist", async () => {
    const mine = await newStore();
    const { orderId } = await confirmedOrder(mine);
    const theirs = await newStore();
    const reads = new D1LibroReads(env.DB);
    expect(await reads.read({ businessId: theirs.businessId }, orderId)).toBeNull();
    expect(await reads.read({ businessId: mine.businessId }, "order-that-is-not-here")).toBeNull();
  });
});
