/**
 * The planner's wire format: the strict json_schema Muse Spark answers in (contract §2.2), before
 * code checks it (`validate.ts`). Strict-compatible: every key required, no extra keys, no root
 * anyOf, no null inside enums. The limits are also enforced by code: the provider's constrained
 * decoding isn't trusted. Only `import type` here, like `perception/wire.ts`.
 */
import type { JsonSchema } from "../perception/wire";

export const TURN_SCHEMA_NAME = "TurnProposal";
export const MAX_OPS = 40;
export const MAX_ASK_LINES = 12;
export const MAX_SAY_CHARS = 140;

const nstr = (description: string): JsonSchema => ({ type: ["string", "null"], description });

export const turnSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ops", "move", "ask", "say"],
  properties: {
    ops: {
      type: "array",
      maxItems: MAX_OPS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "line", "product", "quantity", "suggested_quantity"],
        properties: {
          op: { type: "string", enum: ["add", "pick", "set_quantity", "remove"] },
          line: { type: "string", description: "N label (a new item from this burst) or L label (an order line)" },
          product: nstr("P label offered for this line; null = leave unmatched"),
          quantity: nstr("decimal string exactly as the customer said it; null if not said"),
          suggested_quantity: nstr('only "1", only when nothing was said (decision 2A)'),
        },
      },
    },
    move: { type: "string", enum: ["ask", "readback", "answer_only", "handoff", "restate"] },
    ask: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "lines"],
      properties: {
        kind: {
          type: "string",
          enum: ["none", "quantities", "options", "unreadable", "fulfillment", "delivery_place", "what_to_order"],
        },
        lines: { type: "array", items: { type: "string" }, maxItems: MAX_ASK_LINES },
      },
    },
    say: {
      type: "string",
      maxLength: MAX_SAY_CHARS,
      description: "one short connecting sentence, no numbers, no prices, no promises; may be empty",
    },
  },
};
