/**
 * What code knows about one turn when it checks the planner's proposal: the lines it may name (N for
 * new items read in this burst, L for the open order's lines), the candidate table, and the words
 * of the burst a said quantity can come from. Pure data, built by the input builder.
 */
import type { DecimalString } from "../contract/numbers";
import type { BurstReading, ItemLine, ObservationIssue } from "../contract/observation";
import type { OrderView } from "../contract/outcomes";
import type { CandidateTable, RetrievableProduct } from "./types";

export interface FrameLine {
  /** N1… or L1… */
  readonly label: string;
  /** The customer's words for the product ("platanos", "aceite clover"). */
  readonly said: string;
  /** As the reader gave it (N), or as the order holds it (L). */
  readonly quantity: DecimalString | null;
  readonly unit: string | null;
  readonly restricted: boolean;
  /** Code's exact match (N), or the order line's product (L); null when none. */
  readonly productId: string | null;
  readonly productName: string | null;
  /** The reader couldn't settle it: an unclear size or product, or illegible. */
  readonly unclear: boolean;
}

export interface PlannerFrame {
  readonly newItems: readonly FrameLine[];
  readonly orderLines: readonly FrameLine[];
  readonly table: CandidateTable;
  /** The burst's words a said quantity can come from: texts, voice transcripts, clarification answers. */
  readonly saidTexts: readonly string[];
  /** Quantities the reader itself set on order lines in this burst, by L label. */
  readonly readerQuantities: ReadonlyMap<string, DecimalString>;
  /** Order lines the reader itself removed in this burst, by L label. */
  readonly readerRemoved: ReadonlySet<string>;
  /**
   * Removals the reader heard but couldn't place on a line (its ref was null): the words that name
   * what to remove. The planner may resolve these, only among the lines they name.
   */
  readonly unplacedRemovals: readonly string[];
  /** The L label whose quantity, alone, was the question last asked; null otherwise. */
  readonly askedQuantityOf: string | null;
  /** The open order as the plan is checked against it (`orderBasis`); null when there is none. */
  readonly basis: string | null;
  /** What the burst holds besides text: "Ya vi tu lista 👍" needs a photo, the voice phrase a voice note. */
  readonly media: { readonly image: boolean; readonly voice: boolean };
  /** The reading flagged something it couldn't read. */
  readonly illegible: boolean;
  /** The store's products by ID: how each is sold, its usual amount, whether it's restricted. */
  readonly products: ReadonlyMap<string, RetrievableProduct>;
}

/** A new item of the burst: where it is in the reading, and its N label. */
export interface NewItem {
  readonly label: string;
  /** Index into the reading's observations. */
  readonly observation: number;
  /** Index into that observation's lines (or edits, for order_change), as LineMatch counts. */
  readonly line: number;
  readonly item: ItemLine;
  readonly issues: readonly ObservationIssue["code"][];
}

const UNCLEAR: readonly ObservationIssue["code"][] = ["ambiguous_size", "ambiguous_product", "illegible"];

/**
 * Every item the burst adds, in reading order: customer_order lines and order_change `add` edits.
 * The engine adds lines in this same order, so N labels map to the lines it creates.
 */
export function newItemsOf(reading: BurstReading): NewItem[] {
  const items: NewItem[] = [];
  reading.observations.forEach((observation, index) => {
    const issuesOf = (n: number) => observation.issues.filter((issue) => issue.line === n && UNCLEAR.includes(issue.code)).map((issue) => issue.code);
    if (observation.kind === "customer_order") {
      observation.lines.forEach((item, n) => items.push({ label: `N${items.length + 1}`, observation: index, line: n, item, issues: issuesOf(n) }));
    } else if (observation.kind === "order_change") {
      observation.edits.forEach((edit, n) => {
        if (edit.op === "add") items.push({ label: `N${items.length + 1}`, observation: index, line: n, item: edit.line, issues: issuesOf(n) });
      });
    }
  });
  return items;
}

/**
 * The open order as a plan was checked against it: its ID, version, state and every line's product
 * and quantity. The engine applies a plan only while the order still reads the same (finding 6 of
 * the Nov 2 review): labels like "L2" and every check made against the order hold only for it.
 */
export function orderBasis(order: OrderView | null): string | null {
  if (order === null) return null;
  const lines = order.lines.map((line) => `${line.lineId}=${line.productId ?? ""}/${line.quantity ?? ""}/${line.quantitySource ?? ""}`);
  return `${order.orderId}:v${order.version}:${order.state}:${lines.join(",")}`;
}
