/**
 * The owner's one inbox, beyond the Pendientes board: customers' change requests waiting for
 * Aprobar / Rechazar, and supplier invoices waiting to be approved. Read only, through the reads the
 * Pedidos history and Facturas screens already use; the yes or no still happens on their own pages.
 * When a read fails the answer is null (unknown), never an empty list.
 */
import type { Context } from "hono";
import { html } from "hono/html";
import type { ConsoleReceiptDraft } from "../../../application/receipts";
import { describeError } from "../../../application/errors";
import { D1OrderTrail } from "../../../infrastructure/d1/order-trail";
import type { MemberContext } from "../../../application/engine";
import type { ConsoleEnv } from "./auth";

export interface InboxItem {
  readonly kind: "change" | "invoice";
  readonly href: string;
  readonly title: string;
  readonly note: string;
}

/** An invoice still waiting for the owner, as Facturas calls it "Por revisar". */
export function awaitsReview(draft: ConsoleReceiptDraft, nowMs: number): boolean {
  return draft.receipt === null && draft.declined === null && draft.state === "pending" && draft.expiresAtMs > nowMs;
}

/** Change requests and invoices waiting for the owner, oldest orders' first as their lists show them. */
export async function approvals(c: Context<ConsoleEnv>): Promise<readonly InboxItem[] | null> {
  const member = c.get("member");
  const { deps, receipts } = c.get("runtime");
  try {
    // As `memberContext` in auth.ts builds it; imported from there, the layout would import itself.
    const context: MemberContext = {
      businessId: member.businessId,
      memberId: member.userId,
      role: member.role,
      canApproveFiado: member.canApproveFiado,
      nowMs: deps.clock.now(),
    };
    const reads = new D1OrderTrail(c.env.DB);
    const tenant = { businessId: member.businessId };
    const [orders, drafts] = await Promise.all([reads.listOrders(tenant), receipts.list(context)]);
    // A waiting request always colours its order yellow; only those are opened to check.
    const changes: InboxItem[] = [];
    for (const row of orders.filter((order) => order.colour === "yellow")) {
      const trail = await reads.trail(tenant, row.orderId);
      if (trail === null || trail.openRequest === null) continue;
      changes.push({
        kind: "change",
        href: `/console/pedidos/${encodeURIComponent(row.orderId)}`,
        // The code already reads "#TP2BV".
        title: row.code === null ? "Un cliente pidió un cambio" : `El pedido ${row.code} tiene un cambio`,
        note: "Respondelo en el pedido.",
      });
    }
    const invoices: InboxItem[] = drafts
      .filter((draft) => awaitsReview(draft, context.nowMs))
      .map((draft) => ({
        kind: "invoice",
        href: `/console/facturas/${encodeURIComponent(draft.id)}`,
        title: `Factura de ${draft.body.supplier ?? "proveedor sin nombre"}`,
        note: `${draft.body.lines.length === 1 ? "1 línea" : `${draft.body.lines.length} líneas`} · Por revisar`,
      }));
    return [...changes, ...invoices];
  } catch (error) {
    deps.log.warn("inbox_read_failed", { businessId: member.businessId, reason: describeError(error) });
    return null;
  }
}

/** The inbox items as cards, each a link to the page where the owner answers. */
export function inboxCards(items: readonly InboxItem[]) {
  return html`${items.map(
    (item) => html`<a class="card inbox ${item.kind}" href="${item.href}"><strong>${item.title}</strong><span class="muted">${item.note}</span><span class="go" aria-hidden="true">›</span></a>`,
  )}`;
}
