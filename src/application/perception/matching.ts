/**
 * Catalog matching, by code, inside one store's catalog: barcode, exact name, known alias. A match
 * needs exactly one product; two candidates at any step are no match, and no weaker step is tried
 * (the engine asks, or staff use match_line). The model never supplies an ID: at most it picks one of the labels code put in the
 * prompt ("la de marca Mazola" -> "P3"), and code maps that label back.
 */
import type { LineMatch } from "../engine";
import type { ItemLine, Observation } from "../../domain/contract/observation";
import type { CatalogLabel } from "../../domain/perception/burst";
import type { LinePick } from "../../domain/perception/validate";

export interface CatalogProduct {
  readonly productId: string;
  /** The first is how the product is shown to the model. */
  readonly names: readonly string[];
  readonly aliases: readonly string[];
  readonly barcode: string | null;
}

/** A model pick mapped to a product by code. Kept apart from LineMatch until the contract has it. */
export interface LabelMatch extends LinePick {
  readonly productId: string;
}

/** At most this many products are shown to the model as labels. */
export const MAX_CATALOG_LABELS = 200;

export interface LabelledCatalog {
  readonly labels: readonly CatalogLabel[];
  readonly productByLabel: ReadonlyMap<string, string>;
}

export function labelCatalog(products: readonly CatalogProduct[]): LabelledCatalog {
  const labels: CatalogLabel[] = [];
  const productByLabel = new Map<string, string>();
  for (const product of products.slice(0, MAX_CATALOG_LABELS)) {
    const name = product.names[0];
    if (!name) continue;
    const label = `P${labels.length + 1}`;
    labels.push({ label, text: name });
    productByLabel.set(label, product.productId);
  }
  return { labels, productByLabel };
}

/** Lines matched by barcode, exact name or known alias. Unmatched lines are simply absent. */
export function matchLines(observations: readonly Observation[], products: readonly CatalogProduct[]): LineMatch[] {
  const matches: LineMatch[] = [];
  observations.forEach((observation, index) => {
    linesOf(observation).forEach((line, lineIndex) => {
      if (!line) return;
      const found = matchName(line.name, products);
      if (found) matches.push({ observation: index, line: lineIndex, productId: found.productId, how: found.how });
    });
  });
  return matches;
}

/** Model picks for lines code couldn't match, mapped through the labels code supplied. */
export function resolvePicks(
  picks: readonly LinePick[],
  catalog: LabelledCatalog,
  codeMatches: readonly LineMatch[],
): LabelMatch[] {
  const matched = new Set(codeMatches.map((match) => `${match.observation}:${match.line}`));
  const out: LabelMatch[] = [];
  for (const pick of picks) {
    const productId = catalog.productByLabel.get(pick.label);
    if (productId && !matched.has(`${pick.observation}:${pick.line}`)) out.push({ ...pick, productId });
  }
  return out;
}

/** Lines by index (edits, for order_change: only `add` edits carry a line). */
function linesOf(observation: Observation): readonly (ItemLine | null)[] {
  switch (observation.kind) {
    case "customer_order":
    case "sale_report":
    case "fiado_report":
    case "supplier_invoice":
      return observation.lines;
    case "order_change":
      return observation.edits.map((edit) => (edit.op === "add" ? edit.line : null));
    default:
      return [];
  }
}

/**
 * Barcode, then exact name, then known alias. A step with several candidates ends the search
 * unresolved: a later, weaker step never breaks a tie the stronger one couldn't.
 */
function matchName(
  said: string,
  products: readonly CatalogProduct[],
): { productId: string; how: LineMatch["how"] } | null {
  const name = normalize(said);
  if (name === "") return null;
  const steps: [LineMatch["how"], (product: CatalogProduct) => boolean][] = [
    ["exact_name", (product) => product.names.some((n) => normalize(n) === name)],
    ["known_alias", (product) => product.aliases.some((a) => normalize(a) === name)],
  ];
  if (/^\d{8,14}$/.test(name)) steps.unshift(["barcode", (product) => product.barcode === name]);
  for (const [how, fits] of steps) {
    const [first, ...more] = products.filter(fits);
    if (more.length > 0) return null;
    if (first) return { productId: first.productId, how };
  }
  return null;
}

/** Lowercase, no accents, single spaces. */
export function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}
