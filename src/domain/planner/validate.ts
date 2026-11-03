/**
 * Code's check of the planner's proposal (contract §2.3). The planner proposes; this decides what
 * survives. Every op names a label of this turn, every product is one code offered for that line,
 * every quantity was said for that line, a removal is one the reader heard, a suggestion is only "1"
 * and only where D-46 allows it, and the connecting phrase is one of SAY_PHRASES (the schema's enum).
 * Pure. Refusals are returned as codes, for logs.
 *
 * `settleStep` is the engine's last word, after the plan is applied: a readback the order isn't
 * ready for becomes the first missing question, and a question about lines that don't need it is
 * narrowed or replaced (readiness.ts).
 */
import { productWords } from "../catalog-search";
import { isDecimalString, toThousandths, type DecimalString } from "../contract/numbers";
import type { OrderView } from "../contract/outcomes";
import { quantityFrom } from "../answer-words";
import type { Missing } from "../readiness";
import { schemaMismatch } from "../perception/schema-check";
import { STANDS_ALONE } from "../retrieval";
import type { FrameLine, PlannerFrame } from "./frame";
import type { AskKind, LineChange, TurnPlan, TurnProposal } from "./types";
import { MAX_ASK_LINES, MAX_OPS, SAY_NEEDS, type SayPhrase, turnSchema } from "./wire";

export type RefusalCode =
  | "unknown_line"
  | "not_offered"
  | "add_twice"
  | "add_order_line"
  | "pick_without_product"
  | "pick_conflicts_match"
  | "quantity_not_said"
  | "remove_new_item"
  | "remove_not_said"
  | "suggestion_not_one"
  | "suggestion_quantity_said"
  | "suggestion_weight_unit"
  | "suggestion_sold_by_weight"
  | "suggestion_unresolved"
  | "suggestion_restricted"
  | "ask_lines_filtered"
  | "ask_without_lines"
  | "say_without_media"
  | "line_left_out";

export interface Refusal {
  readonly code: RefusalCode;
  /** The label it was about, when one. */
  readonly line: string | null;
}

export interface ValidatedTurn {
  readonly plan: TurnPlan;
  /** Products the planner picked for new items (N), mapped by code; the engine gets them as matches. */
  readonly picks: readonly { readonly label: string; readonly productId: string }[];
  readonly refused: readonly Refusal[];
}

export type ProposalCheck = { readonly ok: true; readonly turn: ValidatedTurn } | { readonly ok: false; readonly reason: "schema" };

const NEEDS_LINES: readonly AskKind[] = ["quantities", "options"];
const LINELESS: readonly AskKind[] = ["fulfillment", "delivery_place", "what_to_order"];

