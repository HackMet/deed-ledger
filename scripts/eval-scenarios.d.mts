/** Types for scripts/eval-scenarios.mjs (plain Node JS, no build step). */

export interface ScenarioStep {
  readonly say?: string | readonly string[];
  readonly tap?: string;
  readonly tapStale?: string;
  readonly photo?: string;
  readonly caption?: string;
  readonly voice?: string;
  readonly staff?: { readonly do: string; readonly line?: string };
  readonly ownerReply?: string;
  readonly wait?: number;
}

export interface EvalScenario {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly ScenarioStep[];
}

export interface MediaRef {
  readonly kind: "photo" | "voice";
  readonly path: string;
}

export const SCENARIOS: readonly EvalScenario[];
export function mediaSteps(scenario: EvalScenario): MediaRef[];
