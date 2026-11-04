import type { Entry, JudgeState, Verdict } from "./types";

/**
 * What a ledger offers: the reads the judge needs, and an admit that judges one entry and writes it only if
 * admitted. A scope keeps one ledger's entries apart from another's (a tenant, a site, a lot: the host decides).
 */
export interface LedgerPort {
  read(scope: string, entry: Entry): Promise<JudgeState>;
  admit(scope: string, entry: Entry, nowMs: number): Promise<Verdict>;
}
