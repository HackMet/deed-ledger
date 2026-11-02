/**
 * A write refused because the writer is stale: its lease is gone, or the job isn't in the state
 * this lease expects. Nothing in the batch was applied. Callers stop; it is never a success.
 */
export class StaleWriteError extends Error {
  constructor(
    readonly reason: "lease_lost" | "job_state",
    message: string,
  ) {
    super(message);
  }
}

export class LeaseLostError extends StaleWriteError {
  override readonly name = "LeaseLostError";

  constructor() {
    super("lease_lost", "conversation lease is no longer held");
  }
}

export class JobConflictError extends StaleWriteError {
  override readonly name = "JobConflictError";

  constructor() {
    super("job_state", "the job is not in the state this lease expects");
  }
}

/**
 * A job's start refused because the round's snapshot is out of date: a message that sorts before
 * the job is open (it arrived after the snapshot). Nothing was written. The processor hands off, and
 * a new snapshot takes the conversation in order.
 */
export class StaleSnapshotError extends Error {
  override readonly name = "StaleSnapshotError";

  constructor() {
    super("a message that sorts before this job is open");
  }
}

/**
 * A dispatcher's write refused because its claim on the outbox row is gone: maintenance settled the
 * row, or this claim already did. Nothing in the batch was applied.
 */
export class ClaimLostError extends Error {
  override readonly name = "ClaimLostError";

  constructor() {
    super("the outbox claim is no longer held");
  }
}

/** A write that can never succeed as sent (a constraint violation): retrying won't help. */
export class PermanentWriteError extends Error {
  override readonly name = "PermanentWriteError";
}

/** A short, content-free description of an error for logs: its name, and D1's own error text. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "non_error_thrown";
  // D1 messages name constraints, never bound values. Other messages may echo input, so skip them.
  if (error.message.startsWith("D1_")) return `${error.name}: ${error.message.slice(0, 200)}`;
  return error.name;
}

/**
 * A fact refused inside its commit batch: the draft isn't the pending, unexpired revision the
 * commit pins, something it depends on is no longer live, or the fact it closes is absent, foreign or already closed. Nothing in the batch was applied.
 */
export class FactRefusedError extends Error {
  override readonly name = "FactRefusedError";

  constructor(readonly reason: "draft_not_pending" | "dependency_not_live" | "closes_not_live") {
    super(`fact refused: ${reason}`);
  }
}

/**
 * An order write refused inside its batch: the order moved since the engine read it (another
 * version, another state), or the customer opened an order meanwhile. Nothing was applied. A race,
 * never the first answer (D-42): the retry's read produces the outcome.
 */
export class OrderMovedError extends Error {
  override readonly name = "OrderMovedError";

  constructor(readonly reason: "order_moved" | "open_order_exists") {
    super(`order write refused: ${reason}`);
  }
}
