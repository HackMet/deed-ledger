import { FactRefusedError, PermanentWriteError } from "../../application/errors";
import type { Commit, Tenant } from "../../application/ports";
import type { LedgerConfig, RefusalError } from "../../deed-core/store";
import type { Entry } from "../../deed-core/types";
import { planEntry, readUsedKey } from "../../deed-core/d1-store";
import type { FactPrecheckReads } from "../../domain/fact-precheck";
import type { FactCommit } from "../../domain/facts";
import { STORE_POLICY } from "../../domain/store-policy";
import { storeExtension } from "./store-extension";

/**
 * Turns one domain `FactCommit` into the `Commit` the job repository runs in the batch that
 * completes the job. The core builds the batch (src/deed-core/d1-store.ts): the store's policy gives the evidence
 * rule (P1), and the store's extension gives the draft (G3, S1, S6) and the stock (S4, S5).
 *
 * The scope is a store; a conversation is needed only for a draft (G3). The receipt handler passes
 * its lease, the order engine its customer or member context.
 */
export type FactScope = Tenant & { readonly conversationId?: string };

export interface FactLedger {
  statementsFor(scope: FactScope, commit: FactCommit, nowMs: number): Commit;
}

/** The store's four core tables, with its own scope and actor columns. */
export const STORE_LEDGER: LedgerConfig = {
  tables: { facts: "facts", evidence: "fact_evidence", dependencies: "fact_dependencies", closures: "fact_closures" },
  columns: { scope: "business_id", actor: "actor_user_id" },
};

/** The core's reason strings, as the store's errors: the fence reports them unchanged. */
const refusalOf: RefusalError = (reason) => {
  switch (reason) {
    case "dependency_not_live":
    case "closes_not_live":
      return new FactRefusedError(reason);
    case "evidence_incomplete":
      return new PermanentWriteError("fact admitted without its evidence");
    default:
      return new PermanentWriteError(`fact refused: ${reason}`);
  }
};

function entryOf(commit: FactCommit): Entry {
  return {
    factId: commit.factId,
    kind: commit.kind,
    operationKey: commit.operationKey,
    actor: commit.actorUserId,
    validFromMs: commit.validFromMs,
    body: commit.body,
    evidence: commit.evidence,
    dependsOn: commit.dependsOn,
    sameBatch: commit.sameBatch,
    closes: commit.closes,
    agentId: commit.agentId,
  };
}

export class D1FactLedger implements FactLedger {
  constructor(private readonly db: D1Database) {}

  statementsFor(scope: FactScope, commit: FactCommit, nowMs: number): Commit {
    return planEntry(
      this.db,
      STORE_LEDGER,
      STORE_POLICY,
      scope.businessId,
      entryOf(commit),
      nowMs,
      refusalOf,
      storeExtension(this.db, scope, commit, nowMs),
    );
  }
}

/**
 * The reads behind `precheckFact`, in one place, for one proposed fact.
 *
 * Three statements, not three round trips per dependency: the gate's answer is the set of ids that
 * are closed, foreign or absent, which is the complement of what G4 counts.
 */
export class D1FactPrecheck {
  constructor(private readonly db: D1Database) {}

  async read(scope: FactScope, commit: FactCommit): Promise<FactPrecheckReads> {
    const businessId = scope.businessId;

    const used = await readUsedKey(this.db, STORE_LEDGER, businessId, commit.operationKey);

    const draft =
      commit.draft === null || scope.conversationId === undefined
        ? null
        : await this.db
            .prepare(
              `SELECT revision, state, expires_at_ms AS expiresAtMs FROM drafts
               WHERE business_id = ? AND conversation_id = ? AND id = ?`,
            )
            .bind(businessId, scope.conversationId, commit.draft.id)
            .first<{ revision: number; state: string; expiresAtMs: number }>();

    let deadDependencies: readonly string[] = [];
    if (commit.dependsOn.length > 0) {
      const { results } = await this.db
        .prepare(
          `WITH RECURSIVE requested(id) AS (SELECT value FROM json_each(?)),
             ancestors(id) AS (
               SELECT id FROM requested
               UNION
               SELECT d.depends_on_fact_id FROM fact_dependencies d
               JOIN ancestors a ON d.fact_id = a.id WHERE d.business_id = ?
             )
           SELECT a.id AS id FROM ancestors a
           WHERE NOT EXISTS (SELECT 1 FROM facts f WHERE f.business_id = ? AND f.id = a.id)
              OR EXISTS (SELECT 1 FROM fact_closures c WHERE c.business_id = ? AND c.fact_id = a.id
                AND NOT (c.reason = 'superseded' AND c.closed_by_fact_id IN (SELECT id FROM ancestors)))`,
        )
        .bind(JSON.stringify(commit.dependsOn), businessId, businessId, businessId)
        .all<{ id: string }>();
      deadDependencies = results.map((row) => row.id);
    }

    let closesState: FactPrecheckReads["closesState"] = null;
    if (commit.closes !== null) {
      const target = await this.db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM fact_closures c WHERE c.business_id = f.business_id AND c.fact_id = f.id) AS closed
           FROM facts f WHERE f.business_id = ? AND f.id = ?`,
        )
        .bind(businessId, commit.closes.factId)
        .first<{ closed: number }>();
      closesState = target === null ? "missing" : target.closed === 1 ? "closed" : "live";
    }

    // The first outcome isn't stored yet: `operations` is the engine's table (#11). Until it
    // exists, a used key is reported as a duplicate whose first outcome is unknown.
    return { firstOutcome: used ? { type: "nothing" } : null, draft, deadDependencies, closesState };
  }
}
