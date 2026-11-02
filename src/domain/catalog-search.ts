/**
 * Finding products in one store's catalog by the words a customer used ("un aceite", "2 jabones",
 * "el clover de litro"). Every meaningful word said must appear in the product's name or other
 * names, as a word: "sal" finds "Sal 1 lb", never "Salsa". Plurals and unit words are folded
 * ("jabones" → "jabon", "litro" → "l"). Nothing is guessed beyond that: no spelling fixes, no
 * similar words. The engine decides what a result means (one: that product; a few: ask which).
 */
/** Lowercase, no accents, single spaces. */
function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Words that carry no product meaning in an order line. */
const FILLER = new Set([
  "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "con", "para", "por", "porfa",
  "favor", "me", "mi", "lo", "le", "que", "ese", "esa", "este", "esta", "eso", "otro", "otra", "marca",
]);

/** Unit words customers write, folded to how product names usually write them. */
const UNITS: Readonly<Record<string, string>> = {
  litro: "l", litros: "l", lt: "l", lts: "l", ltr: "l",
  libra: "lb", libras: "lb", lbs: "lb",
  kilo: "kg", kilos: "kg", kilogramo: "kg", kilogramos: "kg",
  gramo: "g", gramos: "g", gr: "g", grs: "g",
  mililitro: "ml", mililitros: "ml",
};

/** One word in every form it may take: itself, and its singular when it looks plural. */
function forms(word: string): string[] {
  const out = [word];
  if (word.length > 4 && word.endsWith("es")) out.push(word.slice(0, -2));
  if (word.length > 3 && word.endsWith("s")) out.push(word.slice(0, -1));
  return out;
}

/** The meaningful words of a text, normalized and folded. */
export function productWords(text: string): string[] {
  return normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "" && !FILLER.has(word))
    .map((word) => UNITS[word] ?? word);
}

export interface SearchableProduct {
  readonly productId: string;
  readonly names: readonly string[];
  readonly aliases: readonly string[];
}

/**
 * The products whose names hold every meaningful word said, in catalog order. Empty when nothing
 * meaningful was said. A number said must appear exactly ("500" finds "500 ml").
 */
export function searchCatalog<P extends SearchableProduct>(said: string, products: readonly P[]): P[] {
  const asked = productWords(said);
  if (asked.length === 0) return [];
  return products.filter((product) => {
    const own = new Set([...product.names, ...product.aliases].flatMap(productWords).flatMap(forms));
    return asked.every((word) => forms(word).some((form) => own.has(form)));
  });
}
