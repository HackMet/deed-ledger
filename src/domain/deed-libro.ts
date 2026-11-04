/**
 * The order's three lanes (K20c): what the agent said (AGENTE dijo), what the book paired (LIBRO empareja),
 * and what the world recorded (MUNDO registró). Pure: no I/O, no imports outside src/domain. The read model
 * (infrastructure/d1/libro-reads.ts) reads the rows; this module decides every pair's state.
 *
 * Each pair has one of four states. Silence is never red (C7): a reply with no delivery status yet is en
 * duda, and a claim with no fact is red only because the book has nothing to witness it. The pairing is the core's
 * (`pair` in src/deed-core); this module says what each witness means and keeps the book's words for the states.
 */
import { type PairState as CorePairState, pair } from "../deed-core";
import { type Centavos, type DecimalString, formatLempiras } from "./contract/numbers";
import type { Claim, OrderState } from "./contract/outcomes";
import type { ClaimCheck } from "./replies";
import { lineAmount } from "./money";

type StateClaim = Extract<Claim, { type: "order_state" }>;
type TotalClaim = Extract<Claim, { type: "order_total" }>;

export type PairState = "emparejado" | "sin_pareja" | "en_duda" | "bloqueado";

/** The book's word for each of the core's pair states: the screens, the demo and the entry file keep these. */
const WORD_OF: Record<CorePairState, PairState> = { paired: "emparejado", unpaired: "sin_pareja", in_doubt: "en_duda", blocked: "bloqueado" };

export type FactKind = "order_version" | "order_confirm" | "order_cancel" | "order_status" | "change_request" | "change_review";

/** One order fact as the book lane needs it. `version` is the order version the fact's body records; null when none. */
export interface LibroFact {
  readonly id: string;
  readonly kind: FactKind;
  readonly operationKey: string;
  readonly recordedAtMs: number;
  readonly version: number | null;
  readonly status: "preparing" | "ready" | "dispatched" | "delivered" | null;
  readonly resumeState: "confirmado" | "preparando" | null;
  readonly live: boolean;
  /** The witness in the store: the member or console session the fact's evidence names; null for a customer's fact. */
  readonly witness: { readonly kind: "member" | "session"; readonly refId: string } | null;
}

/** One line of a version, as recorded. `counted` is false for a line left out of the total. */
export interface RecordedLine {
  readonly version: number;
  readonly counted: boolean;
  readonly unitPrice: Centavos | null;
  readonly quantity: DecimalString | null;
}

export type ProviderStatus = "sent" | "delivered" | "read" | "played" | "failed";

/**
 * A reply that carries claims, with its delivery as the outbox recorded it. Each check holds when any one of its
 * alternatives holds (`anyOf`), so a check is paired as a whole.
 */
export interface LibroReply {
  readonly id: string;
  readonly atMs: number;
  readonly status: string;
  readonly providerStatus: ProviderStatus | null;
  readonly providerStatusAtS: number | null;
  readonly claims: readonly ClaimCheck[];
}

/** A refused check on this order: a gate, never a fact. */
export interface LibroRefusal {
  readonly id: string;
  readonly atMs: number;
  readonly reason: string;
  readonly decidingFactId: string | null;
  readonly operationKey: string | null;
}

export interface LibroInput {
  readonly orderId: string;
  readonly facts: readonly LibroFact[];
  readonly lines: readonly RecordedLine[];
  readonly replies: readonly LibroReply[];
  readonly refusals: readonly LibroRefusal[];
}

export interface LibroDetail {
  readonly term: string;
  readonly value: string;
}

export interface LibroCell {
  readonly kind: "claim" | "reply" | "fact" | "missing" | "balance" | "gate" | "tap" | "delivery";
  readonly text: string;
  readonly atMs: number | null;
  /** The fact the cell is about (a gate: the fact that decided it). Null when none. */
  readonly factId: string | null;
  /** Only IDs, codes and times: never message text, names or phone numbers. */
  readonly details: readonly LibroDetail[];
}

export interface LibroRow {
  readonly id: string;
  readonly atMs: number;
  /** Null for a fact nothing has said or witnessed yet: shown in the book lane without a pair. */
  readonly state: PairState | null;
  readonly agent: LibroCell | null;
  readonly book: LibroCell | null;
  readonly world: LibroCell | null;
}

export const PAIR_WORDS: Record<PairState, string> = {
  emparejado: "Emparejado",
  sin_pareja: "Sin pareja",
  en_duda: "En duda",
  bloqueado: "Bloqueado",
};

