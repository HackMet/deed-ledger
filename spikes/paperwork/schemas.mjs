// Lane B: frozen-shape schemas + prompt versions. Prompts: e2-prompt-v1, e5-prompt-v1.

// E2 extraction line: frozen shape (contracts.md). Wrapped in {lines[]} for the call.
export const E2_LINE_PROPS = {
  source_text: { type: "string" },
  description: { type: ["string", "null"] },
  invoice_quantity: { type: ["string", "null"] },
  invoice_unit: { type: ["string", "null"] },
  units_per_pack: { type: ["string", "null"] },
  unit_cost_minor: { type: ["integer", "null"] },
  currency: { type: ["string", "null"] },
  ambiguities: { type: "array", items: { type: "string" } },
};
export const E2_LINE_REQUIRED = ["source_text", "description", "invoice_quantity", "invoice_unit", "units_per_pack", "unit_cost_minor", "currency", "ambiguities"];
export const E2_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: { type: "object", properties: E2_LINE_PROPS, required: E2_LINE_REQUIRED, additionalProperties: false },
    },
  },
  required: ["lines"],
  additionalProperties: false,
};

export const E2_PROMPT_V1 = `You transcribe store paperwork (invoices, notebook pages, price lists) into extraction lines.
Rules: report ONLY what the paper shows. invoice_quantity is the exact decimal string as printed, or null when absent or unreadable. units_per_pack only when printed on the paper, else null. unit_cost_minor is the printed unit price in centavos (L45.00 -> 4500), or null when no price is printed; never 0 for a missing price. currency is the printed currency code (HNL for L), or null when none is shown. Never compute totals, never reconstruct covered or stained values, never guess an unreadable digit: set the field to null and name the problem in ambiguities. Totals rows are not lines. Handwritten notes that contradict print stay in ambiguities; keep the printed value. source_text is the exact line text as read. description is the item description as printed (without pack suffixes that belong in units_per_pack).`;

// E5: disambiguation output (day-one shape; frozen contract defines E5 via E1 conventions + candidates).
export const E5_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["match", "ask", "ask_create"] },
    product_id: { type: ["string", "null"] },
    candidates: { type: "array", items: { type: "string" } },
    owner_reply: { type: "string" },
    ambiguities: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "product_id", "candidates", "owner_reply", "ambiguities"],
  additionalProperties: false,
};

export const E2_PROMPT_V2 = E2_PROMPT_V1 + `
units_per_pack is digits only (12, never "x12"): the count of units inside one pack, and ONLY when the paper prints an explicit pack count such as "x12" next to a quantity. A size inside the item name (10 lb, 1L, 2 lb) or a number that is part of the product name (Caja mixta 12) is never units_per_pack; keep the full item name with its size in description. When a line's meaning needs context the paper does not give (mixed-box contents, promo or free units, unreadable values), say so in ambiguities; do not leave ambiguities empty on such lines.`;

export const E5_PROMPT_V1 = `You match a store owner's short Spanish message to products in THEIR store's catalog partition only. You never invent products and never use IDs from another store.
- If the message names exactly one catalog product (by name or alias), verdict is "match": set product_id, leave candidates empty, owner_reply is a short Honduran Spanish confirmation echo (no question mark).
- If it could be two or more catalog products, verdict is "ask": list EVERY plausible product_id in candidates, product_id null, owner_reply asks exactly one specific question (ends with "?").
- If it names no catalog product, verdict is "ask_create": candidates empty, product_id null, owner_reply asks one specific question offering to register it as a new product (ends with "?").
- A follow-up correction ("no, la de dos litros") resolves the stated open ambiguity; do not re-ask.
owner_reply is one short message in Honduran Spanish. Never show product IDs or confidence to the owner; IDs live only in product_id/candidates.`;

export const E5_PROMPT_V2 = E5_PROMPT_V1 + `
Whenever the verdict is "ask" or "ask_create", also name the alternatives or the unknown in ambiguities (which products it could be, or that the named product is not in this store's catalog); never leave ambiguities empty when asking.`;
