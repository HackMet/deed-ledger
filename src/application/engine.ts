/**
 * The engine's boundary: the only component that changes records. Perception, replies and the
 * console call it through this interface; tests and the other side build against fakes and the
 * fixtures in test/fixtures/contract.ts.
 */
import type { ActionEnvelope, ConsoleAction, CustomerAction } from "../domain/contract/actions";
import type { BurstReading } from "../domain/contract/observation";
import type { Claim, CustomerNotice, EngineOutcome, PreparationCard } from "../domain/contract/outcomes";
import type { Commit, Tenant } from "./ports";

/** A catalog match found by code, inside the store's scope. Never proposed by the model. */
export interface LineMatch {
  /** Index into the burst's observations. */
  readonly observation: number;
  /** Index into that observation's lines (or edits, for order_change). */
  readonly line: number;
  readonly productId: string;
  readonly how: "barcode" | "exact_name" | "known_alias" | "customer_history";
}

export interface CustomerContext extends Tenant {
  readonly customerId: string;
  readonly conversationId: string;
  /** The inbound job this comes from: the operation key's root, so a retried job saves once. */
  readonly jobId: string;
  /** Unix epoch milliseconds, from our clock. */
  readonly nowMs: number;
}

export interface MemberContext extends Tenant {
  readonly memberId: string;
  readonly role: "owner" | "staff";
  readonly canApproveFiado: boolean;
  readonly nowMs: number;
}

/**
 * Nothing is saved until the commits run: in the job's completion batch for a customer message,
 * or in one guarded batch of their own for a console action.
 */
export interface EngineResult {
  readonly outcome: EngineOutcome;
  readonly notices: readonly CustomerNotice[];
  readonly commits: readonly Commit[];
}

export interface Engine {
  /**
   * A customer's burst, observations in order. Console-only kinds (sale_report and the like) are
   * refused here whatever perception said. A customer has at most one open order (not entregado or
   * cancelado): a new customer_order while one is open adds to it. Order-line labels ("L2") are the engine's: line N of the
   * open order's current version is "LN".
   */
  onBurst(context: CustomerContext, reading: BurstReading, matches: readonly LineMatch[]): Promise<EngineResult>;
  onCustomerAction(context: CustomerContext, action: ActionEnvelope<CustomerAction>): Promise<EngineResult>;
  onConsoleAction(context: MemberContext, action: ActionEnvelope<ConsoleAction>): Promise<EngineResult>;
  /**
   * The claim check's second pass, right before a reply is sent: true per claim only when the
   * records back it now (a cancel may have landed since the reply was queued). The first pass runs
   * before the save, against the outcome itself, since the records it names aren't saved yet.
   */
  verifyClaims(tenant: Tenant, claims: readonly Claim[]): Promise<readonly boolean[]>;
  /** Orders confirmado, preparando or listo, oldest confirmation first. */
  preparationList(tenant: Tenant): Promise<readonly PreparationCard[]>;
}
