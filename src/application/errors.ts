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
 * A reading's save refused because a message it used was used by another reading already. Nothing
 * was saved; a retry reads the burst again without that message.
 */
export class BurstAlreadyReadError extends Error {
  override readonly name = "BurstAlreadyReadError";

  constructor() {
    super("a message of this burst was already read");
  }
}

/** A burst with more unread messages than one reading may take. Nothing is read or dropped. */
export class BurstTooLargeError extends Error {
  override readonly name = "BurstTooLargeError";

  constructor() {
    super("too many unread messages for one reading");
  }
}

/** A customer commit refused because the customer isn't the store's. Nothing was saved. */
export class CustomerNotFoundError extends Error {
  override readonly name = "CustomerNotFoundError";

  constructor() {
    super("no such customer in this store");
  }
}

/**
 * A burst couldn't be read: the store's daily model budget is spent, the provider refused or failed,
 * or the output didn't fit the schema. Nothing was read or saved; the processor retries the job and,
 * after its last attempt, sends the honest failure reply.
 */
export class ReadingFailedError extends Error {
  override readonly name = "ReadingFailedError";

  constructor(readonly reason: "spend_cap" | "rejected" | "unavailable" | "invalid_output") {
    super(`the burst could not be read: ${reason}`);
  }
}

/** A console notice's conversation isn't the store's (or is gone): the action saves nothing. */
export class NoticeConversationMissingError extends Error {
  override readonly name = "NoticeConversationMissingError";

  constructor() {
    super("the notice's conversation is not in this store");
  }
}
