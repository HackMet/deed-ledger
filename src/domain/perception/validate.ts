/**
 * From the model's JSON to the contract's observations: the schema first, then the contract's
 * rules. A response that doesn't fit the schema is refused whole. Inside a response that fits,
 * anything that breaks a rule is never repaired or guessed: the value becomes null, or the line
 * goes, and an issue takes its place so the engine asks.
 *
 * Rules: quantities are DecimalStrings and money is Centavos; every piece of evidence points
 * inside this burst (a quote found in the message, a box inside the photo); order-line refs and
 * catalog picks must be labels code supplied; a customer burst carries customer kinds only.
 */
import { isCentavos, isDecimalString, type Centavos, type DecimalString } from "../contract/numbers";
import {
  CONSOLE_KINDS,
  isCustomerKind,
  type Evidence,
  type ItemLine,
  type Observation,
  type ObservationIssue,
  type ObservationKind,
  type OrderChange,
  type PricedLine,
  type SupplierInvoice,
} from "../contract/observation";
import type { BurstMessage, ReadingContext } from "./burst";
import { resolveEvidence } from "./evidence";
import { schemaMismatch } from "./schema-check";
import {
  readingSchema,
  type Audience,
  type WireEdit,
  type WireEvidence,
  type WireInvoiceLine,
  type WireIssue,
  type WireLine,
  type WireObservation,
  type WirePricedLine,
  type WireReading,
} from "./wire";

/** The model's pick of a catalog label for a line. Code maps the label; the engine never sees it. */
export interface LinePick {
  readonly observation: number;
  /** Index into the observation's lines (edits, for order_change). */
  readonly line: number;
  readonly label: string;
}

export type ValidatedReading =
  | { readonly ok: true; readonly observations: readonly Observation[]; readonly picks: readonly LinePick[] }
  | { readonly ok: false; readonly mismatch: string };

export function validateReading(
  raw: unknown,
  audience: Audience,
  messages: readonly BurstMessage[],
  context: ReadingContext,
): ValidatedReading {
  const mismatch = schemaMismatch(readingSchema(audience), raw);
  if (mismatch) return { ok: false, mismatch };
  const wire = raw as WireReading;

  const reader = new ObservationReader(messages, context);
  const observations = wire.observations.map((observation, index) => {
    const read = reader.read(observation, index);
    return allowed(read.kind, audience) ? read : { kind: "other" as const, issues: [] };
  });
  return {
    ok: true,
    observations: observations.length ? observations : [{ kind: "other", issues: [] }],
    picks: reader.picks,
  };
}

const CONSOLE_KIND_SET: ReadonlySet<ObservationKind> = new Set(CONSOLE_KINDS);

function allowed(kind: ObservationKind, audience: Audience): boolean {
  return kind === "other" || (audience === "customer" ? isCustomerKind(kind) : CONSOLE_KIND_SET.has(kind));
}

/** A line that couldn't be placed: the engine asks instead of using it. */
const UNPLACED: ObservationIssue = { code: "illegible", line: null, evidence: null };

class ObservationReader {
  readonly picks: LinePick[] = [];
  private readonly orderRefs: ReadonlySet<string>;
  private readonly catalogLabels: ReadonlySet<string>;

  constructor(
    private readonly messages: readonly BurstMessage[],
    context: ReadingContext,
  ) {
    this.orderRefs = new Set(context.openOrder?.lines.map((line) => line.ref) ?? []);
    this.catalogLabels = new Set(context.catalogLabels.map((entry) => entry.label));
  }

