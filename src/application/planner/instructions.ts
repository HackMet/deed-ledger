/**
 * The planner's system prompt: instruction layer 1 (base, any WhatsApp counter agent) and layer 2
 * (the business type), joined (D-48). Both are Markdown files in ./instructions/, bundled as text
 * (wrangler.jsonc "rules"; the test pool reads the same rules), so they are edited as prose and
 * changed by a reviewed diff. Layer 3, the store's own data, is never prose: code puts it in the
 * user turn (input.ts). Layers 1 and 2 together stay at or under about 120 lines.
 *
 * Each layer's version is a hash of its text, so the logs always name the exact words the planner
 * was given, and an edit can't forget to bump a version.
 */
import base from "./instructions/base.md";
import mercadito from "./instructions/mercadito.md";
import oneCall from "./instructions/one-call.md";

export interface InstructionLayer {
  readonly name: string;
  readonly text: string;
  /** "base@1a2b3c4d": the layer's name and a hash of its text. */
  readonly version: string;
}

export const BASE_LAYER: InstructionLayer = layer("base", base);

/** One file per business type; a new store of a known type is rows in D1, not a new file. */
export const BUSINESS_LAYERS = { mercadito: layer("mercadito", mercadito) } as const;

export type BusinessType = keyof typeof BUSINESS_LAYERS;

/** The bridge for the one-call text path (PLANNER_FAST_TEXT): read and decide in one answer. */
export const ONE_CALL_LAYER: InstructionLayer = layer("one-call", oneCall);

export interface PlannerInstructions {
  readonly system: string;
  /** For ModelCall.promptVersion and logs: "planner:base@…+mercadito@…". */
  readonly version: string;
}

export function plannerInstructions(type: BusinessType = "mercadito"): PlannerInstructions {
  const layers = [BASE_LAYER, BUSINESS_LAYERS[type]];
  return {
    system: layers.map((l) => l.text.trim()).join("\n\n"),
    version: `planner:${layers.map((l) => l.version).join("+")}`,
  };
}

function layer(name: string, text: string): InstructionLayer {
  return { name, text, version: `${name}@${fnv1a(text)}` };
}

/** FNV-1a, 32 bits, as 8 hex digits: a short, stable name for a text. Not a security hash. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
