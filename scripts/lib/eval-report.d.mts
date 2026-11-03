/** Types for scripts/lib/eval-report.mjs (plain Node JS, no build step). */
export declare function allReport(at: string, pathLabel: string, transcripts: readonly string[]): string;
export declare function retriedOnce<T>(post: () => Promise<T>, waitMs?: number): Promise<T>;
