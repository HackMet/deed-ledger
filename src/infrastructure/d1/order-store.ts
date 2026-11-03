import { OrderMovedError } from "../../application/errors";
import {
  fromThousandths,
  type OrderHead,
  type PriceState,
  type OrderStore,
  type OrderWrite,
  type StoredChangeRequest,
  type StoredOrder,
} from "../../application/engine/order-engine";
import type { CatalogProduct } from "../../application/perception/matching";
import { MAX_CATALOG_LABELS } from "../../application/perception/matching";
import type { Commit, Tenant } from "../../application/ports";
import type { EngineOutcome, OrderLineView, OrderState, OrderView } from "../../domain/contract/outcomes";
import { toThousandths } from "../../domain/contract/numbers";
import type { OrderFact } from "../../domain/order-state";
import { isExcludedFromTotal } from "../../domain/order-total";
import { labelOf } from "../../domain/orders";
import type { Guard } from "./fence";

/** Not entregado, not cancelado (D-39). */
const OPEN = `state NOT IN ('entregado', 'cancelado')`;

/**
 * Holding a place on the preparation list: confirmed at least once and not finished. An order
 * changed after confirming waits in por_confirmar but keeps its place (D-38).
 */
const IN_LINE = `first_confirmed_at_ms IS NOT NULL AND state IN ('por_confirmar', 'confirmado', 'preparando')`;

interface OrderRow {
  id: string;
  customer_id: string;
  state: OrderState;
  current_version: number;
  first_confirmed_at_ms: number | null;
  fulfillment_mode: "pickup" | "delivery" | null;
  place_id: string | null;
  place_text: string | null;
  delivery_fee_centavos: number | null;
  total_centavos: number | null;
  version_fact_id: string | null;
  confirm_fact_id: string | null;
}

interface ChangeFactRow {
  id: string;
  kind: "change_request" | "change_review";
  body_json: string;
  recorded_at_ms: number;
  live: number;
  job_id: string | null;
}

/**
 * The change requests and reviews of one order (?2) with liveness: no ancestor, itself included, is
 * closed, except by a supersede from another of its own ancestors (the rule of `orderFacts`). A request
 * answered by a review, replaced by a newer request, or resting on a cancelled confirm isn't live.
 */
const CHANGE_FACTS_SQL = `WITH RECURSIVE
  mine AS (
    SELECT id, kind, body_json, recorded_at_ms, rowid AS seq FROM facts
    WHERE business_id = ?1 AND kind IN ('change_request', 'change_review') AND json_extract(body_json, '$.orderId') = ?2
  ),
  anc(root, id) AS (
    SELECT id, id FROM mine
    UNION
    SELECT a.root, d.depends_on_fact_id FROM fact_dependencies d JOIN anc a ON d.fact_id = a.id WHERE d.business_id = ?1
  )
SELECT m.id, m.kind, m.body_json, m.recorded_at_ms,
  NOT EXISTS (
    SELECT 1 FROM fact_closures c JOIN anc a ON c.fact_id = a.id AND a.root = m.id
    WHERE c.business_id = ?1 AND NOT (c.reason = 'superseded' AND c.closed_by_fact_id IN (SELECT id FROM anc WHERE root = m.id))
  ) AS live,
  (SELECT e.ref_id FROM fact_evidence e WHERE e.business_id = ?1 AND e.fact_id = m.id AND e.kind = 'inbound_message'
   ORDER BY e.ref_id LIMIT 1) AS job_id
FROM mine m ORDER BY m.recorded_at_ms, m.seq`;

interface LineRow {
  line_no: number;
  product_id: string | null;
  product_name: string | null;
  customer_text: string;
  qty_milli: number | null;
  unit_price_centavos: number | null;
  unit: string | null;
  restricted: number;
}

const ORDER_SELECT = `SELECT o.id, o.customer_id, o.state, o.current_version, o.first_confirmed_at_ms,
    o.version_fact_id, o.confirm_fact_id, v.fulfillment_mode, v.place_id, v.place_text, v.delivery_fee_centavos, v.total_centavos
  FROM orders o
  JOIN order_versions v ON v.business_id = o.business_id AND v.order_id = o.id AND v.version = o.current_version`;

/**
 * The engine's reads and writes of orders. Every read is scoped to the store and the customer;
 * every write is a `Commit` that runs in the job's completion batch, guarded by what the decision
 * read. The guards insert into batch_guards, whose CHECK (ok = 1) fails the batch loudly.
 */
export class D1OrderStore implements OrderStore {
  constructor(private readonly db: D1Database) {}

