const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Splits a reply into parts of at most `maxChars` UTF-16 code units (never more characters than
 * that), at whitespace when possible. Without whitespace to cut at, it cuts between graphemes, so
 * a flag, a joined emoji or an accented letter stays whole. The exception, as a last resort: a
 * single grapheme longer than `maxChars` (a letter with hundreds of combining marks, say) fits in no
 * part, so it is cut by code units and does not stay whole; never inside a surrogate pair, though.
 * Blank text yields no parts.
 */
export function splitText(text: string, maxChars: number): string[] {
  if (maxChars < 2) throw new Error("maxChars must be at least 2");
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    const newline = rest.lastIndexOf("\n", maxChars);
    cut = Math.max(cut, newline);
    if (cut <= 0) cut = graphemeCut(rest, maxChars);
    const part = rest.slice(0, cut).trimEnd();
    if (part !== "") parts.push(part);
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== "") parts.push(rest);
  return parts;
}

/**
 * The last grapheme boundary at or before `maxChars`. When the first grapheme alone is longer than
 * `maxChars` there is none, and the last resort is a cut by code units: at `maxChars`, or one unit
 * earlier when that would split a surrogate pair. That cut breaks the grapheme.
 */
function graphemeCut(text: string, maxChars: number): number {
  let cut = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    const end = index + segment.length;
    if (end > maxChars) break;
    cut = end;
  }
  if (cut > 0) return cut;
  const code = text.charCodeAt(maxChars - 1);
  return code >= 0xd800 && code <= 0xdbff ? maxChars - 1 : maxChars;
}
