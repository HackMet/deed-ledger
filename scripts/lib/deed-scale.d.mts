/** Types for scripts/lib/deed-scale.mjs (plain Node JS, no build step). */

export const PALETTE: {
  readonly claim: string;
  readonly witness: string;
  readonly ok: string;
  readonly doubt: string;
  readonly bad: string;
};
export const CUSUM_H: number;
export const NEFF_MIN: number;

export type VerdictKind = "confirmed" | "contradicted" | "in_doubt" | "no_claim";

/** One row of deed-verdicts.csv, keyed by its header names (every cell is text; "" when empty). */
export interface CsvRow {
  readonly run: string;
  readonly started: string;
  readonly model: string;
  readonly status: string;
  readonly claimed_sha: string;
  readonly sha_exists: string;
  readonly claimed_passed: string;
  readonly observed_passed: string;
  readonly observed_failed: string;
  readonly gate_note: string;
  readonly verdict: string;
}

export interface ScaleRow {
  readonly run: string;
  readonly started: string;
  readonly model: string;
  readonly status: string;
  readonly claimedSha: string;
  readonly shaExists: boolean;
  readonly claimedPassed: number | null;
  readonly verdict: string;
  readonly kind: VerdictKind;
  readonly brief: string;
  readonly effect: "commit" | "review";
  readonly agent: string;
}

export interface ScaleGroup {
  readonly agent: string;
  readonly effect: "commit" | "review";
  runs: number;
  confirmed: number;
  contradicted: number;
  in_doubt: number;
  no_claim: number;
}

export interface Neff {
  readonly n: number;
  readonly rho1: number;
  readonly vif: number;
  readonly nEff: number;
}

export interface Cusum {
  readonly k: number | null;
  readonly h: number;
  readonly series: readonly number[];
  readonly alarm: number | null;
  readonly max: number;
}

export interface Scale {
  readonly rows: readonly ScaleRow[];
  readonly counts: {
    readonly total: number;
    readonly confirmed: number;
    readonly contradicted: number;
    readonly inDoubt: number;
    readonly noClaim: number;
  };
  readonly huella: string;
  readonly huellaRows: number;
  readonly groups: readonly ScaleGroup[];
  readonly claims: readonly ScaleRow[];
  readonly neff: Neff | null;
  readonly cusum: Cusum;
}

export function verdictKind(verdict: string): VerdictKind;
export function parseCsv(text: string): CsvRow[];
export function briefOf(run: string): string;
export function effectClass(run: string): "commit" | "review";
export function sha256Hex(text: string): Promise<string>;
export function agentIdOf(model: string, brief: string): Promise<string>;
export function neffOf(x: readonly number[]): Neff | null;
export function cusumOf(x: readonly number[], h?: number): Cusum;
export function buildScale(csvRows: readonly CsvRow[]): Promise<Scale>;
export interface ScaleNotes {
  attemptsWithoutVerdict?: number;
  rewritten?: { from: string; to: string }[];
}
export function renderPage(scale: Scale, notes?: ScaleNotes): string;