  async firstOutcome(tenant: Tenant, operationKey: string): Promise<EngineOutcome | null> {
    const row = await this.db
      .prepare(`SELECT outcome_json FROM operations WHERE business_id = ? AND operation_key = ?`)
      .bind(tenant.businessId, operationKey)
      .first<{ outcome_json: string }>();
    return row === null ? null : (JSON.parse(row.outcome_json) as EngineOutcome);
  }

  async openOrder(tenant: Tenant, customerId: string): Promise<StoredOrder | null> {
    const row = await this.db
      .prepare(`${ORDER_SELECT} WHERE o.business_id = ? AND o.customer_id = ? AND o.${OPEN} ORDER BY o.created_at_ms DESC LIMIT 1`)
      .bind(tenant.businessId, customerId)
      .first<OrderRow>();
    return row === null ? null : this.load(tenant, row);
  }

  async order(tenant: Tenant, orderId: string): Promise<StoredOrder | null> {
    const row = await this.db
      .prepare(`${ORDER_SELECT} WHERE o.business_id = ? AND o.id = ?`)
      .bind(tenant.businessId, orderId)
      .first<OrderRow>();
    return row === null ? null : this.load(tenant, row);
  }

  async customerOrder(tenant: Tenant, customerId: string, orderId: string): Promise<StoredOrder | null> {
    const row = await this.db
      .prepare(`${ORDER_SELECT} WHERE o.business_id = ? AND o.customer_id = ? AND o.id = ?`)
      .bind(tenant.businessId, customerId, orderId)
      .first<OrderRow>();
    return row === null ? null : this.load(tenant, row);
  }

  async products(tenant: Tenant): Promise<readonly CatalogProduct[]> {
    // The `products` table only: store_products (Angel's Tienda screens) is a different table. No aliases or
    // barcodes are kept for `products` rows, so the matching by code has only the names.
    const { results } = await this.db
      .prepare(`SELECT id, canonical_name FROM products WHERE business_id = ? ORDER BY canonical_name COLLATE NOCASE, id LIMIT ?`)
      .bind(tenant.businessId, MAX_CATALOG_LABELS)
      .all<{ id: string; canonical_name: string }>();
    return results.map((row) => ({ productId: row.id, names: [row.canonical_name], aliases: [], barcode: null }));
  }

