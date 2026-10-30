import { JobConflictError, LeaseLostError, PermanentWriteError } from "../../application/errors";
import type { BatchGuard, Lease } from "../../application/ports";

/** The database's own clock in Unix epoch milliseconds. Every lease decision uses it. */
export const DB_NOW_MS = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

/** A precondition that must hold inside the batch, and how to re-check it after a failure. */
export type Guard = BatchGuard;

/**
 * Runs statements as one D1 batch (one transaction) that applies only while `lease` is held,
 * by the database's clock, and every extra guard holds.
 */
export function fencedBatch(
  db: D1Database,
  lease: Lease,
  guards: readonly Guard[],
  statements: readonly D1PreparedStatement[],
): Promise<D1Result[]> {
  return guardedBatch(db, [leaseGuard(lease), ...guards], statements);
}

/**
 * Runs statements as one D1 batch (one transaction) that applies only while every guard holds.
 *
 * Each guard is an insert into batch_guards whose NOT NULL `ok` is the guard's value; a NULL fails
 * the whole batch. (A guarded UPDATE that matches no rows wouldn't fail, so a guard must insert.)
 * The last statement deletes the guard rows. After a failure the guards are read back in order,
 * never inferred from error text, and the first one that doesn't hold throws its error.
 */
export async function guardedBatch(
  db: D1Database,
  guards: readonly Guard[],
  statements: readonly D1PreparedStatement[],
): Promise<D1Result[]> {
  const ids = guards.map(() => crypto.randomUUID());
  const guardStatements = guards.map((guard, n) =>
    db.prepare(`INSERT INTO batch_guards (guard_id, ok) VALUES (?, (${guard.holdsSql}))`).bind(ids[n], ...guard.params),
  );
  const cleanup = db
    .prepare(`DELETE FROM batch_guards WHERE guard_id IN (${ids.map(() => "?").join(", ")})`)
    .bind(...ids);

  try {
    const results = await db.batch([...guardStatements, ...statements, cleanup]);
    return results.slice(guards.length, -1);
  } catch (error) {
    for (const guard of guards) {
      if (!(await holds(db, guard))) throw guard.error();
    }
    if (error instanceof Error && error.message.includes("SQLITE_CONSTRAINT")) {
      throw new PermanentWriteError(error.message.slice(0, 200));
    }
    throw error;
  }
}

export function leaseGuard(lease: Lease): Guard {
  return {
    holdsSql: `SELECT 1 FROM conversations
               WHERE business_id = ? AND id = ? AND lease_id = ? AND lease_until_ms > ${DB_NOW_MS}`,
    params: [lease.businessId, lease.conversationId, lease.leaseId],
    error: () => new LeaseLostError(),
  };
}

/** The job belongs to the leased conversation and is in the state the transition expects. */
export function jobGuard(lease: Lease, jobId: string, condition: string, params: readonly unknown[]): Guard {
  return {
    holdsSql: `SELECT 1 FROM inbound_messages
               WHERE business_id = ? AND conversation_id = ? AND id = ? AND (${condition})`,
    params: [lease.businessId, lease.conversationId, jobId, ...params],
    error: () => new JobConflictError(),
  };
}

export async function leaseIsHeld(db: D1Database, lease: Lease): Promise<boolean> {
  return holds(db, leaseGuard(lease));
}

async function holds(db: D1Database, guard: Guard): Promise<boolean> {
  const row = await db
    .prepare(`SELECT (${guard.holdsSql}) AS ok`)
    .bind(...guard.params)
    .first<{ ok: number | null }>();
  return row?.ok === 1;
}
