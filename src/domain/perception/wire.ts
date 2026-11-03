/**
 * The reading's wire format: the JSON Muse Spark is constrained to (strict json_schema), before
 * code checks it and maps it to the contract's observations. Only `import type` here, so a plain
 * Node script can load this file to send the exact same schema.
 *
 * Differences from the contract, on purpose:
 * - Evidence is a message number plus the exact words (`quote`) or a photo box. Code finds the
 *   span itself and decides the source from the message's type; models count characters badly.
 * - Every evidence slot is present; `message: null` means none.
 * - Lines carry `pick`: one of the catalog labels code supplied ("P3"), or null. Never an ID.
 * - order_change edits are flat (one shape for add, remove and set_quantity).
 * - Strict mode needs every key required and no `null` inside enums, so "unknown" stands in for
 *   a null fulfillment mode.
 */
import type { ObservationIssue } from "../contract/observation";

export type WireEvidence = {
  readonly message: number | null;
  readonly quote: string | null;
  readonly box: readonly number[] | null;
};

export type WireIssue = {
  readonly code: ObservationIssue["code"];
  readonly line: number | null;
  readonly evidence: WireEvidence;
};

export type WireLine = {
  readonly text: string;
  readonly name: string;
  readonly quantity: string | null;
  readonly unit: string | null;
  readonly restricted: boolean;
  readonly pick: string | null;
  readonly evidence: WireEvidence;
};

export type WirePricedLine = WireLine & { readonly unit_price_centavos: number | null };

export type WireInvoiceLine = WireLine & {
  readonly received_quantity: string | null;
  readonly unit_cost_centavos: number | null;
};

export type WireEdit = {
  readonly op: "add" | "remove" | "set_quantity";
  readonly ref: string | null;
  readonly said: string | null;
  readonly text: string | null;
  readonly name: string | null;
  readonly quantity: string | null;
  readonly unit: string | null;
  readonly restricted: boolean;
  readonly pick: string | null;
  readonly evidence: WireEvidence;
};

type WithIssues = { readonly issues: readonly WireIssue[] };

export type WireObservation = WithIssues &
  (
    | { readonly kind: "customer_order"; readonly lines: readonly WireLine[] }
    | { readonly kind: "order_change"; readonly edits: readonly WireEdit[] }
    | { readonly kind: "order_cancel" }
    | {
        readonly kind: "fulfillment";
        readonly mode: "pickup" | "delivery" | "unknown";
        readonly place_text: string | null;
        readonly same_as_before: boolean;
      }
    | {
        readonly kind: "payment_receipt";
        readonly amount_centavos: number | null;
        readonly bank: string | null;
        readonly date_text: string | null;
        readonly reference: string | null;
        readonly amount_evidence: WireEvidence;
        readonly bank_evidence: WireEvidence;
        readonly date_evidence: WireEvidence;
        readonly reference_evidence: WireEvidence;
      }
    | {
        readonly kind: "question";
        readonly topic: "order_status" | "price" | "availability" | "balance" | "store_hours" | "other";
        readonly products: readonly string[];
      }
    | { readonly kind: "handoff" }
    | { readonly kind: "stop"; readonly delete_requested: boolean }
    | {
        readonly kind: "clarification";
        readonly answer: string;
        readonly pick: string | null;
        readonly quantity: string | null;
        readonly evidence: WireEvidence;
      }
    | { readonly kind: "customer_name"; readonly name: string; readonly evidence: WireEvidence }
    | { readonly kind: "other" }
    | { readonly kind: "sale_report"; readonly lines: readonly WirePricedLine[] }
    | { readonly kind: "fiado_report"; readonly customer: string; readonly lines: readonly WirePricedLine[] }
    | {
        readonly kind: "setup_card";
        readonly name: string;
        readonly unit: string | null;
        readonly count: string | null;
        readonly price_centavos: number | null;
      }
    | {
        readonly kind: "supplier_invoice";
        readonly supplier: string | null;
        readonly number: string | null;
        readonly date_text: string | null;
        readonly total_centavos: number | null;
        readonly lines: readonly WireInvoiceLine[];
      }
  );