  async productNames(tenant: Tenant, productIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (productIds.length === 0) return new Map();
    const { results } = await this.db
      .prepare(`SELECT id, canonical_name FROM products WHERE business_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(tenant.businessId, JSON.stringify(productIds))
      .all<{ id: string; canonical_name: string }>();
    return new Map(results.map((row) => [row.id, row.canonical_name]));
  }

  async orderHead(tenant: Tenant, orderId: string): Promise<OrderHead | null> {
    const row = await this.db
      .prepare(
        `SELECT o.current_version AS version, o.state, v.total_centavos AS total
         FROM orders o
         JOIN order_versions v ON v.business_id = o.business_id AND v.order_id = o.id AND v.version = o.current_version
         WHERE o.business_id = ? AND o.id = ?`,
      )
      .bind(tenant.businessId, orderId)
      .first<OrderHead>();
    return row ?? null;
  }

  async orderFacts(tenant: Tenant, orderId: string): Promise<readonly OrderFact[]> {
    // Liveness per fact: no ancestor (itself included) is closed, except by a supersede from another
    // of its ancestors. Mirrors KILLING_CLOSURE in fact-ledger.ts, the rule G4 enforces.
    const { results } = await this.db
      .prepare(
        `WITH RECURSIVE
           mine AS (
             SELECT id, kind, body_json FROM facts
             WHERE business_id = ?1 AND kind IN ('order_version', 'order_confirm', 'order_cancel', 'order_status')
               AND json_extract(body_json, '$.orderId') = ?2
           ),
           anc(root, id) AS (
             SELECT id, id FROM mine
             UNION
             SELECT a.root, d.depends_on_fact_id FROM fact_dependencies d JOIN anc a ON d.fact_id = a.id WHERE d.business_id = ?1
           )
         SELECT m.id, m.kind, m.body_json,
           (SELECT json_group_array(d.depends_on_fact_id) FROM fact_dependencies d
            WHERE d.business_id = ?1 AND d.fact_id = m.id) AS depends_json,
           NOT EXISTS (
             SELECT 1 FROM fact_closures c JOIN anc a ON c.fact_id = a.id AND a.root = m.id
             WHERE c.business_id = ?1
               AND NOT (c.reason = 'superseded' AND c.closed_by_fact_id IN (SELECT id FROM anc WHERE root = m.id))
           ) AS live
         FROM mine m`,
      )
      .bind(tenant.businessId, orderId)
      .all<{ id: string; kind: OrderFact["kind"]; body_json: string; depends_json: string; live: number }>();
    return results.map((row) => {
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
    });
  }

  async courier(tenant: Tenant, memberId: string): Promise<{ readonly memberId: string; readonly name: string | null } | null> {
    // Memberships are the store's members (0001); a deactivated one can't take an order out.
    const row = await this.db
      .prepare(
        `SELECT m.user_id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.business_id = ? AND m.user_id = ? AND m.active = 1`,
      )
      .bind(tenant.businessId, memberId)
      .first<{ user_id: string; display_name: string | null }>();
    return row === null ? null : { memberId: row.user_id, name: row.display_name };
  }

  async changeRequest(tenant: Tenant, changeRequestId: string): Promise<StoredChangeRequest | null> {
    const row = await this.db
      .prepare(`SELECT json_extract(body_json, '$.orderId') AS order_id FROM facts WHERE business_id = ? AND id = ? AND kind = 'change_request'`)
      .bind(tenant.businessId, changeRequestId)
      .first<{ order_id: string }>();
    if (row === null) return null;
    const { requests } = await this.changeFacts(tenant, row.order_id);
    return requests.find((request) => request.id === changeRequestId) ?? null;
  }

  /** Every change request of an order, oldest first, and its latest review. */
  private async changeFacts(
    tenant: Tenant,
    orderId: string,
  ): Promise<{ readonly requests: readonly StoredChangeRequest[]; readonly lastReview: OrderView["lastReview"] }> {
    const { results } = await this.db.prepare(CHANGE_FACTS_SQL).bind(tenant.businessId, orderId).all<ChangeFactRow>();
    const requests: StoredChangeRequest[] = [];
    let lastReview: OrderView["lastReview"] = null;
    for (const row of results) {
      if (row.kind === "change_review") {
        const body = JSON.parse(row.body_json) as { decision: "approve" | "decline"; reason: string };
        lastReview = { decision: body.decision, reason: body.reason, atMs: row.recorded_at_ms };
        continue;
      }
      const body = JSON.parse(row.body_json) as Pick<StoredChangeRequest, "version" | "lines" | "fulfillment" | "diff">;
      requests.push({
        id: row.id,
        orderId,
        version: body.version,
        lines: body.lines,
        fulfillment: body.fulfillment,
        diff: body.diff,
        jobId: row.job_id,
        live: row.live === 1,
      });
    }
    return { requests, lastReview };
  }

  async preparationOrders(tenant: Tenant): Promise<readonly StoredOrder[]> {
    const { results } = await this.db
      .prepare(
        `${ORDER_SELECT} WHERE o.business_id = ? AND o.state IN ('confirmado', 'preparando', 'listo')
           AND o.first_confirmed_at_ms IS NOT NULL
         ORDER BY o.first_confirmed_at_ms, o.id`,
      )
      .bind(tenant.businessId)
      .all<OrderRow>();
    return Promise.all(results.map((row) => this.load(tenant, row)));
  }

  async changedLineIds(tenant: Tenant, orderId: string, version: number): Promise<readonly string[]> {
    if (version <= 1) return [];
    const { results } = await this.db
      .prepare(
        `SELECT c.line_no FROM order_lines c
         LEFT JOIN order_lines p ON p.business_id = c.business_id AND p.order_id = c.order_id
           AND p.version = c.version - 1 AND p.line_no = c.line_no
         WHERE c.business_id = ? AND c.order_id = ? AND c.version = ?
           AND (p.line_no IS NULL OR c.product_id IS NOT p.product_id OR c.customer_text IS NOT p.customer_text
             OR c.qty_milli IS NOT p.qty_milli OR c.unit IS NOT p.unit)
         ORDER BY c.line_no`,
      )
      .bind(tenant.businessId, orderId, version)
      .all<{ line_no: number }>();
    return results.map((row) => labelOf(row.line_no - 1));
  }

  async queuePosition(tenant: Tenant, orderId: string, confirmedAtMs: number): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT count(*) AS ahead FROM orders
         WHERE business_id = ? AND id <> ? AND ${IN_LINE}
           AND (first_confirmed_at_ms < ? OR (first_confirmed_at_ms = ? AND id < ?))`,
      )
      .bind(tenant.businessId, orderId, confirmedAtMs, confirmedAtMs, orderId)
      .first<{ ahead: number }>();
    return (row?.ahead ?? 0) + 1;
  }

