/**
 * Retrieval (D-49): candidates per item line from the WHOLE store catalog, pure. Products are
 * synthetic: a 300-product catalog with the ones under test placed past the old 200-label cutoff.
 */
import { describe, expect, it } from "vitest";
import type { LearnedAlias, RetrievableProduct, RetrievalLine } from "../src/domain/planner/types";
import { MAX_CANDIDATES_PER_LINE } from "../src/domain/planner/types";
import { aliasWords, retrieveCandidates, STANDS_ALONE } from "../src/domain/retrieval";

function product(productId: string, name: string, more: Partial<RetrievableProduct> = {}): RetrievableProduct {
  return {
    productId,
    names: [name],
    aliases: [],
    barcode: null,
    soldBy: null,
    usualQuantity: null,
    hasPrice: true,
    availability: "no_se",
    restricted: false,
    ...more,
  };
}

const CATEGORIES = ["Galletas", "Jabón de baño", "Detergente", "Cereal", "Atún", "Frijoles rojos", "Café molido", "Pasta dental", "Shampoo", "Fósforos"];
const BRANDS = ["Zeta", "Omega", "Delta", "Sigma", "Kappa", "Lambda", "Gamma", "Theta", "Iota", "Beta"];

/** The products under test, each placed at its index (all past 200). */
const PLACED: readonly [number, RetrievableProduct][] = [
  [250, product("salsa-naturas", "Salsa de tomate Naturas 400 g", { aliases: ["ketchup"] })],
  [260, product("aceite-clover-1l", "Aceite Clover 1 L")],
  [261, product("aceite-clover-500", "Aceite Clover 500 ml")],
  [262, product("aceite-mazola-1l", "Aceite Mazola 1 L", { soldBy: "unit", usualQuantity: "1", hasPrice: false, availability: "se_acabo" })],
  [270, product("pollo-entero", "Pollo entero", { soldBy: "weight" })],
  [271, product("pechuga", "Pechuga de pollo 1 lb", { soldBy: "weight" })],
  [272, product("papel", "Papel higiénico 4 rollos")],
  [280, product("cerveza", "Cerveza Salva Vida", { restricted: true })],
  [290, product("leche", "Leche Sula 1 L", { barcode: "7401234567890" })],
];

/** 300 products: 10 categories × 10 brands × 3 sizes, with PLACED put at their indexes. */
function catalog(size = 300): RetrievableProduct[] {
  const products = Array.from({ length: size }, (_, i) => {
    const name = `${CATEGORIES[i % 10]} ${BRANDS[Math.floor(i / 10) % 10]} ${(Math.floor(i / 100) + 1) * 100} g`;
    return product(`filler-${i}`, i >= 300 ? `${name} lote ${Math.floor(i / 300)}` : name);
  });
  for (const [index, placed] of PLACED) products[index] = placed;
  return products;
}

const line = (label: string, said: string, unit: string | null = null): RetrievalLine => ({ label, said, unit });

/** The products offered for a line, best first, with how they were found for it. */
function offeredFor(lines: readonly RetrievalLine[], products: readonly RetrievableProduct[], aliases: readonly LearnedAlias[] = []) {
  const table = retrieveCandidates(lines, products, aliases);
  const byLabel = new Map(table.candidates.map((c) => [c.label, c]));
  return (label: string) =>
    (table.offered.get(label) ?? []).map((p) => ({ productId: byLabel.get(p)!.productId, how: table.howByLine.get(label)!.get(p)! }));
}