export function validateProposal(raw: unknown, frame: PlannerFrame): ProposalCheck {
  if (schemaMismatch(turnSchema, raw) !== null) return { ok: false, reason: "schema" };
  const proposal = raw as TurnProposal;
  if (proposal.ops.length > MAX_OPS || proposal.ask.lines.length > MAX_ASK_LINES) return { ok: false, reason: "schema" };

  const lines = new Map<string, FrameLine>([...frame.newItems, ...frame.orderLines].map((line) => [line.label, line]));
  const refused: Refusal[] = [];
  const refuse = (code: RefusalCode, line: string | null) => refused.push({ code, line });
  const product = new Map<string, string>();
  const quantity = new Map<string, DecimalString>();
  const suggestion = new Map<string, string>();
  const removed = new Set<string>();
  const added = new Set<string>();

  for (const op of proposal.ops) {
    const line = lines.get(op.line);
    if (line === undefined) {
      refuse("unknown_line", null);
      continue;
    }
    const isNew = line.label.startsWith("N");
    if (op.op === "remove") {
      // Only a removal the reader heard: its own line, or one it couldn't place that names this line.
      if (isNew) refuse("remove_new_item", line.label);
      else if (!frame.readerRemoved.has(line.label) && !frame.unplacedRemovals.some((said) => names(said, line))) refuse("remove_not_said", line.label);
      else removed.add(line.label);
      continue;
    }
    if (op.op === "add" && !isNew) {
      refuse("add_order_line", line.label);
      continue;
    }
    if (op.op === "add" && added.has(line.label)) {
      refuse("add_twice", line.label);
      continue;
    }
    if (op.op === "pick" && op.product === null) {
      refuse("pick_without_product", line.label);
      continue;
    }
    // Every part of the op must hold, or none of it is used.
    let picked: string | null = null;
    if (op.op !== "set_quantity" && op.product !== null) {
      picked = offeredProduct(frame, line.label, op.product);
      if (picked === null) {
        refuse("not_offered", line.label);
        continue;
      }
      if (line.productId !== null && line.productId !== picked) {
        refuse("pick_conflicts_match", line.label);
        continue;
      }
    }
    if (op.quantity !== null && !saidQuantity(op.quantity, line, frame)) {
      refuse("quantity_not_said", line.label);
      continue;
    }
    if (op.op === "add") added.add(line.label);
    if (picked !== null && line.productId === null) product.set(line.label, picked);
    if (op.quantity !== null && !sameQuantity(op.quantity, line.quantity)) quantity.set(line.label, op.quantity);
    if (op.suggested_quantity !== null) suggestion.set(line.label, op.suggested_quantity);
  }

  for (const item of frame.newItems) {
    if (!added.has(item.label) && !product.has(item.label) && !quantity.has(item.label)) refuse("line_left_out", item.label);
  }

  const productOf = (line: FrameLine) => product.get(line.label) ?? line.productId;
  const hasQuantity = (line: FrameLine) => line.quantity !== null || quantity.has(line.label);
  const assumed = new Map<string, { quantity: DecimalString; source: "suggested" | "store_usual" }>();
  for (const [label, value] of suggestion) {
    const line = lines.get(label)!;
    const code = suggestionRefusal(value, line, productOf(line), hasQuantity(line), frame);
    if (code !== null) refuse(code, label);
    else if (!removed.has(label)) assumed.set(label, { quantity: "1", source: "suggested" });
  }
  // The store's own usual amount wins over the planner's suggestion (D-46), shown the same way.
  for (const line of lines.values()) {
    const id = productOf(line);
    const usual = id === null ? null : (frame.products.get(id)?.usualQuantity ?? null);
    if (usual === null || hasQuantity(line) || removed.has(line.label) || line.restricted || frame.products.get(id!)?.restricted) continue;
    if (!isDecimalString(usual) || toThousandths(usual) === 0) continue;
    assumed.set(line.label, { quantity: usual, source: "store_usual" });
  }

  const fits = (kind: AskKind, label: string): boolean => {
    const line = lines.get(label);
    if (line === undefined || removed.has(label)) return false;
    if (kind === "quantities") return !hasQuantity(line) && !assumed.has(label) && !line.restricted;
    if (kind === "options") return productOf(line) === null && availableOffered(frame, label).length >= 2;
    if (kind === "unreadable") return productOf(line) === null;
    return false;
  };
  let ask: TurnPlan["ask"] = null;
  if (proposal.move === "ask" && proposal.ask.kind !== "none") {
    const kind = proposal.ask.kind;
    const lineRefs = LINELESS.includes(kind) ? [] : [...new Set(proposal.ask.lines)].filter((label) => fits(kind, label));
    if (!LINELESS.includes(kind) && lineRefs.length < proposal.ask.lines.length) refuse("ask_lines_filtered", null);
    if (NEEDS_LINES.includes(kind) && lineRefs.length === 0) refuse("ask_without_lines", null);
    else ask = { kind, lineRefs };
  }

  const changes = new Map<string, LineChange>();
  const change = (label: string, part: Omit<LineChange, "lineRef">) => changes.set(label, { ...(changes.get(label) ?? { lineRef: label }), ...part });
  for (const [label, id] of product) if (label.startsWith("L")) change(label, { productId: id });
  for (const [label, value] of quantity) if (!removed.has(label)) change(label, { quantity: value });
  for (const label of removed) change(label, { remove: true });

  const options =
    ask?.kind === "options"
      ? ask.lineRefs.map((label) => ({ lineRef: label, productIds: availableOffered(frame, label) }))
      : [];

  const plan: TurnPlan = {
    move: proposal.move,
    ask,
    assumed: [...assumed].map(([lineRef, a]) => ({ lineRef, ...a })),
    say: sayFor(proposal.say, frame, refuse),
    basis: frame.basis,
    ...(changes.size === 0 ? {} : { changes: [...changes.values()] }),
    ...(options.length === 0 ? {} : { options }),
  };
  const picks = [...product].filter(([label]) => label.startsWith("N")).map(([label, productId]) => ({ label, productId }));
  return { ok: true, turn: { plan, picks, refused } };
}

/** The chosen phrase, unless it says a photo or voice note was received and the burst has none. */
function sayFor(say: string, frame: PlannerFrame, refuse: (code: RefusalCode, line: string | null) => void): string {
  const needs = SAY_NEEDS[say as SayPhrase];
  if (needs === undefined || frame.media[needs]) return say;
  refuse("say_without_media", null);
  return "";
}

// ---------------------------------------------------------------------------------------------
// The step the engine takes, once the plan is applied

