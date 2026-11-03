/**
 * Interim retrieval, until lane L1's `retrieveCandidates` (src/domain/retrieval.ts) is merged in its
 * place: same shape, built from what exists. Per line, over the whole store catalog (no 200-product
 * cutoff), at most MAX_CANDIDATES_PER_LINE products:
 * 1. exact steps, as `matchLines` takes them: barcode, exact name, known alias, an approved learned
 *    alias. One step that finds products ends the search.
 * 2. every meaningful word said, as `searchCatalog` takes them ("sal" never finds "Salsa").
 * 3. only when nothing fits all the words: products sharing any word, then products one typing slip
 *    away. Typo hits are only ever candidates for the planner to weigh, never a match by themselves.
 * Each product gets one P label for the turn, whichever lines it is offered for.
 */
import { productWords, searchCatalog } from "../../domain/catalog-search";
import {
  type Candidate,
  type CandidateHow,
  type CandidateTable,
  type LearnedAlias,
  MAX_CANDIDATES_PER_LINE,
  type RetrievableProduct,
  type RetrievalLine,
} from "../../domain/planner/types";
import { normalize } from "../perception/matching";

export type RetrieveCandidates = (
  lines: readonly RetrievalLine[],
  products: readonly RetrievableProduct[],
  aliases: readonly LearnedAlias[],
) => CandidateTable;

export const interimRetrieveCandidates: RetrieveCandidates = (lines, products, aliases) => {
  const candidates: Candidate[] = [];
  const labelOf = new Map<string, string>();
  const offered = new Map<string, readonly string[]>();
  for (const line of lines) {
    const found = findFor(line.said, products, aliases).slice(0, MAX_CANDIDATES_PER_LINE);
    offered.set(
      line.label,
      found.map(({ product, how }) => {
        let label = labelOf.get(product.productId);
        if (label === undefined) {
          label = `P${candidates.length + 1}`;
          labelOf.set(product.productId, label);
          candidates.push({
            label,
            productId: product.productId,
            name: product.names[0] ?? product.productId,
            soldBy: product.soldBy,
            usualQuantity: product.usualQuantity,
            hasPrice: product.hasPrice,
            availability: product.availability,
            restricted: product.restricted,
            how,
          });
        }
        return label;
      }),
    );
  }
  return { candidates, offered };
};

type Found = { readonly product: RetrievableProduct; readonly how: CandidateHow };

function findFor(said: string, products: readonly RetrievableProduct[], aliases: readonly LearnedAlias[]): Found[] {
  const name = normalize(said);
  if (name === "") return [];
  const learned = new Set(aliases.filter((alias) => normalize(alias.words) === name).map((alias) => alias.productId));
  const steps: [CandidateHow, (product: RetrievableProduct) => boolean][] = [
    ["barcode", (product) => /^\d{8,14}$/u.test(name) && product.barcode === name],
    ["exact_name", (product) => product.names.some((n) => normalize(n) === name)],
    ["known_alias", (product) => product.aliases.some((a) => normalize(a) === name)],
    ["learned_alias", (product) => learned.has(product.productId)],
  ];
  for (const [how, fits] of steps) {
    const found = products.filter(fits);
    if (found.length > 0) return found.map((product) => ({ product, how }));
  }
  const asked = productWords(said).filter((word) => !/^\d/u.test(word));
  const own = (product: RetrievableProduct) => new Set([...product.names, ...product.aliases].flatMap(productWords).flatMap(forms));
  const shared = (product: RetrievableProduct) => {
    const mine = own(product);
    return asked.filter((word) => forms(word).some((form) => mine.has(form))).length;
  };
  const searched = searchCatalog(said, products);
  const allWords = searched.filter((product) => asked.length > 0 && shared(product) === asked.length);
  if (allWords.length > 0) return allWords.map((product) => ({ product, how: "all_words" }));
  const anyWord = products
    .map((product) => ({ product, count: shared(product) }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count)
    .map(({ product }): Found => ({ product, how: "any_word" }));
  const near = searched.filter((product) => !anyWord.some((found) => found.product === product)).map((product): Found => ({ product, how: "near_spelling" }));
  return [...anyWord, ...near];
}

function forms(word: string): string[] {
  const out = [word];
  if (word.length > 4 && word.endsWith("es")) out.push(word.slice(0, -2));
  if (word.length > 3 && word.endsWith("s")) out.push(word.slice(0, -1));
  return out;
}
