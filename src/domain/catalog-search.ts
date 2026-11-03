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
  "favor", "porfavor", "porfis", "plis", "please", "xfa", "xfavor", "pf", "gracias", "ok", "va", "si", "sí",
  "quiero", "deme", "dame", "mande", "mandame", "mandeme", "ponga", "pongame",
  "me", "mi", "lo", "le", "que", "ese", "esa", "este", "esta", "eso", "otro", "otra", "marca",
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
export function forms(word: string): string[] {
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
  const ownWords = (product: P) => new Set([...product.names, ...product.aliases].flatMap(productWords).flatMap(forms));
  const exact = products.filter((product) => {
    const own = ownWords(product);
    return asked.every((word) => forms(word).some((form) => own.has(form)));
  });
  if (exact.length > 0) return exact;
  // Nothing fits as written: one slip in a long word ("aciete", "detergete") is forgiven, never in a
  // number or a short word, and only when the words as written found nothing.
  return products.filter((product) => {
    const own = [...ownWords(product)];
    return asked.every((word) => forms(word).some((form) => own.some((mine) => mine === form || oneSlip(form, mine))));
  });
}

/** Two long words one typing slip apart (a letter changed, missing, extra, or two swapped), same first letter. */
export function oneSlip(a: string, b: string): boolean {
  // Long words only, same first letter: "aciete" is aceite, but "pollo" is never "rollo".
  if (a.length < 6 || b.length < 6 || a[0] !== b[0] || /\d/u.test(a) || /\d/u.test(b) || Math.abs(a.length - b.length) > 1) return false;
  // Optimal string alignment distance, stopped as soon as it can't be 1 or less.
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array<number>(b.length + 1).fill(0));
    rows[i]![0] = i;
  }
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = d;
      best = Math.min(best, d);
    }
    if (best > 1) return false;
  }
  return rows[a.length]![b.length]! <= 1;
}
