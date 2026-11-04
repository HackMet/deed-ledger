import { JobConflictError, LeaseLostError, PermanentWriteError } from "../../application/errors";
import type { BatchGuard, Lease } from "../../application/ports";

/** The database's own clock in Unix epoch milliseconds. Every lease decision uses it. */
export const DB_NOW_MS = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

/** A precondition that must hold inside the batch, and how to re-check it after a failure. */
export type Guard = BatchGuard;

/** Guard rows deleted per statement, under D1's limit of 100 bound values per statement. */
export const GUARD_CLEANUP_CHUNK = 90;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

/**
 * Runs statements as one D1 batch (one transaction) that applies only while `lease` is held,
 * by the database's clock, and every extra guard holds.
 */
export function fencedBatch(
  db: D1Database,
  lease: Lease,
  guards: readonly Guard[],
  statements: readonly D1PreparedStatement[],
  post: readonly Guard[] = [],
): Promise<D1Result[]> {
  return guardedBatch(db, [leaseGuard(lease), ...guards], statements, post);
}

/**
 * Runs statements as one D1 batch (one transaction) that applies only while every guard holds.
 *
 * Each guard is an insert into batch_guards whose NOT NULL `ok` is the guard's value; a NULL fails
 * the whole batch. (A guarded UPDATE that matches no rows wouldn't fail, so a guard must insert.)
 * `guards` are inserted before the statements; `post` guards after them, so they can check what the
 * statements wrote, and a failing post guard rolls the statements back with it.
 * The last statement deletes the guard rows. After a failure the guards are read back in order
 * (pre, then post), never inferred from error text, and the first one that doesn't hold throws its error.
 */
export async function guardedBatch(
  db: D1Database,
  guards: readonly Guard[],
  statements: readonly D1PreparedStatement[],
  post: readonly Guard[] = [],
): Promise<D1Result[]> {
  const all = [...guards, ...post];
  const ids = all.map(() => crypto.randomUUID());
  const insertGuard = (guard: Guard, n: number) =>
    db.prepare(`INSERT INTO batch_guards (guard_id, ok) VALUES (?, (${guard.holdsSql}))`).bind(ids[n], ...guard.params);
  const guardStatements = guards.map((guard, n) => insertGuard(guard, n));
  const postStatements = post.map((guard, n) => insertGuard(guard, guards.length + n));
  // D1 binds at most 100 values per statement, so a batch with many guards cleans up in chunks.
  const cleanup = chunks(ids, GUARD_CLEANUP_CHUNK).map((chunk) =>
    db.prepare(`DELETE FROM batch_guards WHERE guard_id IN (${chunk.map(() => "?").join(", ")})`).bind(...chunk),
  );

  try {
    const results = await db.batch([...guardStatements, ...statements, ...postStatements, ...cleanup]);
    return results.slice(guards.length, guards.length + statements.length);
  } catch (error) {
    for (const guard of all) {
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
