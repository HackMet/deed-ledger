/** Order versions and line labels. Pure: a version is immutable, a change produces the next one. */
import type { DecimalString } from "./contract/numbers";
import { isDecimalString } from "./contract/numbers";
import type { OrderLineView, OrderView } from "./contract/outcomes";

const LABEL = /^L([1-9]\d{0,8})$/;

/** Line N of a version is "LN", 1-based. `index` is the 0-based position in the line list. */
export function labelOf(index: number): string {
  return `L${index + 1}`;
}

/** The 0-based position a label points at, or null when it isn't a label or is out of range. */
export function indexOfLabel(lineCount: number, label: string): number | null {
  const match = LABEL.exec(label);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index < lineCount ? index : null;
}

/** Never throws and never picks a neighbour: a label that doesn't resolve is null. */
export function lineByLabel(version: Pick<OrderView, "lines">, label: string): OrderLineView | null {
  const index = indexOfLabel(version.lines.length, label);
  return index === null ? null : (version.lines[index] ?? null);
}

export type OrderChangeEdit =
  | { readonly op: "add"; readonly line: OrderLineView }
  | { readonly op: "remove"; readonly label: string }
  | { readonly op: "set_quantity"; readonly label: string; readonly quantity: DecimalString };

export interface NextVersion {
  readonly version: number;
  readonly lines: readonly OrderLineView[];
}

/**
 * The version after `current` with `change` applied, or null when the change points at a label
 * or quantity that doesn't resolve. `current` is never modified; labels are renumbered by position.
 */
export function nextVersion(
  current: Pick<OrderView, "version" | "lines">,
  change: OrderChangeEdit,
): NextVersion | null {
  const version = current.version + 1;
  if (change.op === "add") {
    // A known quantity must be a non-negative decimal; null stays unknown.
    if (change.line.quantity !== null && !isDecimalString(change.line.quantity)) return null;
    return { version, lines: [...current.lines, change.line] };
  }

  const index = indexOfLabel(current.lines.length, change.label);
  if (index === null) return null;

  if (change.op === "remove") {
    return { version, lines: current.lines.filter((_, i) => i !== index) };
  }
  if (!isDecimalString(change.quantity)) return null;
  return {
    version,
    lines: current.lines.map((line, i) => (i === index ? { ...line, quantity: change.quantity } : line)),
  };
}
