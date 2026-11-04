/**
 * Change requests (K12): after confirming, a customer's change waits for the owner or staff, who
 * approve or decline it with a reason. Pure rules: keys, the reason, the window and the diff.
 */
import type { LineDiff, OrderLineView, OrderState } from "./contract/outcomes";
import { wordsWithoutQuantity } from "./orders";

/** A customer's change is a request in these states; before, it is a new version to reconfirm (D-43). */
export const CHANGE_WINDOW: readonly OrderState[] = ["confirmado", "preparando"];

export const REASON_MAX = 200;

/** The request's key (D-44): one per order per inbound job, so a retried job saves once. */
export const changeRequestKey = (orderId: string, jobId: string): string => `chg:${orderId}:${jobId}`;

/** The review's key (D-44): one answer per request, so a second tap is a duplicate whatever it says. */
export const reviewKey = (changeRequestId: string): string => `rev:${changeRequestId}`;

/** The reason as stored: trimmed, 1 to 200 characters. Null when it isn't one. Never interpreted. */
export function reviewReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length >= 1 && [...trimmed].length <= REASON_MAX ? trimmed : null;
}

/** A line is the same line when it names the same product, or, unmatched, the same words, whatever quantity they start with. */
const identity = (line: OrderLineView): string =>
  line.productId !== null ? `p:${line.productId}` : `t:${wordsWithoutQuantity(line.text.trim()).toLowerCase()}`;

const sameContent = (a: OrderLineView, b: OrderLineView): boolean => a.quantity === b.quantity && a.unit === b.unit && a.text === b.text;

/**
 * What going from `before` to `after` adds, removes and changes. Lines pair by identity, not by
 * label: a removal shifts the labels after it, and the person reviewing must not see a shift as a change.
 */
export function lineDiff(before: readonly OrderLineView[], after: readonly OrderLineView[]): LineDiff {
  const unpaired = [...after];
  const removed: OrderLineView[] = [];
  const changed: { before: OrderLineView; after: OrderLineView }[] = [];
  for (const old of before) {
    const index = unpaired.findIndex((line) => identity(line) === identity(old));
    if (index === -1) {
      removed.push(old);
      continue;
    }
    const [next] = unpaired.splice(index, 1);
    if (next !== undefined && !sameContent(old, next)) changed.push({ before: old, after: next });
  }
  return { added: unpaired, removed, changed };
}

/** The lines a waiting request would leave: `diff` applied to the order's lines, for showing the customer what they asked. */
export function requestedLines(lines: readonly OrderLineView[], diff: LineDiff): OrderLineView[] {
  const removed = [...diff.removed];
  const changed = [...diff.changed];
  const kept: OrderLineView[] = [];
  for (const line of lines) {
    const gone = removed.findIndex((old) => identity(old) === identity(line));
    if (gone !== -1) {
      removed.splice(gone, 1);
      continue;
    }
    const change = changed.findIndex(({ before }) => identity(before) === identity(line));
    kept.push(change === -1 ? line : changed.splice(change, 1)[0]!.after);
  }
  return [...kept, ...diff.added];
}
