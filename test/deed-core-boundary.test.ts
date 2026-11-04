/**
 * The core's boundary: every file in src/deed-core/, subdirectories included, imports only from its own directory, and
 * its code names no business word. Comments are not scanned; README.md is not scanned (it may compare the core with
 * the host).
 */
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../src/deed-core/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const scanned = Object.entries(sources).filter(([path]) => !path.endsWith("README.md"));

/**
 * The stems the core must not use. A word that starts with one is refused: "businesses", "deliveries", "orderedAt"
 * and "order2" are the business's words too. "deliver" stands for "delivery" and its plural.
 */
const BUSINESS_STEMS = [
  "order",
  "customer",
  "product",
  "stock",
  "receipt",
  "draft",
  "invoice",
  "price",
  "store",
  "business",
  "whatsapp",
  "staff",
  "member",
  "deliver",
  "dispatch",
  "payment",
];

/**
 * Identifiers the brief fixes by name. Their "Store" is the port's name (`LedgerStore`), not a business noun.
 */
const MANDATED_IDENTIFIERS = new Set(["LedgerStore", "MemoryLedgerStore", "D1LedgerStore"]);

/** Ordinary English the core uses in its own sense, which a stem would wrongly catch: "stored beside the input". */
const ORDINARY_WORDS = new Set(["stored"]);

/** The code with its comments blanked. String literals are kept whole, so a `//` inside one is not a comment. */
function stripComments(path: string, text: string): string {
  const sql = path.endsWith(".sql");
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      let end = i + 1;
      while (end < text.length && text[end] !== ch) end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end + 1;
    } else if (sql ? ch === "-" && next === "-" : ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      out += " ";
    } else if (!sql && ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      out += " ";
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Code without its module specifiers: "./memory-store" names a file, not a word of the core. */
function wordsCodeOf(path: string, text: string): string {
  return stripComments(path, text).replace(/(\bfrom|\bimport)(\s*\(?\s*)["'][^"']+["']/g, "$1$2");
}

function wordsOf(code: string): string[] {
  const identifiers = code.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
  return identifiers
    .filter((identifier) => !MANDATED_IDENTIFIERS.has(identifier))
    .flatMap((identifier) => identifier.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[^A-Za-z]+/))
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

/** Every problem the boundary finds in one file: an outside import, a dynamic import that isn't a literal, a business word. */
function problemsOf(path: string, text: string): string[] {
  const problems: string[] = [];
  const code = stripComments(path, text);
  if (path.endsWith(".ts")) {
    for (const match of code.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      if (!/^\.\/[A-Za-z0-9-]+$/.test(match[1]!)) problems.push(`imports ${match[1]}`);
    }
    for (const match of code.matchAll(/\bimport\s*\(/g)) {
      if (!/^\s*["']\.\/[A-Za-z0-9-]+["']\s*\)/.test(code.slice(match.index! + match[0].length))) problems.push("import() of a non-literal specifier");
    }
  }
  for (const word of wordsOf(wordsCodeOf(path, text))) {
    if (!ORDINARY_WORDS.has(word) && BUSINESS_STEMS.some((stem) => word.startsWith(stem))) problems.push(`business word ${word}`);
  }
  return problems;
}

describe("the core's boundary", () => {
  it("reads every file of the core", () => {
    expect(scanned.map(([path]) => path.split("/").pop()).sort()).toEqual([
      "d1-store.ts",
      "index.ts",
      "judge.ts",
      "liveness.ts",
      "memory-store.ts",
      "pair.ts",
      "recheck.ts",
      "schema.sql",
      "store.ts",
      "types.ts",
    ]);
  });

  it.each(scanned)("%s has no outside import and no business word", (path, text) => {
    expect(problemsOf(path, text), path).toEqual([]);
  });
});

describe("the boundary scanner catches what it must (each snippet is a way around the test it replaced)", () => {
  it.each([
    ["a business word", "export const businesses = 1;"],
    ["a plural of one", "export const deliveries = 1;"],
    ["an inflection in an identifier", "export const orderedAt = 1;"],
    ["a digit suffix", "export const order2 = 1;"],
    ["a business word in a string after //", 'export const u = "https://x/order/customer";'],
    ["an outside import after // in a string", 'export const u = "http://x"; import { y } from "../domain/facts"; export { y };'],
    ["a dynamic import with a template literal", "export const m = () => import(`../domain/facts`);"],
    ["a dynamic import of a variable", "export const m = (p: string) => import(p);"],
    ["a re-export from outside", 'export * from "../domain/facts";'],
  ])("refuses %s", (_, snippet) => {
    expect(problemsOf("snippet.ts", snippet).length).toBeGreaterThan(0);
  });

  it("does not refuse what the comments say", () => {
    expect(problemsOf("snippet.ts", "// the order of checks: business words here do not count\nexport const bagCount = 1;")).toEqual([]);
    expect(problemsOf("snippet.ts", "/* from \"../domain/facts\" */ export const count = 1;")).toEqual([]);
  });

  it("reads a SQL comment as a comment, and a SQL string as a string", () => {
    expect(problemsOf("schema.sql", "-- the store's order\nCREATE TABLE t (id TEXT);")).toEqual([]);
    expect(problemsOf("schema.sql", "CREATE TABLE t (note TEXT DEFAULT 'order');")).toEqual(["business word order"]);
  });
});
