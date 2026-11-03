/**
 * The Orders screen's read model: every order and why it is in its state, read from the ledger.
 * Read-only. Colours come from live facts, never from `orders.state`. Every query is scoped to the
 * store; an order of another store is simply not found.
 */
import type { Tenant } from "../../application/ports";
import type { LineDiff, OrderState } from "../../domain/contract/outcomes";
import { type OrderFact, deriveOrderState } from "../../domain/order-state";
import { orderCode } from "../../domain/order-code";

export type OrderColour = "yellow" | "red" | "check" | "blue" | "none";

/** Who took the order out (K13): the member the dispatch fact records, with the store's name for them. */
export interface Courier {
  readonly memberId: string;
  readonly name: string | null;
}

/** How the current version leaves the store; null when nobody recorded it. */
export type FulfillmentMode = "pickup" | "delivery" | null;

export interface OrderListRow {
  readonly orderId: string;
  readonly code: string | null;
  readonly customerLabel: string;
  readonly lines: readonly { readonly text: string; readonly quantity: string | null }[];
  readonly state: OrderState;
  readonly colour: OrderColour;
  /** The courier of the live dispatch (K13); null when the order isn't out. */
  readonly courier: Courier | null;
}

type TrailKind = OrderFact["kind"] | "change_request" | "change_review";

export interface TrailEntry {
  readonly factId: string;
  readonly kind: TrailKind;
  readonly recordedAtMs: number;
  /** The operation key the fact was recorded under: one action on one version, so the Deed can name it. */
  readonly operationKey: string;
  readonly actor: string;
  readonly evidence: readonly { readonly kind: string; readonly refId: string }[];
  readonly closedBy: { readonly factId: string; readonly reason: "cancelled" | "superseded"; readonly atMs: number } | null;
  readonly dependsOn: readonly string[];
  readonly blocks: readonly string[];
  /** change_review only: the answer and its reason, as the member wrote it. */
  readonly review: { readonly decision: "approve" | "decline"; readonly reason: string } | null;
  /** A dispatch only (K13): the courier it records. */
  readonly courier: Courier | null;
}

export interface OrderTrail {
  readonly code: string | null;
  readonly state: OrderState;
  readonly version: number;
  readonly changed: boolean;
  readonly cancelled: boolean;
  readonly delivered: boolean;
  readonly dispatched: boolean;
  readonly fulfillment: FulfillmentMode;
  /** The courier of the live dispatch (K13); null when the order isn't out. */
  readonly courier: Courier | null;
  /** The customer's change waiting for review (K12), with what it would change; null when none. */
  readonly openRequest: { readonly id: string; readonly diff: LineDiff } | null;
  readonly facts: readonly TrailEntry[];
}

/** What the facts of one order say, whatever the order's cache says. */
interface Standing {
  readonly changed: boolean;
  readonly cancelled: boolean;
  readonly delivered: boolean;
  readonly dispatched: boolean;
}

interface FactRow {
  id: string;
  order_id: string;
  kind: TrailKind;
  operation_key: string;
  body_json: string;
  recorded_at_ms: number;
  depends_json: string;
  live: number;
}

const ORDER_KINDS = `('order_version', 'order_confirm', 'order_cancel', 'order_status', 'change_request', 'change_review')`;

const isOrderFact = (row: FactRow): row is FactRow & { kind: OrderFact["kind"] } =>
  row.kind !== "change_request" && row.kind !== "change_review";

/**
 * Order facts with liveness, for one order (?2) or every order of the store (?2 NULL). Liveness is
 * the rule of `D1OrderStore.orderFacts`: no ancestor, itself included, is closed, except by a
 * supersede from another of its own ancestors.
 */