const STATE_WORDS: Record<OrderState, string> = {
  armando: "armando",
  por_confirmar: "por confirmar",
  confirmado: "confirmado",
  preparando: "preparando",
  listo: "listo",
  en_camino: "en camino",
  entregado: "entregado",
  cancelado: "cancelado",
};

const REASON_WORDS: Record<string, string> = {
  duplicate: "ya se hizo antes",
  stale_version: "versión vieja",
  not_allowed: "no te toca",
  not_found: "no existe",
  invalid_state: "el estado no lo permite",
  not_backed: "no está respaldado por los registros",
};

/** Outbox statuses under which the row ended and was not sent. `unknown_delivery` is not one of them: its outcome is unknown. */
const UNSENT = ["failed", "expired"];

/** The reply's words in the agent's lane, by its outbox status. Only `sent` says it went out. */
const REPLY_WORDS: Record<string, string> = {
  pending: "Respuesta en cola",
  sending: "Respuesta en cola",
  sent: "Respuesta enviada",
  waiting_window: "Respuesta en espera",
  failed: "Respuesta no enviada",
  expired: "Respuesta no enviada",
  unknown_delivery: "No se sabe si salió la respuesta",
};

/** The order state a fact records, or null when none does (a change, or a product mark). A confirm records the state it resumed into. */
export function stateOf(fact: LibroFact): OrderState | null {
  switch (fact.kind) {
    case "order_version":
      return "por_confirmar";
    case "order_confirm":
      return fact.resumeState ?? "confirmado";
    case "order_cancel":
      return "cancelado";
    case "order_status":
      return fact.status === "preparing" ? "preparando" : fact.status === "ready" ? "listo" : fact.status === "dispatched" ? "en_camino" : fact.status === "delivered" ? "entregado" : null;
    case "change_request":
    case "change_review":
      return null;
  }
}

/**
 * `order_state` claim ↔ the order's fact that records that state at that version. A live fact pairs; a closed
 * one, or none, does not. A fact of another version never pairs.
 */
export function pairOrderState(claim: { readonly version: number; readonly state: OrderState }, facts: readonly LibroFact[]): { readonly state: PairState; readonly fact: LibroFact | null } {
  const matching = facts.filter((fact) => stateOf(fact) === claim.state && fact.version === claim.version);
  // No fact for the claim: the book has nothing to witness it, which is a conflict (red), not silence.
  const witnesses: readonly (LibroFact | null)[] = matching.length > 0 ? matching : [null];
  const state = pair(claim, witnesses, (_claim, fact) => (fact !== null && fact.live ? "match" : "conflict"));
  return { state: WORD_OF[state], fact: matching.find((fact) => fact.live) ?? matching.at(-1) ?? null };
}

/** `order_total` claim ↔ the recorded total of its version: equal pairs; a recorded total that is unknown is in doubt. */
export function pairOrderTotal(said: Centavos, recorded: Centavos | null): PairState {
  const witnesses: readonly Centavos[] = recorded === null ? [] : [recorded];
  return WORD_OF[pair(said, witnesses, (claim, total) => (claim === total ? "match" : "conflict"))];
}

/** One thing the book knows about a reply's delivery: the provider's status for it, or the outbox's status for the row. */
type DeliverySignal = { readonly provider: ProviderStatus } | { readonly outbox: string };

/**
 * A reply ↔ its delivery. The provider's status is read first: delivered, read or played is green, even on a row
 * whose outcome is unknown; a provider `failed` is red. Without a provider failure, a row that ended unsent (failed,
 * expired) is red. Anything else is in doubt, including an unknown outcome (unknown_delivery) and no status yet:
 * silence is never red.
 */
export function pairDelivery(reply: Pick<LibroReply, "status" | "providerStatus">): PairState {
  const signals: DeliverySignal[] = [{ outbox: reply.status }, ...(reply.providerStatus === null ? [] : [{ provider: reply.providerStatus }])];
  return WORD_OF[
    pair(reply, signals, (_reply, signal) => {
      if ("provider" in signal) {
        if (signal.provider === "delivered" || signal.provider === "read" || signal.provider === "played") return "match";
        return signal.provider === "failed" ? "conflict" : "silent";
      }
      return UNSENT.includes(signal.outbox) ? "conflict" : "silent";
    })
  ];
}

/**
 * A version's total from its lines: the counted lines' price × quantity, summed. Null when a counted line's price or
 * quantity is unknown, or when no line is counted: no partial totals, never a zero. The delivery fee is not part of it.
 */