describe("retrieval over the whole catalog", () => {
  it("finds a product past the first 200, by its exact name and by some of its words", () => {
    const products = catalog();
    expect(products.findIndex((p) => p.productId === "salsa-naturas")).toBeGreaterThanOrEqual(200);
    const found = offeredFor([line("N1", "salsa de tomate naturas 400 g"), line("N2", "salsa de tomate")], products);
    // Exact name stands alone.
    expect(found("N1")).toEqual([{ productId: "salsa-naturas", how: "exact_name" }]);
    expect(found("N2")).toEqual([{ productId: "salsa-naturas", how: "all_words" }]);
  });

  it("reaches «Salsa de tomate…» for «catsup» only through the reader's other names, ranked as such", () => {
    const products = catalog();
    const withNames = (said: string, otherNames: readonly string[]): RetrievalLine => ({ ...line("N1", said), otherNames });
    // No spelling table: "catsup" alone finds nothing.
    expect(offeredFor([line("N1", "catsup")], products)("N1").map((c) => c.productId)).not.toContain("salsa-naturas");
    for (const said of ["catsup", "Catsup", "una catchup"]) {
      const found = offeredFor([withNames(said, ["ketchup", "salsa de tomate"])], products)("N1");
      expect(found.find((c) => c.productId === "salsa-naturas"), said).toEqual({ productId: "salsa-naturas", how: "other_name" });
      expect(found.some((c) => STANDS_ALONE.has(c.how)), said).toBe(false);
    }
    // The product's own other name, said as such, still stands alone.
    expect(offeredFor([line("N1", "kétchup")], products)("N1")).toEqual([{ productId: "salsa-naturas", how: "known_alias" }]);
    // Below the customer's own words: what their words find comes first.
    const salsas = offeredFor([withNames("salsa", ["ketchup"])], products)("N1");
    expect(salsas[0]).toEqual({ productId: "salsa-naturas", how: "all_words" });
  });

  it("never offers «Papel higiénico 4 rollos» for pollo", () => {
    const products = catalog();
    const found = offeredFor([line("N1", "pollo"), line("N2", "pollos"), line("N3", "pollo", "libras"), line("N4", "pollo frito")], products);
    for (const label of ["N1", "N2", "N3", "N4"]) {
      const ids = found(label).map((c) => c.productId);
      expect(ids, label).not.toContain("papel");
      expect(ids, label).toEqual(expect.arrayContaining(["pollo-entero", "pechuga"]));
    }
    // Said by the pound: the product that names the pound comes first.
    expect(found("N3")[0]!.productId).toBe("pechuga");
  });

  it("finds aceite for «aciete» as near spelling only: a candidate, never a match", () => {
    const products = catalog();
    const table = retrieveCandidates([line("N1", "aciete")], products, []);
    const found = offeredFor([line("N1", "aciete")], products)("N1");
    expect(found.map((c) => c.productId).sort()).toEqual(["aceite-clover-1l", "aceite-clover-500", "aceite-mazola-1l"]);
    expect(found.every((c) => c.how === "near_spelling")).toBe(true);
    expect(found.some((c) => STANDS_ALONE.has(c.how))).toBe(false);
    expect(table.candidates.every((c) => c.how === "near_spelling")).toBe(true);
  });

  it("an approved alias is an exact match; without it the same words are only candidates", () => {
    const products = catalog();
    const without = offeredFor([line("N1", "salsa roja")], products)("N1");
    expect(without.every((c) => !STANDS_ALONE.has(c.how))).toBe(true);
    const aliases: LearnedAlias[] = [{ words: aliasWords("salsa roja")!, productId: "salsa-naturas" }];
    expect(offeredFor([line("N1", "la salsa roja")], products, aliases)("N1")).toEqual([{ productId: "salsa-naturas", how: "learned_alias" }]);
    // An alias for a product the store no longer has is ignored.
    expect(offeredFor([line("N1", "salsa roja")], products, [{ words: "salsa roja", productId: "gone" }])("N1")).toEqual(without);
  });

  it("the store's own names come before a learned alias, and ties are all offered", () => {
    const products = [...catalog(), product("ketchup-b", "Salsa Kern 397 g", { aliases: ["ketchup"] })];
    const aliases: LearnedAlias[] = [{ words: "ketchup", productId: "pollo-entero" }];
    expect(offeredFor([line("N1", "ketchup")], products, aliases)("N1")).toEqual([
      { productId: "salsa-naturas", how: "known_alias" },
      { productId: "ketchup-b", how: "known_alias" },
    ]);
  });

  it("labels are shared across lines; how is per line, and the candidate keeps the strongest", () => {
    const products = catalog();
    const lines = [line("N1", "aceite"), line("N2", "aceite clover de 1 litro"), line("L3", "pechuga")];
    const table = retrieveCandidates(lines, products, []);
    const n1 = table.offered.get("N1")!;
    const n2 = table.offered.get("N2")!;
    expect(n1).toHaveLength(3);
    expect(n2).toHaveLength(1);
    expect(n1).toContain(n2[0]);
    expect(table.howByLine.get("N1")!.get(n2[0]!)).toBe("all_words");
    expect(table.howByLine.get("N2")!.get(n2[0]!)).toBe("exact_name");
    expect(table.candidates.find((c) => c.label === n2[0])).toMatchObject({ productId: "aceite-clover-1l", how: "exact_name" });
    expect(table.candidates.map((c) => c.label)).toEqual(table.candidates.map((_, i) => `P${i + 1}`));
    expect(new Set(table.candidates.map((c) => c.productId)).size).toBe(table.candidates.length);
  });

  it("offers at most five, closest first, and a said unit ranks its size first", () => {
    const products = catalog();
    const galletas = offeredFor([line("N1", "galletas")], products)("N1");
    expect(galletas).toHaveLength(MAX_CANDIDATES_PER_LINE);
    expect(galletas.every((c) => c.how === "all_words")).toBe(true);
    const aceite = offeredFor([line("N1", "aceite", "litro")], products)("N1").map((c) => c.productId);
    expect(aceite.slice(0, 2).sort()).toEqual(["aceite-clover-1l", "aceite-mazola-1l"]);
    expect(aceite[2]).toBe("aceite-clover-500");
  });

  it("some word said: only words that name a product, never a number or a unit", () => {
    const products = catalog();
    expect(offeredFor([line("N1", "pepino 1 lb")], products)("N1")).toEqual([]);
    const found = offeredFor([line("N1", "aceite de coco 1 l")], products)("N1");
    expect(found.map((c) => c.how)).toEqual(["any_word", "any_word", "any_word"]);
    expect(found[0]!.productId).toBe("aceite-clover-1l");
  });

  it("a barcode stands alone; a line with nothing meaningful gets nothing", () => {
    const products = catalog();
    const found = offeredFor([line("N1", "7401234567890"), line("N2", "eso"), line("N3", "")], products);
    expect(found("N1")).toEqual([{ productId: "leche", how: "barcode" }]);
    expect(found("N2")).toEqual([]);
    expect(found("N3")).toEqual([]);
  });

  it("carries what the planner may know, and nothing it may not", () => {
    const products = catalog();
    const table = retrieveCandidates([line("N1", "aceite mazola"), line("N2", "cerveza salva vida")], products, []);
    expect(table.candidates[0]).toEqual({
        label: "P1",
        productId: "aceite-mazola-1l",
        name: "Aceite Mazola 1 L",
        soldBy: "unit",
        usualQuantity: "1",
        hasPrice: false,
        availability: "se_acabo",
        restricted: false,
        how: "all_words",
      });
    // The other aceites follow as weaker candidates (the planner may offer one when Mazola is out).
    expect(table.offered.get("N1")).toHaveLength(3);
    expect(table.candidates.find((c) => c.productId === "cerveza")).toMatchObject({ restricted: true, how: "exact_name" });
    expect(Object.keys(table.candidates[0]!).sort()).toEqual(
      ["availability", "hasPrice", "how", "label", "name", "productId", "restricted", "soldBy", "usualQuantity"],
    );
  });

  it("keeps aliases under the words retrieval compares", () => {
    expect(aliasWords("La Catsup")).toBe("catsup");
    expect(aliasWords("  Aceite de 1 LITRO ")).toBe("aceite 1 l");
    expect(aliasWords("jabón")).toBe("jabon");
    expect(aliasWords("eso")).toBeNull();
    expect(aliasWords("")).toBeNull();
    expect(aliasWords("palabra ".repeat(20))).toBeNull();
  });

  it("is fast for a few thousand products and a long list", () => {
    const products = catalog(3_000);
    const said = ["aciete", "pollo", "galletas zeta", "catsup", "salsa de tomate", "detergete", "pepino", "cafe molido omega 300 g"];
    const lines = Array.from({ length: 40 }, (_, i) => line(`N${i + 1}`, said[i % said.length]!));
    const started = performance.now();
    const table = retrieveCandidates(lines, products, []);
    const elapsed = performance.now() - started;
    expect(table.offered.size).toBe(40);
    expect(elapsed).toBeLessThan(1_000);
  });
});
