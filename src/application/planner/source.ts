/**
 * What the engine tells the planner (proposed in docs/contract.md, Nov 2), through one read the
 * contract doesn't have yet, like perception's gaps a and b. Local until agreed; an engine that has
 * it gets the planner in composition (`CONVERSATION=planner`).
 */
import type { OrderView } from "../../domain/contract/outcomes";
import type { AskKind } from "../../domain/planner/types";
import type { CustomerContext, Engine } from "../engine";

/** The question last shown on the planner path, by line ID, and how many times in a row. */
export interface LastAsk {
  readonly kind: Exclude<AskKind, "none">;
  readonly lineIds: readonly string[];
  /** For `options`: the products shown per line, in the order they were numbered. */
  readonly options?: Readonly<Record<string, readonly string[]>>;
  readonly times: number;
}

export interface PlannerContext {
  /** The customer's open order, as the engine holds it, or null. */
  readonly order: OrderView | null;
  /** Line ID → the customer's words for the product ("platanos"), as perception read them. */
  readonly said: Readonly<Record<string, string>>;
  /** Line ID → other names the reader proposed for the item, for retrieval only. */
  readonly otherNames: Readonly<Record<string, readonly string[]>>;
  /** Lines whose product the planner picked: once the order is confirmed, their words may teach the store. */
  readonly picked: readonly string[];
  readonly lastAsk: LastAsk | null;
  /** The store layer the planner sees: only whether things are set, never amounts. */
  readonly store: { readonly hoursSet: boolean; readonly delivery: "yes" | "no" | "unknown" };
}

export interface PlannerSource {
  plannerContext(context: CustomerContext): Promise<PlannerContext>;
}

/** The engine's planner read, when it has one. */
export function plannerSourceOf(engine: Engine): PlannerSource | null {
  return typeof (engine as Partial<PlannerSource>).plannerContext === "function" ? (engine as Engine & PlannerSource) : null;
}
