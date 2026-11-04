/**
 * The store's evidence rules as the core's policy data: one entry per FactKind, so a kind without rules is a
 * compile error. The core compiles these rules to the post-guard SQL (src/deed-core/d1-store.ts).
 */
import type { EvidenceRule, Policy, Requirement } from "../deed-core/types";
import type { FactKind } from "./facts";

const inbound: Requirement = { kind: "inbound_message", min: 1 };
const member: Requirement = { kind: "member", min: 1, max: 1 };
const confirmation: Requirement = { kind: "confirmation", min: 1, max: 1 };
const mediaAsset: Requirement = { kind: "media_asset", min: 1 };

/** Receipts (and the rule the conditional kinds fall back to): one confirmation and an inbound message. */
const CONFIRMED_FROM_WHATSAPP: EvidenceRule = { require: [confirmation, inbound] };
/** A customer's own order facts: the customer's inbound message is the approval. */
const CUSTOMER_MESSAGE: EvidenceRule = { require: [inbound] };
/** A staff or owner tap on the console. */
const MEMBER_TAP: EvidenceRule = { require: [member] };

const kinds: Record<FactKind, { readonly evidence: readonly EvidenceRule[] }> = {
  // A console-approved receipt rests on the member and the photo; from WhatsApp, on the confirmation.
  receipt: { evidence: [{ when: { kind: "member", min: 1 }, require: [member, mediaAsset] }, CONFIRMED_FROM_WHATSAPP] },
  cancellation: { evidence: [{ when: { kind: "member", min: 1 }, require: [member] }, CONFIRMED_FROM_WHATSAPP] },
  // A price changed on the console (K6) rests on one member; a price resting on a draft's confirmation keeps the default.
  price: { evidence: [{ when: member, require: [] }, CONFIRMED_FROM_WHATSAPP] },
  order_version: { evidence: [CUSTOMER_MESSAGE] },
  order_confirm: { evidence: [CUSTOMER_MESSAGE] },
  order_cancel: { evidence: [CUSTOMER_MESSAGE] },
  order_status: { evidence: [MEMBER_TAP] },
  business_info: { evidence: [MEMBER_TAP] },
  change_request: { evidence: [CUSTOMER_MESSAGE] },
  change_review: { evidence: [MEMBER_TAP] },
  receipt_review: { evidence: [MEMBER_TAP] },
};

export const STORE_POLICY: Policy = { kinds };
