import type { AliasBook, AliasProposal } from "../../application/learned-aliases";
import type { Tenant } from "../../application/ports";
import type { LearnedAlias, RetrievableProduct } from "../../domain/planner/types";
import { aliasWords, MAX_ALIAS_CHARS } from "../../domain/retrieval";
import type { StoreProduct } from "../../domain/store-setup";
import { D1StoreSetupRepository } from "./store-setup-repository";

/** The most proposals the owner's Pendientes lists at once. */
const MAX_PROPOSED = 100;

/** A proposal waiting for the owner, as the Pendientes card shows it. */
export interface ProposedAlias {
  readonly id: string;
  /** The customer's words. */
  readonly said: string;
  readonly productName: string;
  readonly proposedAtMs: number;
}

/**
 * What retrieval reads per store (migrations 0011 and 0019): its products and the names it
 * approved, and the learned aliases themselves (D-49). Every method takes the tenant and is scoped
 * to its store: another store's product, alias or ID finds nothing and changes nothing.
 */
export class D1RetrievalRepository implements AliasBook {
  private readonly setup: D1StoreSetupRepository;

  constructor(
    private readonly db: D1Database,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    this.setup = new D1StoreSetupRepository(db);
  }

  async listProducts(tenant: Tenant): Promise<RetrievableProduct[]> {
    return (await this.setup.listProducts(tenant)).map(retrievableProduct);
  }

  /** Only approved aliases match; proposed and rejected ones never reach retrieval. */
  async listApprovedAliases(tenant: Tenant): Promise<LearnedAlias[]> {
    const { results } = await this.db
      .prepare(`SELECT words, product_id FROM store_aliases WHERE business_id = ? AND state = 'approved' ORDER BY words`)
      .bind(tenant.businessId)
      .all<{ words: string; product_id: string }>();
    return results.map((row) => ({ words: row.words, productId: row.product_id }));
  }

  /**
   * Raises a proposal from a confirmed order. Idempotent: words the store already has an alias for
   * add nothing, except words it rejected for a different product, which are proposed again for
   * this one. A product that isn't this store's adds nothing. True when a proposal was raised.
   */
  async proposeAlias(tenant: Tenant, proposal: AliasProposal, nowMs: number): Promise<boolean> {
    const words = aliasWords(proposal.said);
    const said = proposal.said.replace(/\s+/g, " ").trim().slice(0, MAX_ALIAS_CHARS);
    if (words === null || said === "") return false;
    const result = await this.db
      .prepare(
        `INSERT INTO store_aliases (id, business_id, words, said, product_id, state, source, source_order_id, proposed_at_ms)
         SELECT ?, business_id, ?, ?, id, 'proposed', 'order', ?, ? FROM store_products WHERE business_id = ? AND id = ?
         ON CONFLICT (business_id, words) DO UPDATE
           SET product_id = excluded.product_id, said = excluded.said, state = 'proposed', source = 'order',
               source_order_id = excluded.source_order_id, proposed_at_ms = excluded.proposed_at_ms,
               decided_at_ms = NULL, decided_by_user_id = NULL
           WHERE store_aliases.state = 'rejected' AND store_aliases.product_id <> excluded.product_id`,
      )
      .bind(this.newId(), words, said, proposal.orderId, nowMs, tenant.businessId, proposal.productId)
      .run();
    return result.meta.changes === 1;
  }

  /** Proposals waiting for the owner, newest first, with the product's current name. */
  async listProposed(tenant: Tenant): Promise<ProposedAlias[]> {
    const { results } = await this.db
      .prepare(
        `SELECT a.id, a.said, a.proposed_at_ms, p.name FROM store_aliases a
         JOIN store_products p ON p.business_id = a.business_id AND p.id = a.product_id
         WHERE a.business_id = ? AND a.state = 'proposed'
         ORDER BY a.proposed_at_ms DESC, a.id LIMIT ${MAX_PROPOSED}`,
      )
      .bind(tenant.businessId)
      .all<{ id: string; said: string; proposed_at_ms: number; name: string }>();
    return results.map((row) => ({ id: row.id, said: row.said, productName: row.name, proposedAtMs: row.proposed_at_ms }));
  }

  async countProposed(tenant: Tenant): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS proposed FROM store_aliases WHERE business_id = ? AND state = 'proposed'`)
      .bind(tenant.businessId)
      .first<{ proposed: number }>();
    return row?.proposed ?? 0;
  }

  /** "Sí": the words match that product from now on. False when it isn't this store's or was already decided. */
  async approveAlias(tenant: Tenant, aliasId: string, userId: string, nowMs: number): Promise<boolean> {
    return this.decide(tenant, aliasId, "approved", userId, nowMs);
  }

  /** "No": never used, and not proposed again for the same product. */
  async rejectAlias(tenant: Tenant, aliasId: string, userId: string, nowMs: number): Promise<boolean> {
    return this.decide(tenant, aliasId, "rejected", userId, nowMs);
  }

  private async decide(tenant: Tenant, aliasId: string, state: "approved" | "rejected", userId: string, nowMs: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE store_aliases SET state = ?, decided_at_ms = ?, decided_by_user_id = ?
         WHERE business_id = ? AND id = ? AND state = 'proposed'`,
      )
      .bind(state, nowMs, userId, tenant.businessId, aliasId)
      .run();
    return result.meta.changes === 1;
  }
}

/**
 * A store product as retrieval sees it. A price is the owner's own, so it's confirmed. "No hay" is
 * "se_acabo"; unmarked is unknown, never "hay" (as the pretend engine reads it). The Tienda screen
 * has no restricted mark yet, so none is restricted here; the reader still flags alcohol and
 * tobacco lines itself.
 */
export function retrievableProduct(product: StoreProduct): RetrievableProduct {
  return {
    productId: product.productId,
    names: [product.name],
    aliases: product.otherNames,
    barcode: null,
    soldBy: product.soldBy,
    usualQuantity: product.usualQuantity,
    hasPrice: product.price !== null,
    availability: product.noHay ? "se_acabo" : "no_se",
    restricted: false,
  };
}
