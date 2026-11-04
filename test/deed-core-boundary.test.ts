/**
 * The core's boundary: every file in src/deed-core/ imports only from its own directory, and its code names no
 * business noun. Comments are not scanned; README.md is not scanned (it may compare the core with the host).
 */
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../src/deed-core/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const scanned = Object.entries(sources).filter(([path]) => !path.endsWith("README.md"));

/** The words the core must not use, whole and inside identifiers (camelCase and snake_case split apart). */
const BUSINESS_WORDS = [
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
  "delivery",
  "dispatch",
  "payment",
];

/**
 * Identifiers the brief fixes by name. Their "Store" is the port's name (`LedgerStore`), not a business noun.
 */
const MANDATED_IDENTIFIERS = new Set(["LedgerStore", "MemoryLedgerStore", "D1LedgerStore"]);

function stripComments(path: string, text: string): string {
  if (path.endsWith(".sql")) return text.replace(/--.*$/gm, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

/** Code without its module specifiers: "./memory-store" names a file, not a word of the core. */
function wordsCodeOf(path: string, text: string): string {
  return stripComments(path, text).replace(/(\bfrom|\bimport)(\s*\(?\s*)["'][^"']+["']/g, "$1$2");
}

function wordsOf(code: string): string[] {
  const identifiers = code.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
  return identifiers
    .filter((identifier) => !MANDATED_IDENTIFIERS.has(identifier))
    .flatMap((identifier) => identifier.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" "))
    .map((word) => word.toLowerCase());
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

  it.each(scanned.filter(([path]) => path.endsWith(".ts")))("%s imports only from its own directory", (path, text) => {
    const code = stripComments(path, text);
    const specifiers = [...code.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]!);
    for (const specifier of specifiers) {
      expect(specifier, path).toMatch(/^\.\/[A-Za-z0-9-]+$/);
    }
  });

  it.each(scanned)("%s names no business word", (path, text) => {
    const words = wordsOf(wordsCodeOf(path, text));
    const found = words.filter((word) => BUSINESS_WORDS.some((business) => word === business || word === `${business}s`));
    expect(found, path).toEqual([]);
  });
});