  read(wire: WireObservation, index: number): Observation {
    switch (wire.kind) {
      case "customer_order": {
        const { lines, issues } = this.lines(wire.lines, wire.issues, index, (line) => this.itemLine(line));
        return { kind: "customer_order", lines, issues };
      }
      case "order_change":
        return this.orderChange(wire.edits, wire.issues, index);
      case "order_cancel":
        return { kind: "order_cancel", issues: this.issues(wire.issues, null) };
      case "fulfillment":
        return {
          kind: "fulfillment",
          mode: wire.mode === "unknown" ? null : wire.mode,
          pin: this.lastPin(),
          placeText: text(wire.place_text),
          sameAsBefore: wire.same_as_before,
          issues: this.issues(wire.issues, null),
        };
      case "payment_receipt":
        return {
          kind: "payment_receipt",
          amount: centavos(wire.amount_centavos),
          bank: text(wire.bank),
          dateText: text(wire.date_text),
          reference: text(wire.reference),
          evidence: {
            amount: this.evidence(wire.amount_evidence),
            bank: this.evidence(wire.bank_evidence),
            date: this.evidence(wire.date_evidence),
            reference: this.evidence(wire.reference_evidence),
          },
          issues: this.issues(wire.issues, null),
        };
      case "question":
        return {
          kind: "question",
          topic: wire.topic,
          products: wire.products.map((product) => product.trim()).filter((product) => product !== ""),
          issues: this.issues(wire.issues, null),
        };
      case "handoff":
        return { kind: "handoff", issues: this.issues(wire.issues, null) };
      case "stop":
        return { kind: "stop", deleteRequested: wire.delete_requested, issues: this.issues(wire.issues, null) };
      case "clarification":
      case "customer_name": {
        const evidence = this.evidence(wire.evidence);
        const said = (wire.kind === "clarification" ? wire.answer : wire.name).trim();
        if (!evidence || said === "") return { kind: "other", issues: [UNPLACED] };
        const issues = this.issues(wire.issues, null);
        return wire.kind === "clarification"
          ? { kind: "clarification", answer: said, evidence, issues }
          : { kind: "customer_name", name: said, evidence, issues };
      }
      case "other":
        return { kind: "other", issues: this.issues(wire.issues, null) };
      case "sale_report": {
        const { lines, issues } = this.lines(wire.lines, wire.issues, index, (line) => this.pricedLine(line));
        return { kind: "sale_report", lines, issues };
      }
      case "fiado_report": {
        const { lines, issues } = this.lines(wire.lines, wire.issues, index, (line) => this.pricedLine(line));
        return { kind: "fiado_report", customer: wire.customer.trim(), lines, issues };
      }
      case "setup_card": {
        const count = decimal(wire.count);
        const extra: ObservationIssue[] = count.bad ? [UNPLACED] : [];
        return {
          kind: "setup_card",
          name: wire.name.trim(),
          unit: text(wire.unit),
          count: count.value,
          price: centavos(wire.price_centavos),
          barcode: null,
          issues: [...this.issues(wire.issues, null), ...extra],
        };
      }
      case "supplier_invoice": {
        const { lines, issues } = this.lines(wire.lines, wire.issues, index, (line) => this.invoiceLine(line));
        return {
          kind: "supplier_invoice",
          supplier: text(wire.supplier),
          number: text(wire.number),
          dateText: text(wire.date_text),
          total: centavos(wire.total_centavos),
          lines,
          issues,
        };
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Lines

  /**
   * Maps lines in order. A line without valid evidence goes, with an UNPLACED issue in its place;
   * the model's issues are renumbered to the kept lines (null when their line went).
   */
  private lines<W extends WireLine, L extends ItemLine>(
    wires: readonly W[],
    wireIssues: readonly WireIssue[],
    observation: number,
    map: (line: W) => { readonly line: L; readonly bad: boolean } | null,
  ): { lines: L[]; issues: ObservationIssue[] } {
    const lines: L[] = [];
    const renumber: (number | null)[] = [];
    const added: ObservationIssue[] = [];
    wires.forEach((wire) => {
      const mapped = map(wire);
      if (!mapped) {
        renumber.push(null);
        added.push(UNPLACED);
        return;
      }
      const at = lines.length;
      renumber.push(at);
      lines.push(mapped.line);
      if (mapped.bad) added.push({ code: "illegible", line: at, evidence: mapped.line.evidence });
      this.pick(wire.pick, observation, at);
    });
    return { lines, issues: [...this.issues(wireIssues, renumber), ...added] };
  }

  private itemLine(wire: WireLine): { line: ItemLine; bad: boolean } | null {
    const evidence = this.evidence(wire.evidence);
    if (!evidence) return null;
    const quantity = decimal(wire.quantity);
    return {
      line: {
        text: wire.text.trim(),
        name: wire.name.trim(),
        quantity: quantity.value,
        unit: text(wire.unit),
        restrictedCategory: wire.restricted,
        evidence,
      },
      bad: quantity.bad,
    };
  }

  private pricedLine(wire: WirePricedLine): { line: PricedLine; bad: boolean } | null {
    const base = this.itemLine(wire);
    if (!base) return null;
    const price = money(wire.unit_price_centavos);
    return { line: { ...base.line, unitPrice: price.value }, bad: base.bad || price.bad };
  }

  private invoiceLine(wire: WireInvoiceLine): { line: SupplierInvoice["lines"][number]; bad: boolean } | null {
    const base = this.itemLine(wire);
    if (!base) return null;
    const received = decimal(wire.received_quantity);
    const cost = money(wire.unit_cost_centavos);
    return {
      line: { ...base.line, receivedQuantity: received.value, unitCost: cost.value },
      bad: base.bad || received.bad || cost.bad,
    };
  }

  private orderChange(wires: readonly WireEdit[], wireIssues: readonly WireIssue[], observation: number): Observation {
    const edits: OrderChange["edits"][number][] = [];
    const renumber: (number | null)[] = [];
    const added: ObservationIssue[] = [];
    for (const wire of wires) {
      const edit = this.edit(wire);
      if (!edit) {
        renumber.push(null);
        // An edit that can't be applied as said is a question, pointed at its words when we have them.
        const evidence = this.evidence(wire.evidence);
        added.push({ code: "illegible", line: null, evidence });
        continue;
      }
      const at = edits.length;
      renumber.push(at);
      edits.push(edit.edit);
      if (edit.bad && edit.edit.op === "add") added.push({ code: "illegible", line: at, evidence: edit.edit.line.evidence });
      if (edit.edit.op === "add") this.pick(wire.pick, observation, at);
    }
    return { kind: "order_change", edits, issues: [...this.issues(wireIssues, renumber), ...added] };
  }

  private edit(wire: WireEdit): { edit: OrderChange["edits"][number]; bad: boolean } | null {
    const evidence = this.evidence(wire.evidence);
    if (!evidence) return null;
    if (wire.op === "add") {
      if (wire.text === null || wire.name === null) return null;
      const quantity = decimal(wire.quantity);
      return {
        edit: {
          op: "add",
          line: {
            text: wire.text.trim(),
            name: wire.name.trim(),
            quantity: quantity.value,
            unit: text(wire.unit),
            restrictedCategory: wire.restricted,
            evidence,
          },
        },
        bad: quantity.bad,
      };
    }
    const target = { ref: wire.ref !== null && this.orderRefs.has(wire.ref) ? wire.ref : null, said: (wire.said ?? "").trim() };
    if (wire.op === "remove") return { edit: { op: "remove", target, evidence }, bad: false };
    // "que sean ocho o nueve": no affirmed figure, so no edit; the engine asks.
    if (!isDecimalString(wire.quantity)) return null;
    return { edit: { op: "set_quantity", target, quantity: wire.quantity, evidence }, bad: false };
  }

  private pick(label: string | null, observation: number, line: number): void {
    if (label !== null && this.catalogLabels.has(label)) this.picks.push({ observation, line, label });
  }

  // -------------------------------------------------------------------------------------------
  // Issues and evidence

  /** The model's issues, with `line` renumbered (null when `renumber` is null or the line went). */
  private issues(wires: readonly WireIssue[], renumber: readonly (number | null)[] | null): ObservationIssue[] {
    return wires.map((wire) => ({
      code: wire.code,
      line: wire.line === null || renumber === null ? null : (renumber[wire.line] ?? null),
      evidence: this.evidence(wire.evidence),
    }));
  }

  /** Null for no evidence and for invalid evidence alike: it's never repaired or guessed. */
  private evidence(wire: WireEvidence): Evidence | null {
    const resolved = resolveEvidence(wire, this.messages);
    return resolved === "invalid" ? null : resolved;
  }

  private lastPin(): { latitude: number; longitude: number } | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (message?.type === "location") return { latitude: message.latitude, longitude: message.longitude };
    }
    return null;
  }
}

function text(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** A quantity as a DecimalString, or null; `bad` when the model wrote something that isn't one. */
function decimal(value: string | null): { value: DecimalString | null; bad: boolean } {
  if (value === null) return { value: null, bad: false };
  const trimmed = value.trim();
  return isDecimalString(trimmed) ? { value: trimmed, bad: false } : { value: null, bad: true };
}

function money(value: number | null): { value: Centavos | null; bad: boolean } {
  if (value === null) return { value: null, bad: false };
  return isCentavos(value) ? { value, bad: false } : { value: null, bad: true };
}

function centavos(value: number | null): Centavos | null {
  return money(value).value;
}
