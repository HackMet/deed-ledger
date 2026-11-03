/**
 * A "which one" answer resolved by code, on the planner path (eval E19, E09b, Nov 3). When the
 * question last shown listed options and the customer's words point at exactly one ("2", "esa de
 * 34", "mazola"), that product is picked for its line, whatever the model made of the burst: a
 * reading that missed the answer gets a plan made only of that pick, and a plan that left the line
 * unresolved (or asked the same list again) gets the pick added. The engine still applies it, and
 * the customer still confirms the readback.
 */
import type { BurstMessage } from "../../domain/perception/burst";
import { orderBasis } from "../../domain/planner/frame";
import { chosenOption } from "../../domain/planner/option-answer";
import type { LineChange, TurnPlan } from "../../domain/planner/types";
import type { PlannerContext } from "./source";

/** The order line and product the burst's words choose among the options last shown, or null. */
export function answeredOption(context: PlannerContext, messages: readonly BurstMessage[]): LineChange | null {
  if (context.shownOptions.length === 0 || context.order === null) return null;
  const texts = messages.flatMap((message) => (message.type === "text" || message.type === "transcript" ? [message.text] : []));
  const chosen = chosenOption(texts, context.shownOptions);
  if (chosen === null) return null;
  const at = context.order.lines.findIndex((line) => line.lineId === chosen.lineId);
  if (at === -1 || context.order.lines[at]!.productId !== null) return null;
  return { lineRef: `L${at + 1}`, productId: chosen.productId };
}

/** The plan with the answered option picked for its line (a plan of that pick alone when there is none). */
export function withAnsweredOption(plan: TurnPlan | null, pick: LineChange, context: PlannerContext): TurnPlan {
  if (plan === null) return { move: "restate", ask: null, assumed: [], say: "", basis: orderBasis(context.order), changes: [pick] };
  const changes = plan.changes ?? [];
  const same = changes.find((change) => change.lineRef === pick.lineRef);
  return { ...plan, changes: [...changes.filter((change) => change !== same), { ...same, ...pick }] };
}