export type WireReading = { readonly observations: readonly WireObservation[] };

/** Who sent the burst. A customer's schema can't even express staff kinds. */
export type Audience = "customer" | "console";

// ---------------------------------------------------------------------------------------------
// JSON Schema (the subset strict mode takes: every key required, no extra keys, no root anyOf)

export type JsonSchema = { readonly [key: string]: unknown };

const str = { type: "string" } as const;
const nstr = { type: ["string", "null"] } as const;
const nint = { type: ["integer", "null"] } as const;
const bool = { type: "boolean" } as const;

function object(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

const evidence = object({
  message: nint,
  quote: nstr,
  box: { type: ["array", "null"], items: { type: "number" } },
});

const issue = object({
  code: { type: "string", enum: ["illegible", "ambiguous_size", "ambiguous_product", "embedded_instructions"] },
  line: nint,
  evidence,
});

const lineProps = {
  text: str,
  name: str,
  quantity: nstr,
  unit: nstr,
  restricted: bool,
  pick: nstr,
  evidence,
};
const line = object(lineProps);
const pricedLine = object({ ...lineProps, unit_price_centavos: nint });
const invoiceLine = object({ ...lineProps, received_quantity: nstr, unit_cost_centavos: nint });

function variant(kind: string, properties: Record<string, JsonSchema> = {}): JsonSchema {
  return object({ kind: { type: "string", enum: [kind] }, ...properties, issues: { type: "array", items: issue } });
}

const CUSTOMER_VARIANTS: readonly JsonSchema[] = [
  variant("customer_order", { lines: { type: "array", items: line } }),
  variant("order_change", {
    edits: {
      type: "array",
      items: object({
        op: { type: "string", enum: ["add", "remove", "set_quantity"] },
        ref: nstr,
        said: nstr,
        text: nstr,
        name: nstr,
        quantity: nstr,
        unit: nstr,
        restricted: bool,
        pick: nstr,
        evidence,
      }),
    },
  }),
  variant("order_cancel"),
  variant("fulfillment", {
    mode: { type: "string", enum: ["pickup", "delivery", "unknown"] },
    place_text: nstr,
    same_as_before: bool,
  }),
  variant("payment_receipt", {
    amount_centavos: nint,
    bank: nstr,
    date_text: nstr,
    reference: nstr,
    amount_evidence: evidence,
    bank_evidence: evidence,
    date_evidence: evidence,
    reference_evidence: evidence,
  }),
  variant("question", {
    topic: { type: "string", enum: ["order_status", "price", "availability", "balance", "store_hours", "other"] },
    products: { type: "array", items: str },
  }),
  variant("handoff"),
  variant("stop", { delete_requested: bool }),
  variant("clarification", { answer: str, pick: nstr, quantity: nstr, evidence }),
  variant("customer_name", { name: str, evidence }),
  variant("other"),
];

const CONSOLE_VARIANTS: readonly JsonSchema[] = [
  variant("sale_report", { lines: { type: "array", items: pricedLine } }),
  variant("fiado_report", { customer: str, lines: { type: "array", items: pricedLine } }),
  variant("setup_card", { name: str, unit: nstr, count: nstr, price_centavos: nint }),
  variant("supplier_invoice", {
    supplier: nstr,
    number: nstr,
    date_text: nstr,
    total_centavos: nint,
    lines: { type: "array", items: invoiceLine },
  }),
  variant("other"),
];

/** One call per burst: the observations are a list of a union nested inside the root object. */
export function readingSchema(audience: Audience): JsonSchema {
  const variants = audience === "customer" ? CUSTOMER_VARIANTS : CONSOLE_VARIANTS;
  return object({ observations: { type: "array", items: { anyOf: variants } } });
}

export const READING_SCHEMA_NAME = "BurstReading";
