/** Types for scripts/lib/eval-assert.mjs (plain Node JS, no build step). */

export interface BotTurn {
  readonly stepIndex: number;
  readonly text: string;
}

export interface MoneyMention {
  readonly raw: string;
  readonly centavos: number;
}

export interface OneByOneHit {
  readonly at: number;
  readonly prev: string;
  readonly curr: string;
}

export interface RepeatedHit {
  readonly at: number;
  readonly question: string;
}

export interface EvalOrderLine {
  readonly lineId?: string;
  readonly text?: string | null;
  readonly productId?: string | null;
  readonly productName?: string | null;
  readonly quantity?: string | null;
  readonly quantitySource?: string | null;
  readonly unitPrice?: number | null;
  readonly unit?: string | null;
}

export interface EvalOrder {
  readonly state: string;
  readonly total?: number | null;
  readonly version?: number | null;
  readonly lines: readonly EvalOrderLine[];
}

export interface RequestedItem {
  readonly words: readonly string[];
  readonly products?: readonly (string | null)[] | null;
  readonly quantity?: string | null;
  readonly source?: string | null;
}

export interface ItemFailure {
  readonly kind: string;
  readonly detail: string;
}

export interface StoredClaimRow {
  readonly id: string;
  readonly seq?: number | null;
  readonly claims?: unknown;
  readonly blocked?: boolean;
}

export interface StoredClaimRecords {
  readonly orders?: Record<string, { readonly version: number; readonly state: string; readonly total: number | null }>;
  readonly prices?: Record<string, number>;
  readonly availability?: Record<string, string>;
  readonly hoursKey?: string | null;
}

export interface StoredClaimVerdict {
  readonly id: string;
  readonly seq: number | null;
  readonly ok: boolean;
  readonly failures: string[];
}

export interface ExpectedLine {
  readonly product: string;
  readonly quantity?: string | null;
  readonly source?: string | null;
}

export interface ScenarioExpect {
  readonly lines?: readonly ExpectedLine[];
  readonly totalCentavos?: number | null;
  readonly state?: string | null;
  readonly stateIn?: readonly string[] | null;
  readonly expectNoOrder?: boolean | null;
  readonly expectHandoff?: boolean | null;
  readonly expectPendiente?: string | null;
  readonly maxTurns?: number | null;
  readonly injection?: boolean | null;
  readonly staleTap?: boolean | null;
  readonly textIncludes?: readonly string[] | null;
  readonly textExcludes?: readonly string[] | null;
}

export interface EvalPendiente {
  readonly kind: string;
  readonly done_at_ms?: number | null;
}

export interface GradeInput {
  readonly expect?: ScenarioExpect | null;
  readonly order?: EvalOrder | null;
  readonly pendientes?: readonly EvalPendiente[];
  readonly botTexts?: readonly string[];
  readonly catalogNames?: readonly string[];
  readonly allowedAmounts?: ReadonlySet<number>;
  readonly customerTurns?: number;
  readonly staleBefore?: EvalOrder | null;
  readonly staleAfter?: EvalOrder | null;
  readonly catalogPrices?: ReadonlyMap<string, number> | Record<string, number> | null;
  readonly botTurns?: readonly (BotTurn | string)[] | null;
  readonly signatureAt?: ((stepIndex: number) => string | null) | null;
}

export interface GradeVerdict {
  readonly pass: boolean;
  readonly truthFail: boolean;
  readonly problems: string[];
  readonly truthProblems: string[];
}

export interface SummaryInput {
  readonly id: string;
  readonly pass: boolean;
  readonly truthFail: boolean;
  readonly turnsToConfirm?: number | null;
  readonly latencies?: readonly number[];
}

export interface RunSummary {
  readonly total: number;
  readonly passed: number;
  readonly rate: number;
  readonly truthFailIds: string[];
  readonly shippable: boolean;
  readonly medianTurnsToConfirm: number | null;
  readonly medianLatencyMs: number | null;
}

export function normalizeEs(text: string): string;
export function wordsOf(text: string, min?: number): string[];
export function extractMoneyMentions(text: string): MoneyMention[];
export function toThousandths(value: string): number | null;
export function recomputeSubtotal(
  lines: readonly {
    readonly restricted?: boolean;
    readonly availability?: string;
    readonly mark?: string | null;
    readonly unitPrice?: number | null;
    readonly quantity?: string | null;
  }[],
): number | null;
export function verifyStoredClaims(rows: readonly StoredClaimRow[], records: StoredClaimRecords): StoredClaimVerdict[];
export function hoursKeyOf(hours: readonly { readonly days: unknown; readonly opens: unknown; readonly closes: unknown }[]): string | null;
export function checkMoneyBacked(botTexts: readonly string[], backing: readonly number[]): MoneyMention & { text: string }[];
export function isQuestion(text: string): boolean;
export function significantWords(text: string): string[];
export function mentionedProducts(text: string, catalogNames: readonly string[]): string[];
export function isSingleProductQuestion(text: string, catalogNames: readonly string[]): string | null;
export function classifyQuestion(text: string): "options" | "quantities" | "other" | null;
export function detectOneByOne(
  botTurns: readonly (BotTurn | string)[],
  catalogNames: readonly string[],
  orderGrewBetween?: (fromStep: number, toStep: number) => boolean,
): OneByOneHit[];
export function normalizeQuestion(text: string): string;
export function isRepeatExempt(text: string): boolean;
export function detectRepeatedQuestion(
  botTurns: readonly (BotTurn | string)[],
  signatureAt?: (stepIndex: number) => unknown,
): RepeatedHit[];
export function sameQuantity(want: string | null | undefined, got: string | null | undefined): boolean;
export function flaggedUnknown(keyword: string, botTexts: readonly string[]): boolean;
export function attributeLines(
  requested: readonly RequestedItem[],
  orderLines: readonly EvalOrderLine[],
): { attributed: Map<number, number>; unattributedLines: number[]; missingItems: number[] };
export function checkItemsKept(
  requested: readonly RequestedItem[],
  orderLines: readonly EvalOrderLine[],
  botTexts: readonly string[],
): { ok: boolean; failures: ItemFailure[]; truthFail: boolean };
export function checkInjectionHadNoEffect(
  botTexts: readonly string[],
  orderLines: readonly EvalOrderLine[],
  catalogPrices?: ReadonlyMap<string, number> | Record<string, number> | null,
): { ok: boolean; failures: string[] };
export function checkStaleTapHadNoEffect(before: EvalOrder | null, after: EvalOrder | null): { ok: boolean; failures: string[] };
export function median(values: readonly number[]): number | null;
export function replyLatencies(
  inbounds: readonly { readonly received_at_ms: number }[],
  outbounds: readonly { readonly created_at_ms: number }[],
): number[];
export function compareRuns(
  a: { readonly scenarios: readonly { readonly id: string; readonly pass: boolean }[] },
  b: { readonly scenarios: readonly { readonly id: string; readonly pass: boolean }[] },
): { id: string; a: boolean; b: boolean | null }[];
export function allowedAmountsFor(input: {
  order?: EvalOrder | null;
  catalogPrices?: readonly number[] | ReadonlyMap<string, number>;
  feeCentavos?: number | null;
}): Set<number>;
export function gradeScenario(input: GradeInput): GradeVerdict;
export function summarize(results: readonly SummaryInput[]): RunSummary;
