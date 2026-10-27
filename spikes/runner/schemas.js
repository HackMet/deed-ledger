'use strict';
// Frozen E1 schema (spikes/contracts.md v1). Every key required,
// additionalProperties false. Nullable ["type","null"] verified live on first call.

const E1_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['supplier_receipt', 'sale', 'expense', 'fiado_credit', 'fiado_payment', 'adjustment', 'inquiry', 'correction', 'cancel'],
    },
    product_text: { type: ['string', 'null'] },
    quantity_text: { type: ['string', 'null'] },
    quantity_value: { type: ['number', 'null'] },
    unit_text: { type: ['string', 'null'] },
    amount_minor: { type: ['integer', 'null'] },
    amount_basis: { type: ['string', 'null'] },
    counterparty_text: { type: ['string', 'null'] },
    targets_open_draft: { type: 'boolean' },
    missing: { type: 'array', items: { type: 'string' } },
    ambiguities: { type: 'array', items: { type: 'string' } },
    owner_reply: { type: 'string' },
  },
  required: ['kind', 'product_text', 'quantity_text', 'quantity_value', 'unit_text', 'amount_minor', 'amount_basis', 'counterparty_text', 'targets_open_draft', 'missing', 'ambiguities', 'owner_reply'],
  additionalProperties: false,
};

// E3 final answer shape (runner convention; the frozen contract fixes the
// tools, the refusal rule, and "explains + cites record IDs").
const E3_ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['answer', 'refuse'] },
    answer_text: { type: 'string' },
    cited_record_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'answer_text', 'cited_record_ids'],
  additionalProperties: false,
};

// E2 extraction line (frozen shape; Lane B owns E2 — kept here so the
// ModelProvider interface matches the frozen TS; untested by Lane A).
const E2_LINE_SCHEMA = {
  type: 'object',
  properties: {
    source_text: { type: 'string' },
    description: { type: ['string', 'null'] },
    invoice_quantity: { type: ['string', 'null'] },
    invoice_unit: { type: ['string', 'null'] },
    units_per_pack: { type: ['string', 'null'] },
    unit_cost_minor: { type: ['integer', 'null'] },
    currency: { type: ['string', 'null'] },
    ambiguities: { type: 'array', items: { type: 'string' } },
  },
  required: ['source_text', 'description', 'invoice_quantity', 'invoice_unit', 'units_per_pack', 'unit_cost_minor', 'currency', 'ambiguities'],
  additionalProperties: false,
};

module.exports = { E1_SCHEMA, E3_ANSWER_SCHEMA, E2_LINE_SCHEMA };