export const FACTS_SQL = `WITH RECURSIVE
  mine AS (
    SELECT id, kind, body_json, recorded_at_ms, operation_key, json_extract(body_json, '$.orderId') AS order_id, rowid AS seq FROM facts
    WHERE business_id = ?1 AND kind IN ${ORDER_KINDS} AND (?2 IS NULL OR json_extract(body_json, '$.orderId') = ?2)
  ),
  anc(root, id) AS (
    SELECT id, id FROM mine
    UNION
    SELECT a.root, d.depends_on_fact_id FROM fact_dependencies d JOIN anc a ON d.fact_id = a.id WHERE d.business_id = ?1
  )
SELECT m.id, m.order_id, m.kind, m.body_json, m.recorded_at_ms, m.operation_key,
  (SELECT json_group_array(d.depends_on_fact_id) FROM fact_dependencies d WHERE d.business_id = ?1 AND d.fact_id = m.id) AS depends_json,
  NOT EXISTS (
    SELECT 1 FROM fact_closures c JOIN anc a ON c.fact_id = a.id AND a.root = m.id
    WHERE c.business_id = ?1 AND NOT (c.reason = 'superseded' AND c.closed_by_fact_id IN (SELECT id FROM anc WHERE root = m.id))
  ) AS live
FROM mine m ORDER BY m.recorded_at_ms, m.seq`;

const toOrderFact = (row: FactRow & { kind: OrderFact["kind"] }): OrderFact => {
  const body = JSON.parse(row.body_json) as { version: number; resumeState?: OrderFact["resumeState"]; status?: OrderFact["status"] };
  return {
    id: row.id,
    kind: row.kind,
    live: row.live === 1,
    version: body.version,
    dependsOn: JSON.parse(row.depends_json) as string[],
    resumeState: body.resumeState ?? null,
    status: body.status ?? null,
  };
};

/** The customer's change waiting for review: the latest live change_request. */
const openRequestOf = (rows: readonly FactRow[]): FactRow | null =>
  rows.filter((row) => row.kind === "change_request" && row.live === 1).at(-1) ?? null;

/**
 * Yellow: a change waits for review (K12), or the live version is past v1 and no review approved it
 * (a change before confirming, waiting for the customer). An approved change is back to normal.
 * Red: a live cancel. Check: a live delivered tap. Blue: a live dispatch (K13), out with a courier.
 */
function standingOf(rows: readonly FactRow[]): Standing {
  const live = rows.filter((row) => row.live === 1);
  const orderFacts = live.filter(isOrderFact).map(toOrderFact);
  const reviews = new Set(rows.filter((row) => row.kind === "change_review").map((row) => row.id));
  const latest = orderFacts.filter((fact) => fact.kind === "order_version").sort((a, b) => b.version - a.version)[0];
  const unreviewedChange = latest !== undefined && latest.version > 1 && !latest.dependsOn.some((id) => reviews.has(id));
  return {
    changed: openRequestOf(rows) !== null || unreviewedChange,
    cancelled: orderFacts.some((fact) => fact.kind === "order_cancel"),
    delivered: orderFacts.some((fact) => fact.kind === "order_status" && fact.status === "delivered"),
    dispatched: orderFacts.some((fact) => fact.kind === "order_status" && fact.status === "dispatched"),
  };
}

/** The member a dispatch fact records, named from the store's members; null for any other fact. */
const courierOf = (row: FactRow, names: ReadonlyMap<string, string | null>): Courier | null => {
  if (row.kind !== "order_status") return null;
  const body = JSON.parse(row.body_json) as { status?: string; courierMemberId?: string };
  if (body.status !== "dispatched" || typeof body.courierMemberId !== "string") return null;
  return { memberId: body.courierMemberId, name: names.get(body.courierMemberId) ?? null };
};

/** The courier of the latest live dispatch. */
const liveCourierOf = (rows: readonly FactRow[], names: ReadonlyMap<string, string | null>): Courier | null =>
  rows
    .filter((row) => row.live === 1)
    .map((row) => courierOf(row, names))
    .filter((courier) => courier !== null)
    .at(-1) ?? null;

