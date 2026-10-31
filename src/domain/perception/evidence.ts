/**
 * Turns the model's evidence (a message number plus the exact words, or a photo box) into the
 * contract's Evidence, checked against the burst. Code finds the span; a quote that isn't in the
 * message, a box outside the photo or a message outside the burst is "invalid", never repaired.
 */
import type { Evidence } from "../contract/observation";
import type { BurstMessage } from "./burst";
import type { WireEvidence } from "./wire";

export type ResolvedEvidence = Evidence | null | "invalid";

export function resolveEvidence(wire: WireEvidence, messages: readonly BurstMessage[]): ResolvedEvidence {
  if (wire.message === null) return wire.quote === null && wire.box === null ? null : "invalid";
  const index = wire.message;
  const message = Number.isInteger(index) && index >= 0 ? messages[index] : undefined;
  if (!message) return "invalid";
  switch (message.type) {
    case "text":
    case "transcript": {
      if (wire.quote === null) return "invalid";
      const span = findQuote(message.text, wire.quote);
      return span ? { source: message.type, message: index, start: span.start, end: span.end } : "invalid";
    }
    case "image": {
      const box = wire.box;
      if (!isBox(box)) return "invalid";
      return { source: "image", message: index, box: [box[0], box[1], box[2], box[3]] };
    }
    case "location":
      return "invalid";
  }
}

function isBox(box: readonly number[] | null): box is readonly [number, number, number, number] {
  if (!box || box.length !== 4) return false;
  if (!box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return false;
  const [left, top, right, bottom] = box as [number, number, number, number];
  return left < right && top < bottom;
}

/**
 * The span of `quote` in `text`, in UTF-16 code units. Exact first; then ignoring case and accents
 * (models sometimes drop a tilde), mapped back to the original text. First occurrence wins.
 */
export function findQuote(text: string, quote: string): { start: number; end: number } | null {
  const wanted = quote.trim();
  if (wanted === "") return null;
  const exact = text.indexOf(wanted);
  if (exact >= 0) return { start: exact, end: exact + wanted.length };

  const folded = fold(text);
  const target = fold(wanted).text;
  if (target === "") return null;
  const at = folded.text.indexOf(target);
  if (at < 0) return null;
  const start = folded.starts[at];
  const end = folded.ends[at + target.length - 1];
  return start === undefined || end === undefined ? null : { start, end };
}

/** Lowercased, accents removed, with each folded unit's start and end in the original text. */
function fold(text: string): { text: string; starts: number[]; ends: number[] } {
  let out = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    const folded = char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < folded.length; k++) {
      starts.push(offset);
      ends.push(offset + char.length);
    }
    out += folded;
    offset += char.length;
  }
  return { text: out, starts, ends };
}
