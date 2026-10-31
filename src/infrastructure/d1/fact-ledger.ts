import { FactRefusedError, PermanentWriteError } from "../../application/errors";
import type { Commit, Lease } from "../../application/ports";
import type { FactPrecheckReads } from "../../domain/fact-precheck";
import type { FactCommit } from "../../domain/facts";
import type { Guard } from "./fence";

/**
 * Turns one domain `FactCommit` into the `Commit` the job repository runs in the batch that
 * completes the job: `guards` are the draft (G3), the dependency gate (G4) and the closed fact (G5), `statements` are
 * S1–S6 in order, and `post` is the evidence check (P1).
 */
export interface FactLedger {
  statementsFor(lease: Lease, commit: FactCommit, nowMs: number): Commit;
}

/**
 * Every `dependsOn` id and its ancestors (via fact_dependencies) exist in this store and none is
 * closed. 1 when the gate is open, NULL otherwise. A dependency that doesn't exist or belongs to
 * another store fails the count.
 */
const DEPENDENCIES_LIVE = `WITH RECURSIVE ancestors(id) AS (
    SELECT value FROM json_each(?)
    UNION
    SELECT d.depends_on_fact_id FROM fact_dependencies d
    JOIN ancestors a ON d.fact_id = a.id WHERE d.business_id = ?
  )
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM fact_closures c JOIN ancestors a ON c.fact_id = a.id WHERE c.business_id = ?
  ) AND (SELECT count(*) FROM facts f JOIN ancestors a ON f.id = a.id WHERE f.business_id = ?)
      = (SELECT count(*) FROM ancestors) THEN 1 END`;

/**
 * The fact has exactly one 'confirmation' and at least one 'inbound_message' evidence row.
 *
 * Inside the batch the fact always exists (S2 ran). The fence re-checks guards after a rolled-back
 * batch, when the fact is gone: it holds then, so a failure elsewhere in the batch (a negative
 * balance, a duplicate) is reported as that constraint, not as missing evidence. A P1 failure
 * itself surfaces as a PermanentWriteError, with nothing written.
 */
const EVIDENCE_COMPLETE = `SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM facts WHERE business_id = ? AND id = ?) THEN 1
    WHEN (SELECT count(*) FROM fact_evidence WHERE business_id = ? AND fact_id = ? AND kind = 'confirmation') = 1
      AND EXISTS (SELECT 1 FROM fact_evidence WHERE business_id = ? AND fact_id = ? AND kind = 'inbound_message')
      THEN 1 END`;

export class D1FactLedger implements FactLedger {
  constructor(private readonly db: D1Database) {}

