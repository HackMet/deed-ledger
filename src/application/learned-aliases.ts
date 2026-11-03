/**
 * Retrieval per store and learned aliases (D-49, planner contract §2.4). The spine calls
 * `retrieveForStore` before the planner and `proposeAliasesFromConfirmedOrder` once a customer
 * confirms an order; the owner approves proposals in Pendientes. No model call here.
 */
import { describeError } from "./errors";
import type { Logger, Tenant } from "./ports";
import type { LearnedAlias, RetrievableProduct, RetrievalLine } from "../domain/planner/types";
import { retrieveCandidates, type RetrievedCandidates, STANDS_ALONE } from "../domain/retrieval";

/** A store's catalog and the aliases it approved, scoped to the tenant. */
export interface RetrievalSource {
  listProducts(tenant: Tenant): Promise<readonly RetrievableProduct[]>;
  listApprovedAliases(tenant: Tenant): Promise<readonly LearnedAlias[]>;
}

export interface AliasProposal {
  /** The customer's words for the item: the same `said` retrieval looked up. */
  readonly said: string;
  readonly productId: string;
  /** The confirmed order it comes from. */
  readonly orderId: string;
}

export interface AliasBook extends RetrievalSource {
  /** Idempotent; true when a new proposal was raised. */
  proposeAlias(tenant: Tenant, proposal: AliasProposal, nowMs: number): Promise<boolean>;
}

/** A line of a confirmed order, as the spine knows it. */
export interface ConfirmedLine {
  /** The `said` retrieval looked up for this line (the item's name, without the quantity). */
  readonly said: string;
  readonly productId: string | null;
  /** How the line got its product. Only a planner pick teaches the store a new name. */
  readonly how: string | null;
}

/** Candidates for these lines from the store's whole catalog, with the names it approved. */
export async function retrieveForStore(
  source: RetrievalSource,
  tenant: Tenant,
  lines: readonly RetrievalLine[],
): Promise<RetrievedCandidates> {
  const [products, aliases] = await Promise.all([source.listProducts(tenant), source.listApprovedAliases(tenant)]);
  return retrieveCandidates(lines, products, aliases);
}

/**
 * After a confirmed order: each line the planner matched (`how: "planner_pick"`) proposes the
 * customer's words as an alias for that product, unless those words already find a product on
 * their own (a name, other name or approved alias). Safe to repeat. Never throws: a failure is
 * logged with IDs only, and the order stays confirmed. Returns how many proposals were raised.
 */
export async function proposeAliasesFromConfirmedOrder(
  book: AliasBook,
  log: Logger,
  tenant: Tenant,
  order: { readonly orderId: string; readonly lines: readonly ConfirmedLine[] },
  nowMs: number,
): Promise<number> {
  const picked = order.lines.filter((line): line is ConfirmedLine & { productId: string } => line.how === "planner_pick" && line.productId !== null);
  if (picked.length === 0) return 0;
  try {
    const [products, aliases] = await Promise.all([book.listProducts(tenant), book.listApprovedAliases(tenant)]);
    const lines = picked.map((line, n) => ({ label: `L${n + 1}`, said: line.said, unit: null }));
    const known = retrieveCandidates(lines, products, aliases).howByLine;
    let raised = 0;
    for (const [n, line] of picked.entries()) {
      const hows = [...(known.get(`L${n + 1}`)?.values() ?? [])];
      if (hows.some((how) => STANDS_ALONE.has(how))) continue;
      if (await book.proposeAlias(tenant, { said: line.said, productId: line.productId, orderId: order.orderId }, nowMs)) raised += 1;
    }
    if (raised > 0) log.info("alias_proposed", { businessId: tenant.businessId, count: raised });
    return raised;
  } catch (error) {
    log.error("alias_proposal_failed", { businessId: tenant.businessId, reason: describeError(error) });
    return 0;
  }
}
