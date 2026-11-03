/**
 * Retrieval (D-49): for each item line, the few products from the WHOLE store catalog the planner
 * may choose from, best first, labelled P1… for this turn. Pure: no I/O, no model, no vectors.
 *
 * Evidence, strongest first: barcode, exact name, the product's own other names, a name the store
 * approved (learned alias), every word said, some word said, a name the reader proposed for the
 * item (`other_name`: "catsup" → "ketchup"), near spelling. A hit on one of the
 * first four stands alone (several hits on the same step are all offered). Anything weaker is only
 * a candidate, at most MAX_CANDIDATES_PER_LINE per line. Near spelling ("aciete") is never more
 * than a candidate, ranked last. Words are compared the way catalog-search compares them (case,
 * accents, filler words, plurals, unit words), so "pollo" never finds "Papel higiénico 4 rollos".
 */
import { forms, oneSlip, productWords } from "./catalog-search";
import {
  type Candidate,
  type CandidateHow,
  type CandidateTable,
  type LearnedAlias,
  MAX_CANDIDATES_PER_LINE,
  type RetrievableProduct,
  type RetrievalLine,
} from "./planner/types";

/** The candidate table; `howByLine` (how each was found, per line) now lives in `CandidateTable`. */
export type RetrievedCandidates = CandidateTable;

/** Evidence that may stand alone: one hit here is that product. */
export const STANDS_ALONE: ReadonlySet<CandidateHow> = new Set(["barcode", "exact_name", "known_alias", "learned_alias"]);

const STRENGTH: readonly CandidateHow[] = [
  "barcode",
  "exact_name",
  "known_alias",
  "learned_alias",
  "all_words",
  "any_word",
  "other_name",
  "near_spelling",
];

/** Longest learned-alias key kept (the words of one item, not a sentence). */
export const MAX_ALIAS_CHARS = 80;

/** A run of meaningful words and every form they may take. */
interface Phrase {
  readonly words: readonly string[];
  readonly forms: ReadonlySet<string>;
}

interface Entry {
  readonly product: RetrievableProduct;
  readonly position: number;
  readonly names: readonly Phrase[];
  readonly aliases: readonly Phrase[];
  /** Every form of every word in the product's names and other names. */
  readonly own: ReadonlySet<string>;
  /** The long ones, for near spelling. */
  readonly slippable: readonly string[];
}

interface Found {
  readonly entry: Entry;
  readonly how: CandidateHow;
}

/**
 * The words a learned alias is kept under: what retrieval compares, so "la Catsup" and "catsup"
 * are one alias. Null when nothing meaningful is left, or it's longer than an item name.
 */
export function aliasWords(said: string): string | null {
  const words = productWords(said).join(" ");
  return words === "" || words.length > MAX_ALIAS_CHARS ? null : words;
}

export function retrieveCandidates(
  lines: readonly RetrievalLine[],
  products: readonly RetrievableProduct[],
  aliases: readonly LearnedAlias[],
): RetrievedCandidates {
  const index = products.flatMap((product, position) => (product.names[0] ? [entryOf(product, position)] : []));
  const byId = new Map(index.map((entry) => [entry.product.productId, entry]));
  const learned = aliases.flatMap((alias) => {
    const entry = byId.get(alias.productId);
    const phrase = phraseOf(alias.words);
    return entry === undefined || phrase.words.length === 0 ? [] : [{ entry, phrase }];
  });

  const labels = new Map<string, string>();
  const strongest = new Map<string, CandidateHow>();
  const offered = new Map<string, readonly string[]>();
  const howByLine = new Map<string, ReadonlyMap<string, CandidateHow>>();
  for (const line of lines) {
    if (offered.has(line.label)) continue;
    const row = new Map<string, CandidateHow>();
    for (const { entry, how } of lookUp(line, index, learned)) {
      const id = entry.product.productId;
      let label = labels.get(id);
      if (label === undefined) {
        label = `P${labels.size + 1}`;
        labels.set(id, label);
      }
      const before = strongest.get(id);
      if (before === undefined || STRENGTH.indexOf(how) < STRENGTH.indexOf(before)) strongest.set(id, how);
      row.set(label, how);
    }
    offered.set(line.label, [...row.keys()]);
    howByLine.set(line.label, row);
  }

  const candidates = [...labels].map(([id, label]) => candidateOf(label, byId.get(id)!.product, strongest.get(id)!));
  return { candidates, offered, howByLine };
}