/** The current version is the highest live version fact; the `orders.current_version` cache is only a last resort. */
const currentVersionOf = (rows: readonly FactRow[], cached: number): number => {
  const live = rows.filter(isOrderFact).filter((row) => row.kind === "order_version" && row.live === 1).map((row) => toOrderFact(row).version);
  return live.length === 0 ? cached : Math.max(...live);
};

const colourOf = (s: Standing): OrderColour =>
  s.cancelled ? "red" : s.delivered ? "check" : s.changed ? "yellow" : s.dispatched ? "blue" : "none";

/** The code comes from the order's latest confirm fact, live or not, so a change does not blank it. */
const confirmIdOf = (rows: readonly FactRow[]): string | null => rows.filter((row) => row.kind === "order_confirm").at(-1)?.id ?? null;

const quantityText = (milli: number | null): string | null => {
  if (milli === null) return null;
  const whole = Math.trunc(milli / 1000);
  const fraction = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
};

const reviewOf = (row: FactRow): TrailEntry["review"] => {
  const body = JSON.parse(row.body_json) as { decision: "approve" | "decline"; reason: string };
  return { decision: body.decision, reason: body.reason };
};

export class D1OrderTrail {
  constructor(private readonly db: D1Database) {}

  /** The store's active members, who may take an order out (K13, Q4: any of them). */
  async activeMembers(tenant: Tenant): Promise<Courier[]> {
    const { results } = await this.db
      .prepare(
        `SELECT m.user_id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.business_id = ?1 AND m.active = 1 ORDER BY u.display_name, m.user_id`,
      )
      .bind(tenant.businessId)
      .all<{ user_id: string; display_name: string | null }>();
    return results.map((row) => ({ memberId: row.user_id, name: row.display_name }));
  }

  /** Every member's name, active or not: a courier keeps their name in the trail once they leave. */
  private async memberNames(tenant: Tenant): Promise<Map<string, string | null>> {
    const { results } = await this.db
      .prepare(`SELECT m.user_id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = ?1`)
      .bind(tenant.businessId)
      .all<{ user_id: string; display_name: string | null }>();
    return new Map(results.map((row) => [row.user_id, row.display_name]));
  }

  async listOrders(tenant: Tenant): Promise<OrderListRow[]> {
    const [orders, facts, lines, names] = await Promise.all([
      this.db
        .prepare(`SELECT id, state, current_version FROM orders WHERE business_id = ?1 ORDER BY created_at_ms DESC, id`)
        .bind(tenant.businessId)
        .all<{ id: string; state: OrderState; current_version: number }>(),
      this.db.prepare(FACTS_SQL).bind(tenant.businessId, null).all<FactRow>(),
      this.db
        .prepare(
          `SELECT l.order_id, l.version, l.customer_text, l.qty_milli, p.canonical_name FROM order_lines l
           LEFT JOIN products p ON p.business_id = l.business_id AND p.id = l.product_id
           WHERE l.business_id = ?1 ORDER BY l.order_id, l.version, l.line_no`,
        )
        .bind(tenant.businessId)
        .all<{ order_id: string; version: number; customer_text: string; qty_milli: number | null; canonical_name: string | null }>(),
      this.memberNames(tenant),
    ]);
    const factsByOrder = Map.groupBy(facts.results, (row) => row.order_id);
    const rows: OrderListRow[] = [];
    for (const order of orders.results) {
      const mine = factsByOrder.get(order.id) ?? [];
      const hasLiveVersion = mine.some((row) => row.kind === "order_version" && row.live === 1);
      if (!hasLiveVersion) continue;
      const currentVersion = currentVersionOf(mine, order.current_version);
      rows.push({
        orderId: order.id,
        code: await orderCode(confirmIdOf(mine)),
        customerLabel: "Cliente",
        lines: lines.results
          .filter((line) => line.order_id === order.id && line.version === currentVersion)
          .map((line) => ({ text: line.canonical_name ?? line.customer_text, quantity: quantityText(line.qty_milli) })),
        state: deriveOrderState(mine.filter(isOrderFact).map(toOrderFact), currentVersion, order.state),
        colour: colourOf(standingOf(mine)),
        courier: liveCourierOf(mine, names),
      });
    }
    return rows;
  }

