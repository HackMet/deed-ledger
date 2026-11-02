import { OrderMovedError } from "../../application/errors";
import { fromThousandths, type OrderHead, type OrderStore, type OrderWrite, type StoredOrder } from "../../application/engine/order-engine";
import type { Commit, Tenant } from "../../application/ports";
import type { EngineOutcome, OrderLineView, OrderState, OrderView } from "../../domain/contract/outcomes";
import { toThousandths } from "../../domain/contract/numbers";
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
}

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
    v.fulfillment_mode, v.place_id, v.place_text, v.delivery_fee_centavos, v.total_centavos
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

  async customerOrder(tenant: Tenant, customerId: string, orderId: string): Promise<StoredOrder | null> {
    const row = await this.db
      .prepare(`${ORDER_SELECT} WHERE o.business_id = ? AND o.customer_id = ? AND o.id = ?`)
      .bind(tenant.businessId, customerId, orderId)
      .first<OrderRow>();
    return row === null ? null : this.load(tenant, row);
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
            `INSERT INTO orders (id, business_id, customer_id, state, current_version, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(order.orderId, businessId, write.customerId, order.state, order.version, write.nowMs),
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
            `UPDATE orders SET state = ?, current_version = ?,
               first_confirmed_at_ms = CASE WHEN ? THEN COALESCE(first_confirmed_at_ms, ?) ELSE first_confirmed_at_ms END
             WHERE business_id = ? AND id = ? AND customer_id = ?`,
          )
          .bind(order.state, order.version, write.confirming ? 1 : 0, write.nowMs, businessId, order.orderId, write.customerId),
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
          write.customerId,
          write.nowMs,
          JSON.stringify({ from: write.base?.state ?? null, to: order.state, version: order.version }),
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
    };
    return { view, customerId: row.customer_id, firstConfirmedAtMs: row.first_confirmed_at_ms, resumeState };
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