  statementsFor(lease: Lease, commit: FactCommit, nowMs: number): Commit {
    const businessId = lease.businessId;
    const guards: Guard[] = [];
    const statements: D1PreparedStatement[] = [];
    const confirmation = commit.evidence.find((ref) => ref.kind === "confirmation");
    // The message that confirmed: the commit's last inbound_message evidence.
    const confirmingInbound = commit.evidence.filter((ref) => ref.kind === "inbound_message").at(-1);

    // G3: the exact revision the owner confirmed is still pending, unexpired, in this conversation.
    if (commit.draft !== null) {
      guards.push({
        holdsSql: `SELECT 1 FROM drafts
                   WHERE business_id = ? AND conversation_id = ? AND id = ? AND state = 'pending' AND revision = ?
                     AND expires_at_ms > ?`,
        params: [businessId, lease.conversationId, commit.draft.id, commit.draft.revision, nowMs],
        error: () => new FactRefusedError("draft_not_pending"),
      });
    }
    // G4: the gate.
    guards.push({
      holdsSql: DEPENDENCIES_LIVE,
      params: [JSON.stringify(commit.dependsOn), businessId, businessId, businessId],
      error: () => new FactRefusedError("dependency_not_live"),
    });

    // G5: what a cancellation closes is a fact of this store and still open. fact_closures has no
    // foreign key to facts, so without this a foreign or unknown id would be recorded as closed.
    if (commit.closes !== null) {
      guards.push({
        holdsSql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM facts WHERE business_id = ? AND id = ?)
                     AND NOT EXISTS (SELECT 1 FROM fact_closures WHERE business_id = ? AND fact_id = ?) THEN 1 END`,
        params: [businessId, commit.closes.factId, businessId, commit.closes.factId],
        error: () => new FactRefusedError("closes_not_live"),
      });
    }
    // S1: one approval per draft, ever (UNIQUE business_id, draft_id).
    if (commit.draft !== null && confirmation !== undefined && confirmingInbound !== undefined) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO draft_confirmations (id, business_id, draft_id, revision, actor_user_id, inbound_id, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            confirmation.refId,
            businessId,
            commit.draft.id,
            commit.draft.revision,
            commit.actorUserId,
            confirmingInbound.refId,
            nowMs,
          ),
      );
    }
    // S2: exactly once per operation key (UNIQUE business_id, operation_key).
    statements.push(
      this.db
        .prepare(
          `INSERT INTO facts (id, business_id, kind, operation_key, draft_id, draft_revision, actor_user_id,
             valid_from_ms, recorded_at_ms, body_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          commit.factId,
          businessId,
          commit.kind,
          commit.operationKey,
          commit.draft?.id ?? null,
          commit.draft?.revision ?? null,
          commit.actorUserId,
          commit.validFromMs,
          nowMs,
          JSON.stringify(commit.body ?? null),
        ),
    );
    // S3: what the fact rests on.
    for (const ref of commit.evidence) {
      statements.push(
        this.db
          .prepare(`INSERT INTO fact_evidence (business_id, fact_id, kind, ref_id, content_sha256) VALUES (?, ?, ?, ?, ?)`)
          .bind(businessId, commit.factId, ref.kind, ref.refId, ref.contentSha256),
      );
    }
    for (const dependsOn of commit.dependsOn) {
      statements.push(
        this.db
          .prepare(`INSERT INTO fact_dependencies (business_id, fact_id, depends_on_fact_id) VALUES (?, ?, ?)`)
          .bind(businessId, commit.factId, dependsOn),
      );
    }
    // S4: a fact closes once (PRIMARY KEY business_id, fact_id). The closed fact stays immutable: its
    // stock is restored by compensating movements (negated quantities), written here in the same batch.
    if (commit.closes !== null) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO fact_closures (business_id, fact_id, closed_by_fact_id, reason, closed_at_ms) VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(businessId, commit.closes.factId, commit.factId, commit.closes.reason, nowMs),
        this.db
          .prepare(
            `INSERT INTO stock_movements (id, business_id, fact_id, product_id, qty_milli, unit_cost_centavos, created_at_ms)
             SELECT lower(hex(randomblob(16))), business_id, ?, product_id, -qty_milli, unit_cost_centavos, ?
             FROM stock_movements WHERE business_id = ? AND fact_id = ?`,
          )
          .bind(commit.factId, nowMs, businessId, commit.closes.factId),
        // The balance rows exist (the original movements upserted them), so this is an UPDATE: an INSERT
        // would check the negated value against the CHECK before any conflict. A restore that would
        // drive a balance below zero fails its CHECK and rolls the closure back too.
        this.db
          .prepare(
            `UPDATE stock_balances SET qty_milli = qty_milli + (
               SELECT sum(-m.qty_milli) FROM stock_movements m
               WHERE m.business_id = stock_balances.business_id AND m.product_id = stock_balances.product_id AND m.fact_id = ?
             ), updated_at_ms = ?
             WHERE business_id = ? AND product_id IN (SELECT product_id FROM stock_movements WHERE business_id = ? AND fact_id = ?)`,
          )
          .bind(commit.closes.factId, nowMs, businessId, businessId, commit.closes.factId),
      );
    }
    // S5: movements and balances; a balance below zero fails its CHECK.
    for (const movement of commit.movements) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO stock_movements (id, business_id, fact_id, product_id, qty_milli, unit_cost_centavos, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(movement.id, businessId, commit.factId, movement.productId, movement.qtyMilli, movement.unitCostCentavos, nowMs),
        this.db
          .prepare(
            `INSERT INTO stock_balances (business_id, product_id, qty_milli, updated_at_ms) VALUES (?, ?, ?, ?)
             ON CONFLICT (business_id, product_id)
             DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli, updated_at_ms = excluded.updated_at_ms`,
          )
          .bind(businessId, movement.productId, movement.qtyMilli, nowMs),
      );
    }
    // S6: the draft is spent (G3 pinned it, so this matches exactly one row).
    if (commit.draft !== null) {
      statements.push(
        this.db
          .prepare(`UPDATE drafts SET state = 'committed', updated_at_ms = ? WHERE business_id = ? AND id = ?`)
          .bind(nowMs, businessId, commit.draft.id),
      );
    }

    // P1: no fact without its confirmation and the message it came from.
    const post: Guard[] = [
      {
        holdsSql: EVIDENCE_COMPLETE,
        params: [businessId, commit.factId, businessId, commit.factId, businessId, commit.factId],
        error: () => new PermanentWriteError("fact admitted without its evidence"),
      },
    ];
    return { guards, statements, post };
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

  async read(lease: Lease, commit: FactCommit): Promise<FactPrecheckReads> {
    const businessId = lease.businessId;

    const used = await this.db
      .prepare(`SELECT 1 AS used FROM facts WHERE business_id = ? AND operation_key = ?`)
      .bind(businessId, commit.operationKey)
      .first<{ used: number }>();

    const draft =
      commit.draft === null
        ? null
        : await this.db
            .prepare(
              `SELECT revision, state, expires_at_ms AS expiresAtMs FROM drafts
               WHERE business_id = ? AND conversation_id = ? AND id = ?`,
            )
            .bind(businessId, lease.conversationId, commit.draft.id)
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
              OR EXISTS (SELECT 1 FROM fact_closures c WHERE c.business_id = ? AND c.fact_id = a.id)`,
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
    return { firstOutcome: used === null ? null : { type: "nothing" }, draft, deadDependencies, closesState };
  }
}
