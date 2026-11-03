/**
 * Retrieval per store and learned aliases (D-49, planner contract §2.4). The spine calls
 * `retrieveForStore` before the planner and, once a customer confirms an order,
 * `aliasProposalCommits` for the confirmation's own batch; the owner approves proposals in
 * Pendientes. No model call here.
 */
import { describeError } from "./errors";
import type { Commit, Logger, Tenant } from "./ports";
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
  /** Whose order: nothing is proposed for a customer who asked to delete their data. */
  readonly customerId: string;
}

export interface AliasBook extends RetrievalSource {
  /** Idempotent; true when a new proposal was raised. */
  proposeAlias(tenant: Tenant, proposal: AliasProposal, nowMs: number): Promise<boolean>;
  /** The same, as a commit for the confirmation's completion batch (null: nothing to learn). */
  proposalCommit(tenant: Tenant, proposal: AliasProposal, nowMs: number): Commit | null;
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

/** A confirmed order, as the spine knows it. */
export interface ConfirmedOrder {
  readonly orderId: string;
  readonly customerId: string;
  readonly lines: readonly ConfirmedLine[];
}

/**
 * What a confirmed order may teach the store: each line the planner matched (`how:
 * "planner_pick"`) proposes the customer's words for that product, unless those words already find a
 * product on their own (a name, other name or approved alias).
 */
async function proposalsOf(book: AliasBook, tenant: Tenant, order: ConfirmedOrder): Promise<AliasProposal[]> {
  const picked = order.lines.filter((line): line is ConfirmedLine & { productId: string } => line.how === "planner_pick" && line.productId !== null);
  if (picked.length === 0) return [];
  const [products, aliases] = await Promise.all([book.listProducts(tenant), book.listApprovedAliases(tenant)]);
  const lines = picked.map((line, n) => ({ label: `L${n + 1}`, said: line.said, unit: null }));
  const known = retrieveCandidates(lines, products, aliases).howByLine;
  return picked
    .filter((_, n) => ![...(known.get(`L${n + 1}`)?.values() ?? [])].some((how) => STANDS_ALONE.has(how)))
    .map((line) => ({ said: line.said, productId: line.productId, orderId: order.orderId, customerId: order.customerId }));
}

/**
 * The proposals as commits for the confirmation's own completion batch (review finding 5, Nov 2):
 * they land only if the confirmation saves, and each refuses itself if the customer asked to delete
 * their data by then. Never throws: a failure is logged with IDs only, and the order confirms anyway.
 */
export async function aliasProposalCommits(book: AliasBook, log: Logger, tenant: Tenant, order: ConfirmedOrder, nowMs: number): Promise<Commit[]> {
  try {
    return (await proposalsOf(book, tenant, order)).flatMap((proposal) => book.proposalCommit(tenant, proposal, nowMs) ?? []);
  } catch (error) {
    log.error("alias_proposal_failed", { businessId: tenant.businessId, reason: describeError(error) });
    return [];
  }
}

/**
 * The same proposals, written now (outside any job). Safe to repeat. Never throws: a failure is
 * logged with IDs only. Returns how many proposals were raised.
 */
export async function proposeAliasesFromConfirmedOrder(book: AliasBook, log: Logger, tenant: Tenant, order: ConfirmedOrder, nowMs: number): Promise<number> {
  try {
    let raised = 0;
    for (const proposal of await proposalsOf(book, tenant, order)) {
      if (await book.proposeAlias(tenant, proposal, nowMs)) raised += 1;
    }
    if (raised > 0) log.info("alias_proposed", { businessId: tenant.businessId, count: raised });
    return raised;
  } catch (error) {
    log.error("alias_proposal_failed", { businessId: tenant.businessId, reason: describeError(error) });
    return 0;
  }
}
