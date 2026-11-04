/**
 * The entry a third party can re-judge (C3). An entry is the order's three-lane input as the book read it, and the
 * verdict the book issued for each row. `recheckEntry` runs libroRows on the input alone and compares: no model, no
 * database, no secret takes part, so the same entry gives the same verdicts anywhere. Pure: no I/O.
 * The file and the comparison are the core's (`entryFile` and `recheck` in src/deed-core); this module names the
 * book's domain, its states, and checks the input's shape before the judge runs.
 */
import { type EntryFile, type EntryJudge, MalformedEntry, type Recheck as CoreRecheck, entryFile, recheck } from "../deed-core";
import { type LibroFact, type LibroInput, type LibroRefusal, type LibroReply, type PairState, type RecordedLine, libroRows } from "./deed-libro";
import type { Centavos } from "./contract/numbers";
import type { Claim, OrderState } from "./contract/outcomes";
import type { ClaimCheck } from "./replies";

export const ENTRY_SCHEMA = 1;
export const ENTRY_DOMAIN = "deed-libro";

export type DeedEntry = EntryFile<LibroInput, PairState>;

export type Recheck = CoreRecheck<PairState>;

// --- Shape: every boundary is checked before the judge runs (schema first, then the rules) ------

const PAIR_STATES = ["emparejado", "sin_pareja", "en_duda", "bloqueado"] as const;
const FACT_KINDS = ["order_version", "order_confirm", "order_cancel", "order_status", "change_request", "change_review"] as const;
const FACT_STATUSES = ["preparing", "ready", "dispatched", "delivered"] as const;
const RESUME_STATES = ["confirmado", "preparando"] as const;
const WITNESS_KINDS = ["member", "session"] as const;
const PROVIDER_STATUSES = ["sent", "delivered", "read", "played", "failed"] as const;
const ORDER_STATES = ["armando", "por_confirmar", "confirmado", "preparando", "listo", "en_camino", "entregado", "cancelado"] as const satisfies readonly OrderState[];
const DECIMAL = /^\d+(\.\d+)?$/;

const fail = (where: string, what: string): never => {
  throw new MalformedEntry(`${where} ${what}`);
};
const obj = (value: unknown, where: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(where, "must be an object");
  return value as Record<string, unknown>;
};
const arr = (value: unknown, where: string): unknown[] => {
  if (!Array.isArray(value)) fail(where, "must be an array");
  return value as unknown[];
};
const str = (value: unknown, where: string): string => {
  if (typeof value !== "string") fail(where, "must be a string");
  return value as string;
};
const int = (value: unknown, where: string): number => {
  if (!Number.isSafeInteger(value)) fail(where, "must be an integer");
  return value as number;
};
const bool = (value: unknown, where: string): boolean => {
  if (typeof value !== "boolean") fail(where, "must be true or false");
  return value as boolean;
};
const one = <T extends string>(list: readonly T[], value: unknown, where: string): T => {
  if (typeof value !== "string" || !list.includes(value as T)) fail(where, `must be one of ${list.join(", ")}`);
  return value as T;
};
/** A field that is null or checked by `check`; an absent field (undefined) is never null, so it is refused. */
const orNull = <T>(value: unknown, check: (value: unknown, where: string) => T, where: string): T | null => (value === null ? null : check(value, where));

function parseFact(value: unknown, where: string): LibroFact {
  const fact = obj(value, where);
  return {
    id: str(fact.id, `${where}.id`),
    kind: one(FACT_KINDS, fact.kind, `${where}.kind`),
    operationKey: str(fact.operationKey, `${where}.operationKey`),
    recordedAtMs: int(fact.recordedAtMs, `${where}.recordedAtMs`),
    version: orNull(fact.version, int, `${where}.version`),
    status: orNull(fact.status, (v, w) => one(FACT_STATUSES, v, w), `${where}.status`),
    resumeState: orNull(fact.resumeState, (v, w) => one(RESUME_STATES, v, w), `${where}.resumeState`),
    live: bool(fact.live, `${where}.live`),
    witness: orNull(
      fact.witness,
      (v, w) => {
        const witness = obj(v, w);
        return { kind: one(WITNESS_KINDS, witness.kind, `${w}.kind`), refId: str(witness.refId, `${w}.refId`) };
      },
      `${where}.witness`,
    ),
  };
}

