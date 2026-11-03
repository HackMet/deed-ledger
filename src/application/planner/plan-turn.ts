/**
 * The planner (D-45): the second Muse Spark call of a burst, after the reader. Retrieval offers
 * products per line, the planner proposes the turn (strict json_schema, no write tools), code checks
 * the proposal (`validateProposal`) and hands the engine a `TurnPlan` and the planner's picks as
 * matches. The engine still saves; a person's tap still commits.
 *
 * It spends from the same per-store daily cap as the reader (`meteredCall`). Any failure (spend
 * cap, provider error or timeout, output that isn't the schema) returns null: the burst goes the
 * classic way, and the failure is logged, never silent.
 */
import type { BurstReading } from "../../domain/contract/observation";
import type { BurstMessage } from "../../domain/perception/burst";
import type { RefusalCode } from "../../domain/planner/validate";
import { validateProposal } from "../../domain/planner/validate";
import type { TurnPlan } from "../../domain/planner/types";
import { TURN_SCHEMA_NAME, turnSchema } from "../../domain/planner/wire";
import type { LineMatch } from "../engine";
import { meteredCall, type MeteredCallDeps, type MeteredOutcome } from "../metered-call";
import type { CustomerContextWithName } from "../order-handler";
import type { Logger, ModelContentPart, Tenant } from "../ports";
import { plannerInstructions, type PlannerInstructions } from "./instructions";
import { buildPlannerInput } from "./input";
import type { RetrieveCandidates } from "./interim-retrieval";
import type { PlannerSource } from "./source";

/**
 * Reasoning plus the answer. A long list's ops are a few hundred tokens; the rest is room to
 * reason. A cut-off answer is invalid output, and the burst goes the classic way.
 */
export const PLANNER_MAX_OUTPUT_TOKENS = 6_144;

/** The planner's model call. Tests answer with recorded proposals. */
export interface TurnProposer {
  propose(tenant: Tenant, user: readonly ModelContentPart[]): Promise<MeteredOutcome>;
}

export class PlannerModel implements TurnProposer {
  constructor(
    private readonly deps: MeteredCallDeps,
    private readonly instructions: PlannerInstructions = plannerInstructions(),
  ) {}

  propose(tenant: Tenant, user: readonly ModelContentPart[]): Promise<MeteredOutcome> {
    return meteredCall(
      this.deps,
      tenant,
      {
        system: this.instructions.system,
        user,
        schemaName: TURN_SCHEMA_NAME,
        schema: turnSchema,
        maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
        // The instruction version is a hash of the layers' text: one cache group per exact wording.
        promptCacheKey: this.instructions.version,
      },
      { promptVersion: this.instructions.version, logPrefix: "planner" },
    );
  }
}

export interface TurnPlannerDeps {
  readonly model: TurnProposer;
  /** Lane L1's `retrieveCandidates` once merged; the interim adapter until then. */
  readonly retrieve: RetrieveCandidates;
  readonly source: PlannerSource;
  readonly log: Logger;
}

export interface PlannedTurn {
  readonly plan: TurnPlan;
  /** The planner's picks for new items, as matches (`planner_pick`). */
  readonly matches: readonly LineMatch[];
}

/**
 * Bursts the planner decides: an order, a change, an answer, pickup or delivery. A cancel, ALTO, a
 * handoff or a payment is the engine's alone, and a burst that only asks or chats needs no plan.
 */
export function needsPlanner(reading: BurstReading): boolean {
  const kinds = reading.observations.map((observation) => observation.kind);
  if (kinds.some((kind) => kind === "order_cancel" || kind === "stop" || kind === "handoff" || kind === "payment_receipt")) return false;
  return kinds.some((kind) => kind === "customer_order" || kind === "order_change" || kind === "clarification" || kind === "fulfillment");
}

export async function planTurn(
  deps: TurnPlannerDeps,
  request: {
    readonly context: CustomerContextWithName;
    readonly reading: BurstReading;
    readonly matches: readonly LineMatch[];
    readonly messages: readonly BurstMessage[];
  },
): Promise<PlannedTurn | null> {
  const { context, reading } = request;
  const ids = { businessId: context.businessId, conversationId: context.conversationId };
  const plannerContext = await deps.source.plannerContext(context);
  const input = buildPlannerInput(
    {
      reading,
      matches: request.matches,
      messages: request.messages,
      context: plannerContext,
      customer: { nameKnown: context.customerName !== null, savedPlace: context.savedPlace !== null },
    },
    deps.retrieve,
  );
  const outcome = await deps.model.propose({ businessId: context.businessId }, input.user);
  if (!outcome.ok) {
    deps.log.warn("planner.fallback", { ...ids, reason: outcome.reason });
    return null;
  }
  const checked = validateProposal(outcome.json, input.frame);
  if (!checked.ok) {
    deps.log.warn("planner.fallback", { ...ids, reason: "invalid_output" });
    return null;
  }
  const { plan, picks, refused } = checked.turn;
  const counts = new Map<RefusalCode, number>();
  for (const refusal of refused) counts.set(refusal.code, (counts.get(refusal.code) ?? 0) + 1);
  for (const [code, count] of counts) {
    deps.log.info(code === "line_left_out" ? "planner.dropped_line" : "planner.refused", { ...ids, reason: code, count });
  }
  deps.log.info("planner.planned", { ...ids, outcome: plan.move, reason: plan.ask?.kind ?? "none", count: plan.assumed.length });
  const matches: LineMatch[] = picks.flatMap(({ label, productId }) => {
    const item = input.newItems.find((n) => n.label === label);
    return item === undefined ? [] : [{ observation: item.observation, line: item.line, productId, how: "planner_pick" as const }];
  });
  return { plan, matches };
}