  /** Null when the order does not exist in this store. */
  async trail(tenant: Tenant, orderId: string): Promise<OrderTrail | null> {
    const order = await this.db
      .prepare(`SELECT state, current_version FROM orders WHERE business_id = ?1 AND id = ?2`)
      .bind(tenant.businessId, orderId)
      .first<{ state: OrderState; current_version: number }>();
    if (order === null) return null;
    const { results: rows } = await this.db.prepare(FACTS_SQL).bind(tenant.businessId, orderId).all<FactRow>();
    const ids = rows.map((row) => row.id);
    const [evidence, closures, edges, names, version] = await Promise.all([
      this.db
        .prepare(`SELECT fact_id, kind, ref_id FROM fact_evidence WHERE business_id = ?1 ORDER BY kind, ref_id`)
        .bind(tenant.businessId)
        .all<{ fact_id: string; kind: string; ref_id: string }>(),
      this.db
        .prepare(`SELECT fact_id, closed_by_fact_id, reason, closed_at_ms FROM fact_closures WHERE business_id = ?1`)
        .bind(tenant.businessId)
        .all<{ fact_id: string; closed_by_fact_id: string; reason: "cancelled" | "superseded"; closed_at_ms: number }>(),
      this.db
        .prepare(`SELECT fact_id, depends_on_fact_id FROM fact_dependencies WHERE business_id = ?1`)
        .bind(tenant.businessId)
        .all<{ fact_id: string; depends_on_fact_id: string }>(),
      this.memberNames(tenant),
      this.db
        .prepare(`SELECT fulfillment_mode FROM order_versions WHERE business_id = ?1 AND order_id = ?2 AND version = ?3`)
        .bind(tenant.businessId, orderId, currentVersionOf(rows, order.current_version))
        .first<{ fulfillment_mode: FulfillmentMode }>(),
    ]);
    const entries: TrailEntry[] = rows.map((row) => {
      const proof = evidence.results.filter((e) => e.fact_id === row.id).map((e) => ({ kind: e.kind, refId: e.ref_id }));
      const closure = closures.results.find((c) => c.fact_id === row.id);
      return {
        factId: row.id,
        kind: row.kind,
        recordedAtMs: row.recorded_at_ms,
        operationKey: row.operation_key,
        actor: proof.some((e) => e.kind === "member") ? "Personal" : "Cliente",
        evidence: proof,
        closedBy: closure === undefined ? null : { factId: closure.closed_by_fact_id, reason: closure.reason, atMs: closure.closed_at_ms },
        dependsOn: ids.filter((id) => edges.results.some((e) => e.fact_id === row.id && e.depends_on_fact_id === id)),
        blocks: ids.filter((id) => edges.results.some((e) => e.depends_on_fact_id === row.id && e.fact_id === id)),
        review: row.kind === "change_review" ? reviewOf(row) : null,
        courier: courierOf(row, names),
      };
    });
    const currentVersion = currentVersionOf(rows, order.current_version);
    const open = openRequestOf(rows);
    return {
      code: await orderCode(confirmIdOf(rows)),
      state: deriveOrderState(rows.filter(isOrderFact).map(toOrderFact), currentVersion, order.state),
      version: currentVersion,
      ...standingOf(rows),
      fulfillment: version?.fulfillment_mode ?? null,
      courier: liveCourierOf(rows, names),
      openRequest: open === null ? null : { id: open.id, diff: (JSON.parse(open.body_json) as { diff: LineDiff }).diff },
      facts: entries,
    };
  }
}