function parseLine(value: unknown, where: string): RecordedLine {
  const line = obj(value, where);
  return {
    version: int(line.version, `${where}.version`),
    counted: bool(line.counted, `${where}.counted`),
    unitPrice: orNull(line.unitPrice, int, `${where}.unitPrice`) as Centavos | null,
    quantity: orNull(line.quantity, (v, w) => (DECIMAL.test(str(v, w)) ? (v as string) : fail(w, "must be a decimal string")), `${where}.quantity`),
    ...(line.markedNoHay === undefined ? {} : { markedNoHay: bool(line.markedNoHay, `${where}.markedNoHay`) }),
  };
}

function parseClaim(value: unknown, where: string): Claim {
  const claim = obj(value, where);
  const type = str(claim.type, `${where}.type`);
  if (type === "order_state") {
    return { type, orderId: str(claim.orderId, `${where}.orderId`), version: int(claim.version, `${where}.version`), state: one(ORDER_STATES, claim.state, `${where}.state`) };
  }
  if (type === "order_total") {
    return { type, orderId: str(claim.orderId, `${where}.orderId`), version: int(claim.version, `${where}.version`), total: int(claim.total, `${where}.total`) as Centavos };
  }
  // Other claims are not about the order's book, so libroRows never reads them; they are kept as the outbox stored them.
  return claim as unknown as Claim;
}

function parseReply(value: unknown, where: string): LibroReply {
  const reply = obj(value, where);
  return {
    id: str(reply.id, `${where}.id`),
    atMs: int(reply.atMs, `${where}.atMs`),
    status: str(reply.status, `${where}.status`),
    providerStatus: orNull(reply.providerStatus, (v, w) => one(PROVIDER_STATUSES, v, w), `${where}.providerStatus`),
    providerStatusAtS: orNull(reply.providerStatusAtS, int, `${where}.providerStatusAtS`),
    claims: arr(reply.claims, `${where}.claims`).map((check, i): ClaimCheck => {
      const anyOf = arr(obj(check, `${where}.claims[${i}]`).anyOf, `${where}.claims[${i}].anyOf`);
      return { anyOf: anyOf.map((claim, j) => parseClaim(claim, `${where}.claims[${i}].anyOf[${j}]`)) };
    }),
  };
}

function parseRefusal(value: unknown, where: string): LibroRefusal {
  const refusal = obj(value, where);
  return {
    id: str(refusal.id, `${where}.id`),
    atMs: int(refusal.atMs, `${where}.atMs`),
    reason: str(refusal.reason, `${where}.reason`),
    decidingFactId: orNull(refusal.decidingFactId, str, `${where}.decidingFactId`),
    operationKey: orNull(refusal.operationKey, str, `${where}.operationKey`),
  };
}

function parseInput(value: unknown): LibroInput {
  const input = obj(value, "input");
  return {
    orderId: str(input.orderId, "input.orderId"),
    facts: arr(input.facts, "input.facts").map((fact, i) => parseFact(fact, `input.facts[${i}]`)),
    lines: arr(input.lines, "input.lines").map((line, i) => parseLine(line, `input.lines[${i}]`)),
    replies: arr(input.replies, "input.replies").map((reply, i) => parseReply(reply, `input.replies[${i}]`)),
    refusals: arr(input.refusals, "input.refusals").map((refusal, i) => parseRefusal(refusal, `input.refusals[${i}]`)),
  };
}

/** The verdict of each row of the input, keyed by the row's id (r1, r2, …): deterministic for the same input. */
export function verdictsOf(input: LibroInput): { readonly rowKey: string; readonly state: PairState | null }[] {
  return libroRows(input).map((row) => ({ rowKey: row.id, state: row.state }));
}

/** The book's judge for the core: its domain, its states, how to read the input, and the rows it issues. */
const bookJudge: EntryJudge<LibroInput, PairState> = {
  domain: ENTRY_DOMAIN,
  states: PAIR_STATES,
  parse: parseInput,
  rows: verdictsOf,
};

export function entryOf(input: LibroInput): DeedEntry {
  return entryFile(bookJudge, input);
}

/** Re-runs the judge on the entry's input and compares every row with its stored verdict. A malformed entry is an error. */
export function recheckEntry(entry: unknown): Recheck {
  return recheck(bookJudge, entry);
}
