/**
 * The entry file a third party can re-judge (C3): the input as the host read it, and the verdict the host issued for
 * each row. `recheck` runs the host's judge on the input alone and compares. No model, no database, no clock.
 */
export const ENTRY_FILE_SCHEMA = 1;

/** A file that is not an entry file. Hosts throw it from `parse` for a malformed input. */
export class MalformedEntry extends Error {}

export interface RowVerdict<S extends string> {
  readonly rowKey: string;
  readonly state: S | null;
}

/** What a host supplies: its domain name, how to parse its input, and its judge over the parsed input. */
export interface EntryJudge<I, S extends string> {
  readonly domain: string;
  readonly states: readonly S[];
  readonly parse: (raw: unknown) => I;
  readonly rows: (input: I) => readonly RowVerdict<S>[];
}

export interface EntryFile<I, S extends string> {
  readonly schema: typeof ENTRY_FILE_SCHEMA;
  readonly domain: string;
  readonly input: I;
  readonly verdicts: readonly RowVerdict<S>[];
}

export interface Difference<S extends string> {
  readonly rowKey: string;
  readonly stored: S | null | "missing";
  readonly recomputed: S | null | "missing";
}

export type Recheck<S extends string> =
  | { readonly ok: true; readonly pairs: number; readonly same: number; readonly differ: readonly Difference<S>[] }
  | { readonly ok: false; readonly error: string };

/** The file for an input: the judge's verdicts, stored beside the input they came from. */
export function entryFile<I, S extends string>(judge: EntryJudge<I, S>, input: I): EntryFile<I, S> {
  return { schema: ENTRY_FILE_SCHEMA, domain: judge.domain, input, verdicts: judge.rows(input) };
}

/** Re-runs the judge on the file's input and compares every row with its stored verdict. A malformed file is an error. */
export function recheck<I, S extends string>(judge: EntryJudge<I, S>, file: unknown): Recheck<S> {
  const parsed = parseFile(judge, file);
  if (typeof parsed === "string") return { ok: false, error: parsed };
  const recomputed = new Map(judge.rows(parsed.input).map((verdict) => [verdict.rowKey, verdict.state]));
  const stored = new Map(parsed.verdicts.map((verdict) => [verdict.rowKey, verdict.state]));
  const keys = [...new Set([...recomputed.keys(), ...stored.keys()])];
  const differ: Difference<S>[] = [];
  for (const rowKey of keys) {
    // A null verdict is a real answer (a row nothing witnessed); only an absent key is "missing".
    const a = stored.has(rowKey) ? stored.get(rowKey)! : "missing";
    const b = recomputed.has(rowKey) ? recomputed.get(rowKey)! : "missing";
    if (a !== b) differ.push({ rowKey, stored: a, recomputed: b });
  }
  return { ok: true, pairs: keys.length, same: keys.length - differ.length, differ };
}

const fail = (where: string, what: string): never => {
  throw new MalformedEntry(`${where} ${what}`);
};

function parseFile<I, S extends string>(judge: EntryJudge<I, S>, value: unknown): EntryFile<I, S> | string {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail("entry", "must be an object");
    const file = value as Record<string, unknown>;
    if (file.schema !== ENTRY_FILE_SCHEMA) fail("schema", `must be ${ENTRY_FILE_SCHEMA} (unknown schema ${JSON.stringify(file.schema)})`);
    if (file.domain !== judge.domain) fail("domain", `must be ${JSON.stringify(judge.domain)} (got ${JSON.stringify(file.domain)})`);
    if (!Array.isArray(file.verdicts)) fail("verdicts", "must be an array");
    const verdicts = (file.verdicts as unknown[]).map((item, i): RowVerdict<S> => {
      if (typeof item !== "object" || item === null) fail(`verdicts[${i}]`, "must be an object");
      const row = item as Record<string, unknown>;
      if (typeof row.rowKey !== "string") fail(`verdicts[${i}].rowKey`, "must be a string");
      if (row.state !== null && !judge.states.includes(row.state as S)) fail(`verdicts[${i}].state`, `must be one of ${judge.states.join(", ")}`);
      return { rowKey: row.rowKey as string, state: row.state as S | null };
    });
    if (new Set(verdicts.map((verdict) => verdict.rowKey)).size !== verdicts.length) fail("verdicts", "repeat a rowKey");
    return { schema: ENTRY_FILE_SCHEMA, domain: judge.domain, input: judge.parse(file.input), verdicts };
  } catch (error) {
    if (error instanceof MalformedEntry) return `malformed entry: ${error.message}`;
    throw error;
  }
}