export type Step = { readonly type: "readback" } | { readonly type: "ask"; readonly kind: Exclude<AskKind, "none">; readonly lineIds: readonly string[] };

export interface StepInput {
  readonly order: OrderView;
  /** `missingFor(order)`, after the plan was applied. */
  readonly missing: readonly Missing[];
  /** The plan's question (lines as IDs), "readback", or null for "where the order stands". */
  readonly proposed: { readonly kind: Exclude<AskKind, "none">; readonly lineIds: readonly string[] } | "readback" | null;
  /** Lines that have products to choose from. */
  readonly withOptions: ReadonlySet<string>;
  /** The reading flagged something illegible: an unreadable question may name no line. */
  readonly illegible: boolean;
}

/**
 * The question the order really needs, or the readback. A readback while something blocks it, or a
 * question whose lines don't need it, becomes the first missing question (or the readback).
 */
export function settleStep({ order, missing, proposed, withOptions, illegible }: StepInput): Step {
  const first = (): Step => {
    const need = missing[0];
    if (need === undefined) return { type: "readback" };
    return { type: "ask", kind: need.kind, lineIds: need.kind === "quantities" ? need.lineIds : [] };
  };
  if (proposed === null || proposed === "readback") return first();
  const line = (id: string) => order.lines.find((l) => l.lineId === id);
  const needs = (kind: Missing["kind"]) => missing.find((m) => m.kind === kind);
  const ask = (lineIds: readonly string[]): Step => ({ type: "ask", kind: proposed.kind, lineIds });
  switch (proposed.kind) {
    case "quantities": {
      const waiting = new Set((needs("quantities") as Extract<Missing, { kind: "quantities" }> | undefined)?.lineIds ?? []);
      const kept = proposed.lineIds.filter((id) => waiting.has(id));
      return kept.length > 0 ? ask(kept) : first();
    }
    case "options": {
      const kept = proposed.lineIds.filter((id) => line(id)?.productId === null && withOptions.has(id));
      return kept.length > 0 ? ask(kept) : first();
    }
    case "unreadable": {
      const kept = proposed.lineIds.filter((id) => line(id)?.productId === null);
      return kept.length > 0 || illegible ? ask(kept) : first();
    }
    case "fulfillment":
    case "delivery_place":
    case "what_to_order":
      return needs(proposed.kind) !== undefined ? ask([]) : first();
  }
}

// ---------------------------------------------------------------------------------------------
// Rules

function offeredProduct(frame: PlannerFrame, line: string, label: string): string | null {
  return frame.table.offered.get(line)?.includes(label) === true ? candidateProduct(frame, label) : null;
}

function candidateProduct(frame: PlannerFrame, label: string): string | null {
  return frame.table.candidates.find((candidate) => candidate.label === label)?.productId ?? null;
}

function offeredCount(frame: PlannerFrame, line: string): number {
  return frame.table.offered.get(line)?.length ?? 0;
}

/** The products offered for a line that the store hasn't marked "No hay": what an options question may list. */
function availableOffered(frame: PlannerFrame, line: string): string[] {
  return (frame.table.offered.get(line) ?? []).flatMap((label) => {
    const id = candidateProduct(frame, label);
    return id === null || frame.products.get(id)?.availability === "se_acabo" ? [] : [id];
  });
}

function sameQuantity(a: DecimalString, b: DecimalString | null): boolean {
  return b !== null && toThousandths(a) === toThousandths(b);
}

/**
 * A quantity the burst backs for this line (review finding 1, Nov 2), only:
 * (a) the reader's own quantity for that line (a new item's, or a set_quantity on its ref);
 * (b) a number in a part of the customer's words that names the line ("6 platanos" backs platanos,
 *     never arroz);
 * (c) the one number in the burst, when the question last asked was this one line's quantity.
 * Never a price ("a L 18"), an address or phone number ("casa 5"), or a number in the product's own
 * name ("paquete de 10"). A new item the reader gave a quantity keeps it.
 */
function saidQuantity(value: DecimalString, line: FrameLine, frame: PlannerFrame): boolean {
  if (!isDecimalString(value) || toThousandths(value) === 0) return false;
  if (line.label.startsWith("N") && line.quantity !== null) return sameQuantity(value, line.quantity);
  const reader = frame.readerQuantities.get(line.label);
  if (reader !== undefined && sameQuantity(value, reader)) return true;
  const target = toThousandths(value);
  const parts = partsOf(frame.saidTexts);
  if (parts.filter((part) => names(part, line)).some((part) => quantitiesIn(part, line).some((q) => toThousandths(q) === target))) return true;
  if (frame.askedQuantityOf !== line.label) return false;
  const all = parts.flatMap((part) => quantitiesIn(part, line));
  return all.length === 1 && toThousandths(all[0]!) === target;
}

