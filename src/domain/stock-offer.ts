/**
 * What a store's verified stock says about one order line. Exact: thousandths, never a float. A
 * balance comes only from the store's records, and absent is unknown, never zero (non-negotiable 2).
 */
import { quantityFrom } from "./answer-words";
import { type DecimalString, type Thousandths, toThousandths } from "./contract/numbers";
import type { OrderLineView } from "./contract/outcomes";
import { foldShortText } from "./small-talk";

/**
 * `unknown`: no record, an unmatched or restricted line, or an amount there's nothing to compare with.
 * `short`: some left, under what the customer asked for: they decide, the line stays as they said it.
 */
export type StockVerdict = "unknown" | "enough" | "sold_out" | "short";

export function stockVerdict(line: Pick<OrderLineView, "productId" | "quantity" | "restricted">, balance: Thousandths | null): StockVerdict {
  if (line.productId === null || line.restricted || balance === null) return "unknown";
  if (balance === 0) return "sold_out";
  const asked = line.quantity === null ? null : toThousandths(line.quantity);
  if (asked === null) return "unknown";
  return balance >= asked ? "enough" : "short";
}

/** What "¿Te mando 2 o lo quitamos?" was answered: an amount to take, or leave the line out. */
export type StockAnswer = { readonly take: DecimalString } | "remove";

const LEAVE_OUT = /\b(?:quit\w*|sac\w*|borr\w*|elimin\w*|ningun\w*|no (?:lo |la |los |las )?quiero)\b/u;
const KEEP_IT = /\bno (?:me |lo |la |los |las )*(?:quit|sac|borr|elimin)/u;
const YES_TO_OFFER = /\b(?:si|dale|va|ok|okay|listo|bueno|claro|esas?|esos?|mand\w*|pon\w*|de acuerdo|esta bien)\b/u;

/**
 * The customer's answer to the stock question, as perception read it. The amount offered is `inStock`;
 * a yes takes that much, a number takes that number, if the records cover it. Null when it can't be read
 * (or asks for more than there is): the question stays, never a guess. Only clear words count.
 */
export function stockAnswer(answer: string, quantity: DecimalString | null, inStock: DecimalString): StockAnswer | null {
  const said = foldShortText(answer);
  if (LEAVE_OUT.test(said) && !KEEP_IT.test(said)) return "remove";
  // After a "no", only the amount perception read counts: "no, esas no" takes nothing.
  const refusing = /\bno\b/u.test(said);
  const amount = quantity ?? (refusing ? null : quantityFrom(answer));
  if (amount === null) return !refusing && YES_TO_OFFER.test(said) ? { take: inStock } : null;
  const asked = toThousandths(amount);
  const left = toThousandths(inStock);
  return asked === null || left === null || asked === 0 || asked > left ? null : { take: amount };
}