export function recordedTotalOf(lines: readonly RecordedLine[]): Centavos | null {
  const counted = lines.filter((line) => line.counted);
  if (counted.length === 0) return null;
  let sum = 0;
  for (const line of counted) {
    if (line.unitPrice === null || line.quantity === null) return null;
    const amount = lineAmount(line.unitPrice, line.quantity);
    if (amount === null) return null;
    sum += amount;
  }
  return Number.isSafeInteger(sum) ? sum : null;
}

const isOrderClaim = (claim: Claim, orderId: string): claim is StateClaim | TotalClaim =>
  (claim.type === "order_state" || claim.type === "order_total") && claim.orderId === orderId;

const KIND_WORDS: Record<FactKind, string> = {
  order_version: "Pedido",
  order_confirm: "Confirmado",
  order_cancel: "Cancelado",
  order_status: "Cambio de estado",
  change_request: "Cambio pedido",
  change_review: "Cambio revisado",
};

const factLabel = (fact: LibroFact): string => {
  const state = stateOf(fact);
  const what = fact.kind === "order_version" && fact.version !== null ? `${KIND_WORDS.order_version} v${fact.version}` : state === null ? KIND_WORDS[fact.kind] : STATE_WORDS[state];
  return `${what} · ${fact.live ? "Vivo" : "Cerrado"}`;
};

const factCell = (fact: LibroFact): LibroCell => ({
  kind: "fact",
  text: factLabel(fact),
  atMs: fact.recordedAtMs,
  factId: fact.id,
  details: [
    { term: "Hecho", value: fact.id },
    { term: "Operación", value: fact.operationKey },
    ...(fact.version === null ? [] : [{ term: "Versión", value: String(fact.version) }]),
  ],
});

const tapCell = (fact: LibroFact): LibroCell => ({
  kind: "tap",
  text: fact.witness?.kind === "session" ? "Sesión de consola" : "Personal tocó",
  atMs: fact.recordedAtMs,
  factId: fact.id,
  details: [
    { term: "Hecho", value: fact.id },
    { term: "Tocó", value: (fact.witness?.refId ?? "").slice(0, 8) },
  ],
});

/** One check as the agent said it: its alternatives in words ("confirmado o preparando"), its kind, version and reply. */
const claimCell = (alternatives: readonly (StateClaim | TotalClaim)[], reply: LibroReply): LibroCell => {
  const states = alternatives.filter((claim): claim is StateClaim => claim.type === "order_state");
  const first = alternatives[0]!;
  const text = states.length > 0 ? `Dijo: ${states.map((claim) => STATE_WORDS[claim.state]).join(" o ")}` : `Dijo: total ${formatLempiras(alternatives.find((claim) => claim.type === "order_total")!.total as Centavos)}`;
  return { kind: "claim", text, atMs: reply.atMs, factId: null, details: [{ term: "Afirmación", value: first.type }, { term: "Versión", value: String(first.version) }, { term: "Mensaje", value: reply.id }] };
};

const replyCell = (reply: LibroReply): LibroCell => ({
  kind: "reply",
  text: REPLY_WORDS[reply.status] ?? "Estado de respuesta desconocido",
  atMs: reply.atMs,
  factId: null,
  details: [{ term: "Mensaje", value: reply.id }, { term: "Estado", value: reply.status }],
});

const DELIVERY_WORDS: Record<ProviderStatus, string> = {
  sent: "Enviado, sin confirmación todavía",
  delivered: "Entregado al teléfono",
  read: "Leído",
  played: "Escuchado",
  failed: "Falló el envío",
};

/** The wording follows pairDelivery: a provider status says what happened; without one, the outbox status does. */
const deliveryText = (reply: LibroReply): string => {
  if (reply.providerStatus !== null && reply.providerStatus !== "sent") return DELIVERY_WORDS[reply.providerStatus];
  if (UNSENT.includes(reply.status)) return "No se envió";
  if (reply.status === "unknown_delivery") return "No se sabe si salió";
  return reply.providerStatus === "sent" ? DELIVERY_WORDS.sent : "Sin confirmación de entrega todavía";
};

const deliveryCell = (reply: LibroReply): LibroCell => {
  const text = deliveryText(reply);
  const at = reply.providerStatusAtS === null ? reply.atMs : reply.providerStatusAtS * 1000;
  return {
    kind: "delivery",
    text,
    atMs: at,
    factId: null,
    details: [
      { term: "Mensaje", value: reply.id },
      { term: "Envío", value: reply.providerStatus ?? reply.status },
    ],
  };
};

