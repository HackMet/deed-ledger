/**
 * The planner's contract, shared by every part of the agentic conversation (D-45 to D-49): the
 * planner call and its validation, retrieval of candidate products, the engine's turn plan, and
 * the eval suite. The planner works with labels only. It never sees or returns product IDs,
 * prices, totals or stock counts; code maps labels back and refuses anything it can't back.
 */
import type { DecimalString } from "../contract/numbers";

/** The one kind of question a message may ask (D-47: one kind per message, several lines). */
export type AskKind =
  | "none"
  | "quantities"
  | "options"
  | "unreadable"
  | "fulfillment"
  | "delivery_place"
  | "what_to_order";

export type PlannerMove = "ask" | "readback" | "answer_only" | "handoff" | "restate";

export type PlannerOpKind = "add" | "pick" | "set_quantity" | "remove";

/** One change the planner proposes. `line` is an N label (new this burst) or an L label (order). */
export interface PlannerOp {
  readonly op: PlannerOpKind;
  readonly line: string;
  /** A P label offered for this line, or null to leave it unmatched. */
  readonly product: string | null;
  /** Exactly what the customer said, or null. Code refuses a quantity the burst doesn't back. */
  readonly quantity: DecimalString | null;
  /** Only "1", only when nothing was said (D-46). */
  readonly suggested_quantity: DecimalString | null;
}

/** The planner's strict JSON output, as parsed. Untrusted until validated. */
export interface TurnProposal {
  readonly ops: readonly PlannerOp[];
  readonly move: PlannerMove;
  readonly ask: { readonly kind: AskKind; readonly lines: readonly string[] };
  /** One short connecting sentence with no facts in it; may be empty. */
  readonly say: string;
}

/** How a product is sold, from the store layer. Null means the store hasn't said. */
export type SoldBy = "unit" | "weight";

export type QuantitySource = "said" | "suggested" | "store_usual";

/** A product as retrieval needs it, already scoped to one store. */
export interface RetrievableProduct {
  readonly productId: string;
  /** The first is the display name. */
  readonly names: readonly string[];
  readonly aliases: readonly string[];
  readonly barcode: string | null;
  readonly soldBy: SoldBy | null;
  readonly usualQuantity: DecimalString | null;
  readonly hasPrice: boolean;
  readonly availability: "hay" | "se_acabo" | "no_se";
  readonly restricted: boolean;
}

/** A word the store taught the agent (D-49). Only approved ones match. */
export interface LearnedAlias {
  readonly words: string;
  readonly productId: string;
}

/** An item line retrieval looks up: the customer's words for it. */
export interface RetrievalLine {
  /** N or L label. */
  readonly label: string;
  readonly said: string;
  readonly unit: string | null;
  /**
   * Added by L0 (Nov 2): other common names the reader proposed for the item ("catsup" →
   * "ketchup", "salsa de tomate"). They only widen the search, ranked below the customer's own
   * words (`other_name`): never a match by themselves, never shown to the customer.
   */
  readonly otherNames?: readonly string[];
}

export type CandidateHow =
  | "barcode"
  | "exact_name"
  | "known_alias"
  | "learned_alias"
  | "all_words"
  | "any_word"
  /** Found only through a name the reader proposed for the item, never the customer's own words. */
  | "other_name"
  | "near_spelling";

/** One product offered to the planner this turn. `productId` never goes into the prompt. */
export interface Candidate {
  /** P1, P2… */
  readonly label: string;
  readonly productId: string;
  readonly name: string;
  readonly soldBy: SoldBy | null;
  readonly usualQuantity: DecimalString | null;
  readonly hasPrice: boolean;
  readonly availability: "hay" | "se_acabo" | "no_se";
  readonly restricted: boolean;
  readonly how: CandidateHow;
}

export const MAX_CANDIDATES_PER_LINE = 5;

/** Which candidates were offered for which line. A pick outside this table is refused. */
export interface CandidateTable {
  readonly candidates: readonly Candidate[];
  /** Line label → candidate labels offered for it, best first, at most MAX_CANDIDATES_PER_LINE. */
  readonly offered: ReadonlyMap<string, readonly string[]>;
  /**
   * Line label → candidate label → how it was found for that line (moved here from L1's
   * `RetrievedCandidates`, Nov 2). `Candidate.how` is the strongest across every line the product is
   * offered for; this is the per-line truth, and what the planner sees as evidence.
   */
  readonly howByLine: ReadonlyMap<string, ReadonlyMap<string, CandidateHow>>;
}

/** What the engine receives once a proposal is validated (proposed in docs/contract.md, Nov 2). */
export interface TurnPlan {
  readonly move: PlannerMove;
  readonly ask: { readonly kind: Exclude<AskKind, "none">; readonly lineRefs: readonly string[] } | null;
  readonly assumed: readonly {
    readonly lineRef: string;
    readonly quantity: DecimalString;
    readonly source: Exclude<QuantitySource, "said">;
  }[];
  /** Already checked: no digits, amounts, state words, promises or questions. */
  readonly say: string;
  /**
   * Added by L0 (Nov 2): validated changes to lines that no observation or match carries: a product
   * picked for an order line (L), a quantity the burst said for any line, a removal. Product IDs
   * come from code's candidate table, never from the model. Absent: none.
   */
  readonly changes?: readonly LineChange[];
  /**
   * Added by L0 (Nov 2): for an `options` question, the products offered per line, best first, as
   * retrieval found them, so the engine never searches the catalog itself. Absent: none.
   */
  readonly options?: readonly { readonly lineRef: string; readonly productIds: readonly string[] }[];
}

/** One validated change to a line, by its label in this turn. */
export interface LineChange {
  readonly lineRef: string;
  readonly productId?: string;
  readonly quantity?: DecimalString;
  readonly remove?: true;
}
