/**
 * The port every store of the core implements, and the shape of a batch on a transactional database.
 * The core owns the rules; a host adds its own work to the same transaction through an extension.
 */
import type { Entry, Verdict } from "./types";

/** Admits one entry or refuses it, atomically. `scope` isolates hosts' tenants: nothing crosses it. */
export interface LedgerStore {
  admit(scope: string, entry: Entry, nowMs: number): Promise<Verdict>;
}

/**
 * A precondition inside the batch: `holdsSql` selects one row with a non-NULL value when it holds. `reason`, set by a
 * host's extension, is the verdict reason its refusal gives on the core's store; the core's own guards leave it unset.
 */
export interface CoreGuard {
  readonly holdsSql: string;
  readonly params: readonly unknown[];
  readonly error: () => Error;
  readonly reason?: string;
}

/** What one entry becomes on a transactional database. The host runs it as one batch, in this order. */
export interface BatchPlan {
  readonly guards: readonly CoreGuard[];
  readonly statements: readonly D1PreparedStatement[];
  readonly post: readonly CoreGuard[];
}

/** Where the core's four tables live. The table, scope and actor names are the host's, so the core names no business. */
export interface LedgerConfig {
  readonly tables: { readonly facts: string; readonly evidence: string; readonly dependencies: string; readonly closures: string };
  readonly columns: { readonly scope: string; readonly actor: string };
}

/** The neutral names of `schema.sql`, for a host with no tables of its own. */
export const DEFAULT_LEDGER_CONFIG: LedgerConfig = {
  tables: { facts: "facts", evidence: "fact_evidence", dependencies: "fact_dependencies", closures: "fact_closures" },
  columns: { scope: "scope_id", actor: "actor_id" },
};

/**
 * A host's own work in the entry's batch, all atomic with it. The core never reads what it does.
 * `factColumns` are extra columns on the entry's fact row. `statementsBefore` run before the fact is written,
 * `statementsAfter` after the closure. Guards run before any statement, `post` after all of them.
 */
export interface HostExtension {
  readonly guards?: readonly CoreGuard[];
  readonly factColumns?: Readonly<Record<string, string | number | null>>;
  readonly statementsBefore?: readonly D1PreparedStatement[];
  readonly statementsAfter?: readonly D1PreparedStatement[];
  readonly post?: readonly CoreGuard[];
}

/** How a host turns the core's refusal reasons into its own errors, so the fence reports them unchanged. */
export type RefusalError = (reason: string) => Error;