const balanceCell = (said: Centavos, recorded: Centavos | null, version: number): LibroCell => ({
  kind: "balance",
  text: recorded === null ? "Total sin calcular" : said === recorded ? `Total ${formatLempiras(recorded)}` : `dijo ${formatLempiras(said)} · registró ${formatLempiras(recorded)}`,
  atMs: null,
  factId: null,
  details: [{ term: "Versión", value: String(version) }],
});

const missingCell = (claim: { readonly version: number; readonly state: OrderState }): LibroCell => ({
  kind: "missing",
  text: `Dijo ${STATE_WORDS[claim.state]}, el libro no lo tiene`,
  atMs: null,
  factId: null,
  details: [{ term: "Versión", value: String(claim.version) }],
});

const gateCell = (refusal: LibroRefusal): LibroCell => ({
  kind: "gate",
  text: `Bloqueado: ${REASON_WORDS[refusal.reason] ?? "rechazado"}`,
  atMs: refusal.atMs,
  factId: refusal.decidingFactId,
  details: [
    { term: "Intento", value: refusal.id },
    { term: "Operación", value: refusal.operationKey ?? "—" },
    { term: "Decidido por", value: refusal.decidingFactId ?? "—" },
  ],
});

/**
 * The rows of the three-lane view, oldest first. Each reply with a claim about this order gives a delivery row
 * (the reply ↔ its delivery) and one row per claim (the claim ↔ the book). A fact with a witness in the store gives
 * a row with its tap, unless a claim row already shows it. Each refusal is a gate row.
 */
export function libroRows(input: LibroInput): LibroRow[] {
  const rows: Omit<LibroRow, "id">[] = [];
  const shown = new Set<string>();
  const sortedFacts = [...input.facts].sort((a, b) => a.recordedAtMs - b.recordedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const reply of input.replies) {
    // Each check keeps the alternatives about this order; a check with none about it is not this order's.
    const checks = reply.claims.map((check) => check.anyOf.filter((claim) => isOrderClaim(claim, input.orderId))).filter((alternatives) => alternatives.length > 0);
    if (checks.length === 0) continue;
    rows.push({ atMs: reply.atMs, state: pairDelivery(reply), agent: replyCell(reply), book: null, world: deliveryCell(reply) });
    for (const alternatives of checks) {
      const states = alternatives.filter((claim): claim is StateClaim => claim.type === "order_state");
      const totals = alternatives.filter((claim): claim is TotalClaim => claim.type === "order_total");
      if (states.length > 0) {
        // The check holds when any alternative does: a live fact for one of its states pairs the whole check.
        const found = states.map((claim) => ({ claim, ...pairOrderState(claim, input.facts) }));
        const hit = found.find((entry) => entry.state === "emparejado") ?? found.find((entry) => entry.fact !== null) ?? found[0]!;
        if (hit.fact !== null) shown.add(hit.fact.id);
        rows.push({
          atMs: reply.atMs,
          state: hit.state,
          agent: claimCell(states, reply),
          book: hit.fact === null ? missingCell(hit.claim) : factCell(hit.fact),
          world: hit.fact?.witness ? tapCell(hit.fact) : null,
        });
      }
      if (totals.length > 0) {
        const found = totals.map((claim) => {
          const recorded = recordedTotalOf(input.lines.filter((line) => line.version === claim.version));
          return { claim, recorded, state: pairOrderTotal(claim.total, recorded) };
        });
        const hit = found.find((entry) => entry.state === "emparejado") ?? found.find((entry) => entry.state === "sin_pareja") ?? found[0]!;
        rows.push({ atMs: reply.atMs, state: hit.state, agent: claimCell(totals, reply), book: balanceCell(hit.claim.total, hit.recorded, hit.claim.version), world: null });
      }
    }
  }

  for (const fact of sortedFacts) {
    if (shown.has(fact.id)) continue;
    rows.push({ atMs: fact.recordedAtMs, state: fact.witness === null ? null : "emparejado", agent: null, book: factCell(fact), world: fact.witness === null ? null : tapCell(fact) });
  }

  for (const refusal of input.refusals) rows.push({ atMs: refusal.atMs, state: "bloqueado", agent: null, book: gateCell(refusal), world: null });

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.atMs - b.row.atMs || a.index - b.index)
    .map(({ row }, index) => ({ id: `r${index + 1}`, ...row }));
}