  async priceState(tenant: Tenant, productId: string, operationKey: string): Promise<PriceState> {
    const used = await this.db
      .prepare(`SELECT 1 AS used FROM facts WHERE business_id = ? AND operation_key = ?`)
      .bind(tenant.businessId, operationKey)
      .first<{ used: number }>();
    // Newest first. A price fact is closed only by a newer confirmed price (superseded), and a proposal
    // is never closed, so "live" is simply "no closure".
    const { results } = await this.db
      .prepare(
        `SELECT f.id, json_extract(f.body_json, '$.status') AS status, json_extract(f.body_json, '$.price') AS price
         FROM facts f
         WHERE f.business_id = ? AND f.kind = 'price' AND json_extract(f.body_json, '$.productId') = ?
           AND NOT EXISTS (SELECT 1 FROM fact_closures c WHERE c.business_id = f.business_id AND c.fact_id = f.id)
         ORDER BY f.rowid DESC`,
      )
      .bind(tenant.businessId, productId)
      .all<{ id: string; status: string; price: number }>();
    const confirmedAt = results.findIndex((row) => row.status === "confirmed");
    const confirmed = confirmedAt === -1 ? null : results[confirmedAt]!;
    // Rows before the confirmed one are newer; a proposal older than it was already answered.
    const proposal = results.slice(0, confirmedAt === -1 ? undefined : confirmedAt).find((row) => row.status === "proposed") ?? null;
    return {
      confirmed: confirmed === null ? null : { factId: confirmed.id, price: confirmed.price },
      proposal: proposal === null ? null : { factId: proposal.id, price: proposal.price },
      keyUsed: used !== null,
    };
  }

  commitFor(tenant: Tenant, write: OrderWrite): Commit {
    const businessId = tenant.businessId;
    const guards: Guard[] = [];
    const statements: D1PreparedStatement[] = [];
    const { order } = write;

    if (write.base === null) {
      guards.push({
        holdsSql: `SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM orders WHERE business_id = ? AND customer_id = ? AND ${OPEN}) THEN 1 END`,
        params: [businessId, write.customerId],
        error: () => new OrderMovedError("open_order_exists"),
      });
      statements.push(
        this.db
          .prepare(
            `INSERT INTO orders (id, business_id, customer_id, state, current_version, created_at_ms, version_fact_id,
               confirm_fact_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            order.orderId,
            businessId,
            write.customerId,
            order.state,
            order.version,
            write.nowMs,
            write.facts.versionFactId,
            write.facts.confirmFactId,
          ),
      );
    } else {
      // Ownership, version and state, exactly as read.
      guards.push({
        holdsSql: `SELECT 1 FROM orders WHERE business_id = ? AND id = ? AND customer_id = ? AND current_version = ? AND state = ?`,
        params: [businessId, write.base.orderId, write.customerId, write.base.version, write.base.state],
        error: () => new OrderMovedError("order_moved"),
      });
      statements.push(
        this.db
          .prepare(
            `UPDATE orders SET state = ?1, current_version = ?2,
               first_confirmed_at_ms = CASE WHEN ?3 THEN COALESCE(first_confirmed_at_ms, ?4) ELSE first_confirmed_at_ms END,
               ready_at_ms = CASE WHEN ?1 = 'listo' THEN COALESCE(ready_at_ms, ?4) ELSE ready_at_ms END,
               delivered_at_ms = CASE WHEN ?1 = 'entregado' THEN COALESCE(delivered_at_ms, ?4) ELSE delivered_at_ms END,
               version_fact_id = ?8, confirm_fact_id = ?9
             WHERE business_id = ?5 AND id = ?6 AND customer_id = ?7`,
          )
          .bind(
            order.state,
            order.version,
            write.confirming ? 1 : 0,
            write.nowMs,
            businessId,
            order.orderId,
            write.customerId,
            write.facts.versionFactId,
            write.facts.confirmFactId,
          ),
      );
    }

    if (write.newVersion) {
      // UNIQUE (business_id, order_id, version): a version is written once.
      const f = order.fulfillment;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO order_versions (business_id, order_id, version, state, total_centavos, fulfillment_mode, place_id,
               place_text, delivery_fee_centavos, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            businessId,
            order.orderId,
            order.version,
            order.state,
            order.total,
            f?.mode ?? null,
            f?.mode === "delivery" ? f.placeId : null,
            f?.mode === "delivery" ? f.placeText : null,
            f?.mode === "delivery" ? f.fee : null,
            write.nowMs,
          ),
        ...order.lines.map((line, index) =>
          this.db
            .prepare(
              `INSERT INTO order_lines (business_id, order_id, version, line_no, product_id, customer_text, qty_milli,
                 unit_price_centavos, excluded_from_total, unit, restricted)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              businessId,
              order.orderId,
              order.version,
              index + 1,
              line.productId,
              line.text,
              line.quantity === null ? null : toThousandths(line.quantity),
              line.unitPrice,
              isExcludedFromTotal(line) ? 1 : 0,
              line.unit,
              line.restricted ? 1 : 0,
            ),
        ),
      );
    }