/** Lowercase, no accents. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
/** Numbers that are never a quantity: prices, addresses, phone numbers. */
const NOT_QUANTITIES = [
  new RegExp(String.raw`(?:\bl|\blps?|\blempiras?|\$)\.?\s*${NUMBER}`, "gu"),
  new RegExp(String.raw`${NUMBER}\s*(?:lempiras?|lps?|pesos?|varas?)\b`, "gu"),
  new RegExp(String.raw`\ba\s+${NUMBER}\s+(?:cada|c\/u|la libra|el)\b`, "gu"),
  new RegExp(String.raw`(?:\b(?:casa|calle|avenida|ave|av|colonia|col|bloque|lote|km|kilometro|numero|num|apartamento|apto)\.?|#|n°)\s*#?\s*${NUMBER}\w*`, "gu"),
  /\d{5,}/gu,
];

/** The customer's words in parts: by commas, "y", lines, and before each number ("6 platanos 2 arroz"). */
function partsOf(texts: readonly string[]): string[] {
  return texts
    .map((text) => NOT_QUANTITIES.reduce((rest, rule) => rest.replace(rule, " "), fold(text)))
    .flatMap((text) => text.split(/[,;\n]|\s+y\s+|\s+(?=\d)/u))
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** The quantities a part says: its numbers, or else one number in words ("dos", "media docena"). */
function quantitiesIn(part: string, line: FrameLine): string[] {
  const clean = withoutNameNumbers(part, [line.said, line.productName ?? ""]);
  const digits = (clean.match(/\d+(?:[.,]\d+)?/gu) ?? []).map((n) => n.replace(",", ".")).filter(isDecimalString);
  if (digits.length > 0) return digits;
  const said = quantityFrom(clean);
  return said === null ? [] : [said];
}

/** The part names the line: a product word of its own, or of its product, plurals folded. */
function names(part: string, line: FrameLine): boolean {
  return sharesWord(part, line.said) || (line.productName !== null && sharesWord(part, line.productName));
}

/** "el paquete de 10" said about "Tortillas paquete 10": the 10 is the product, not the quantity. */
function withoutNameNumbers(text: string, names: readonly string[]): string {
  const numbers = new Set(names.flatMap((name) => name.match(/\d+(?:[.,]\d+)?/gu) ?? []));
  return numbers.size === 0 ? text : text.replace(/\d+(?:[.,]\d+)?/gu, (n) => (numbers.has(n) ? " " : n));
}

function forms(word: string): string[] {
  const out = [word];
  if (word.length > 4 && word.endsWith("es")) out.push(word.slice(0, -2));
  if (word.length > 3 && word.endsWith("s")) out.push(word.slice(0, -1));
  return out;
}

/** The two texts share a product word ("6 platanos" and "plátanos"), plurals folded. */
function sharesWord(text: string, name: string): boolean {
  const own = new Set(productWords(name).filter((word) => !/^\d/u.test(word)).flatMap(forms));
  return productWords(text).some((word) => forms(word).some((form) => own.has(form)));
}

const WEIGHT_UNITS = /^(?:lb|lbs|libras?|kg|kgs|kilos?|kilogramos?|onzas?|oz|gramos?|gr|g)$/u;

export function isWeightUnit(unit: string | null): boolean {
  return unit !== null && WEIGHT_UNITS.test(unit.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim());
}

/** Why a suggested quantity can't stand (D-46), or null when it can. */
function suggestionRefusal(value: string, line: FrameLine, productId: string | null, said: boolean, frame: PlannerFrame): RefusalCode | null {
  const product = productId === null ? undefined : frame.products.get(productId);
  if (value !== "1") return "suggestion_not_one";
  if (said) return "suggestion_quantity_said";
  if (isWeightUnit(line.unit)) return "suggestion_weight_unit";
  if (product?.soldBy === "weight") return "suggestion_sold_by_weight";
  if (line.restricted || product?.restricted === true) return "suggestion_restricted";
  // An unclear item, or one with several products to choose from, isn't settled by a pick: only by
  // the customer naming the product (review finding 4, Nov 2).
  if (line.unclear) return "suggestion_unresolved";
  if (offeredCount(frame, line.label) >= 2) {
    const label = productId === null ? undefined : frame.table.offered.get(line.label)?.find((p) => candidateProduct(frame, p) === productId);
    const how = label === undefined ? undefined : frame.table.howByLine.get(line.label)?.get(label);
    if (how === undefined || !STANDS_ALONE.has(how)) return "suggestion_unresolved";
  }
  return null;
}