/** One line's candidates, best first. */
function lookUp(line: RetrievalLine, index: readonly Entry[], learned: readonly { entry: Entry; phrase: Phrase }[]): Found[] {
  const code = line.said.replace(/\s+/g, "");
  if (/^\d{8,14}$/.test(code)) {
    const hits = index.filter((entry) => entry.product.barcode === code);
    if (hits.length > 0) return hits.slice(0, MAX_CANDIDATES_PER_LINE).map((entry) => ({ entry, how: "barcode" }));
  }
  const said = phraseOf(line.said);
  if (said.words.length === 0) return [];

  const exactSteps: readonly [CandidateHow, () => Entry[]][] = [
    ["exact_name", () => index.filter((entry) => entry.names.some((name) => samePhrase(said, name)))],
    ["known_alias", () => index.filter((entry) => entry.aliases.some((alias) => samePhrase(said, alias)))],
    ["learned_alias", () => [...new Set(learned.filter(({ phrase }) => samePhrase(said, phrase)).map(({ entry }) => entry))]],
  ];
  for (const [how, hitsOf] of exactSteps) {
    const hits = hitsOf();
    if (hits.length > 0) return hits.slice(0, MAX_CANDIDATES_PER_LINE).map((entry) => ({ entry, how }));
  }

  const unit = line.unit === null ? [] : wordsOf(line.unit);
  const found: Found[] = [];
  const taken = new Set<Entry>();
  const take = (how: CandidateHow, hits: readonly Entry[], score: (entry: Entry) => number = () => 0) => {
    const ranked = hits
      .filter((entry) => !taken.has(entry))
      .map((entry) => ({ entry, key: [-score(entry), unit.some((word) => hasWord(entry.own, word)) ? 0 : 1, extraWords(said, entry), entry.position] }))
      .sort((a, b) => compareKeys(a.key, b.key));
    for (const { entry } of ranked) {
      if (found.length >= MAX_CANDIDATES_PER_LINE) return;
      taken.add(entry);
      found.push({ entry, how });
    }
  };

  take("all_words", index.filter((entry) => said.words.every((word) => hasWord(entry.own, word))));
  // Some word said, only words that name a product: never a number or a unit ("1", "lb").
  const content = said.words.filter((word) => word.length >= 3 && !/\d/u.test(word));
  if (found.length < MAX_CANDIDATES_PER_LINE && content.length > 0) {
    const matched = (entry: Entry) => content.filter((word) => hasWord(entry.own, word)).length;
    take("any_word", index.filter((entry) => matched(entry) > 0), matched);
  }
  // Other names the reader proposed ("catsup" → "ketchup", "salsa de tomate"): below the customer's
  // own words, above near spelling. A product's name or other name, or all of the name's words.
  const others = (line.otherNames ?? []).map(phraseOf).filter((phrase) => phrase.words.length > 0);
  if (found.length < MAX_CANDIDATES_PER_LINE && others.length > 0) {
    const fits = (entry: Entry) =>
      others.some(
        (other) =>
          [...entry.names, ...entry.aliases].some((name) => samePhrase(other, name)) || other.words.every((word) => hasWord(entry.own, word)),
      );
    take("other_name", index.filter(fits));
  }
  if (found.length < MAX_CANDIDATES_PER_LINE) {
    take("near_spelling", index.filter((entry) => nearSpelling(said, entry)));
  }
  return found;
}

/** Every word said is the product's, as written or one slip away, and at least one is a slip. */
function nearSpelling(said: Phrase, entry: Entry): boolean {
  let slipped = false;
  for (const word of said.words) {
    if (hasWord(entry.own, word)) continue;
    if (!forms(word).some((form) => entry.slippable.some((mine) => oneSlip(form, mine)))) return false;
    slipped = true;
  }
  return slipped;
}

function entryOf(product: RetrievableProduct, position: number): Entry {
  const names = product.names.map(phraseOf);
  const aliases = product.aliases.map(phraseOf);
  const own = new Set([...names, ...aliases].flatMap((phrase) => [...phrase.forms]));
  return { product, position, names, aliases, own, slippable: [...own].filter((word) => word.length >= 6) };
}

function candidateOf(label: string, product: RetrievableProduct, how: CandidateHow): Candidate {
  return {
    label,
    productId: product.productId,
    name: product.names[0]!,
    soldBy: product.soldBy,
    usualQuantity: product.usualQuantity,
    hasPrice: product.hasPrice,
    availability: product.availability,
    restricted: product.restricted,
    how,
  };
}

/**
 * The meaningful words of a text as retrieval compares them: catalog-search's. Other spellings and
 * names ("catsup" for "ketchup") come from the reader's proposed other names, never a table here.
 */
function wordsOf(text: string): string[] {
  return productWords(text);
}

function phraseOf(text: string): Phrase {
  const words = wordsOf(text);
  return { words, forms: new Set(words.flatMap(forms)) };
}

/** The word, in any of its forms, is among these forms. */
function hasWord(own: ReadonlySet<string>, word: string): boolean {
  return forms(word).some((form) => own.has(form));
}

/** The same words both ways, in any order and number: "arroz de 1 libra" is "Arroz 1 lb". */
function samePhrase(said: Phrase, name: Phrase): boolean {
  return name.words.length > 0 && said.words.every((word) => hasWord(name.forms, word)) && name.words.every((word) => hasWord(said.forms, word));
}

/** How many words of the closest name weren't said: fewer is a closer fit. */
function extraWords(said: Phrase, entry: Entry): number {
  let fewest = Infinity;
  for (const phrase of [...entry.names, ...entry.aliases]) {
    fewest = Math.min(fewest, phrase.words.filter((word) => !hasWord(said.forms, word)).length);
  }
  return fewest;
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}