    statements.push(
      this.db
        .prepare(
          `INSERT INTO audit_events (id, business_id, kind, subject_id, actor_id, at_ms, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          write.auditId,
          businessId,
          write.auditKind,
          order.orderId,
          write.actorId ?? write.customerId,
          write.nowMs,
          JSON.stringify({ from: write.base?.state ?? null, to: order.state, version: order.version, ...write.auditDetail }),
        ),
      // UNIQUE (business_id, operation_key): only settles a race; the engine read the key first.
      this.db
        .prepare(`INSERT INTO operations (business_id, operation_key, outcome_json, created_at_ms) VALUES (?, ?, ?, ?)`)
        .bind(businessId, write.operationKey, JSON.stringify(write.outcome), write.nowMs),
    );

    return { guards, statements };
  }

  private async load(tenant: Tenant, row: OrderRow): Promise<StoredOrder> {
    const { results } = await this.db
      .prepare(
        `SELECT l.line_no, l.product_id, p.canonical_name AS product_name, l.customer_text, l.qty_milli,
           l.unit_price_centavos, l.unit, l.restricted
         FROM order_lines l
         LEFT JOIN products p ON p.business_id = l.business_id AND p.id = l.product_id
         WHERE l.business_id = ? AND l.order_id = ? AND l.version = ?
         ORDER BY l.line_no`,
      )
      .bind(tenant.businessId, row.id, row.current_version)
      .all<LineRow>();

    let resumeState: StoredOrder["resumeState"] = null;
    if (row.state === "por_confirmar" && row.first_confirmed_at_ms !== null) {
      // The state the latest change after confirming interrupted: where confirming again returns.
      const event = await this.db
        .prepare(
          `SELECT json_extract(detail_json, '$.from') AS from_state FROM audit_events
           WHERE business_id = ? AND subject_id = ? AND kind = 'order_changed'
             AND json_extract(detail_json, '$.from') IN ('confirmado', 'preparando')
           ORDER BY at_ms DESC, json_extract(detail_json, '$.version') DESC LIMIT 1`,
        )
        .bind(tenant.businessId, row.id)
        .first<{ from_state: "confirmado" | "preparando" }>();
      resumeState = event?.from_state ?? "confirmado";
    }

    const changes = await this.changeFacts(tenant, row.id);
    const openRequest = changes.requests.findLast((request) => request.live) ?? null;
    const packing = row.state === "confirmado" || row.state === "preparando";
    const view: OrderView = {
      orderId: row.id,
      version: row.current_version,
      state: row.state,
      lines: results.map(lineView),
      fulfillment:
        row.fulfillment_mode === null
          ? null
          : row.fulfillment_mode === "pickup"
            ? { mode: "pickup" }
            : { mode: "delivery", placeId: row.place_id, placeText: row.place_text, fee: row.delivery_fee_centavos },
      total: row.total_centavos,
      queuePosition:
        packing && row.first_confirmed_at_ms !== null ? await this.queuePosition(tenant, row.id, row.first_confirmed_at_ms) : null,
      openChangeRequest: openRequest === null ? null : { id: openRequest.id, diff: openRequest.diff },
      lastReview: changes.lastReview,
    };
    return {
      view,
      customerId: row.customer_id,
      firstConfirmedAtMs: row.first_confirmed_at_ms,
      resumeState,
      versionFactId: row.version_fact_id,
      confirmFactId: row.confirm_fact_id,
      openRequest,
    };
  }
}

function lineView(row: LineRow): OrderLineView {
  return {
    lineId: labelOf(row.line_no - 1),
    text: row.customer_text,
    productId: row.product_id,
    productName: row.product_name,
    quantity: row.qty_milli === null ? null : fromThousandths(row.qty_milli),
    unit: row.unit,
    unitPrice: row.unit_price_centavos,
    availability: "no_se",
    restricted: row.restricted === 1,
    mark: null,
    substitute: null,
  };
}
