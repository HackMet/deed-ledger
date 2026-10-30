import type {
  Clock,
  ConversationRef,
  Doorbell,
  LogFields,
  Logger,
  MediaBytes,
  MediaSource,
  MessagingChannel,
  OutgoingText,
  SendResult,
} from "../../src/application/ports";

export class FakeClock implements Clock {
  constructor(public ms: number = Date.UTC(2026, 9, 28, 14, 0, 0)) {}
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface Ring {
  readonly conversation: ConversationRef;
  readonly delaySeconds: number;
}

/** Records rings instead of sending them; tests deliver them to the queue handler explicitly. */
export class FakeDoorbell implements Doorbell {
  rings: Ring[] = [];
  failNext = 0;

  async ring(conversation: ConversationRef, delaySeconds = 0): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("queue unavailable");
    }
    this.rings.push({ conversation: { businessId: conversation.businessId, conversationId: conversation.conversationId }, delaySeconds });
  }

  take(): Ring[] {
    const taken = this.rings;
    this.rings = [];
    return taken;
  }
}

export interface Sent extends OutgoingText {
  readonly providerMessageId: string;
}

export class FakeChannel implements MessagingChannel {
  configured = true;
  readonly maxTextChars = 4096;
  sent: Sent[] = [];
  /** Forced results, used in order before falling back to success. */
  nextResults: SendResult[] = [];
  /** Runs inside every send, before it resolves (to interleave other work with a send). */
  onSend: ((message: OutgoingText, providerMessageId: string) => Promise<void>) | undefined;

  async sendText(message: OutgoingText): Promise<SendResult> {
    const forced = this.nextResults.shift();
    if (forced !== undefined) return forced;
    const providerMessageId = `wamid.TEST-OUT-${crypto.randomUUID()}`;
    this.sent.push({ ...message, providerMessageId });
    await this.onSend?.(message, providerMessageId);
    return { ok: true, providerMessageId };
  }
}

const encoder = new TextEncoder();

export function bytes(text: string): MediaBytes {
  return { bytes: encoder.encode(text).buffer as ArrayBuffer, contentType: "image/jpeg" };
}

export class FakeMediaSource implements MediaSource {
  fetched: string[] = [];
  /** Decides each download; by default every download returns synthetic bytes. */
  respond: (providerMediaId: string, call: number) => Promise<MediaBytes | null> = async (id) =>
    bytes(`synthetic media ${id}`);

  async fetch(ref: { providerMediaId: string }): Promise<MediaBytes | null> {
    this.fetched.push(ref.providerMediaId);
    return this.respond(ref.providerMediaId, this.fetched.length);
  }
}

/** Keeps every log line, so tests can check that no content or phone number is logged. */
export class RecordingLogger implements Logger {
  lines: string[] = [];
  info(event: string, fields?: LogFields): void {
    this.lines.push(JSON.stringify({ level: "info", event, ...fields }));
  }
  warn(event: string, fields?: LogFields): void {
    this.lines.push(JSON.stringify({ level: "warn", event, ...fields }));
  }
  error(event: string, fields?: LogFields): void {
    this.lines.push(JSON.stringify({ level: "error", event, ...fields }));
  }
  events(): string[] {
    return this.lines.map((line) => (JSON.parse(line) as { event: string }).event);
  }
  fields(event: string): Array<Record<string, unknown>> {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === event);
  }
}

/** Wraps a D1 binding and records every SQL statement prepared through it. */
export function recordingDb(db: D1Database): { db: D1Database; statements: string[] } {
  const statements: string[] = [];
  const wrapped = {
    prepare(query: string) {
      statements.push(query);
      return db.prepare(query);
    },
    batch: (list: D1PreparedStatement[]) => db.batch(list),
    exec: (query: string) => {
      statements.push(query);
      return db.exec(query);
    },
  } as unknown as D1Database;
  return { db: wrapped, statements };
}

/**
 * Wraps a D1 binding so `hook` runs right after the first direct read or write (all, first, run,
 * raw) whose SQL matches, before the caller sees the result; with `times`, after each of the first
 * `times` matches. Statements stay real D1 statements, so batches still work.
 */
export function hookDb(db: D1Database, match: RegExp, hook: () => Promise<void>, times = 1): D1Database {
  let fired = 0;
  const patch = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const target = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    const bind = target.bind!.bind(statement);
    target.bind = (...values: unknown[]) => patch(bind(...values) as D1PreparedStatement, sql);
    for (const method of ["all", "first", "run", "raw"]) {
      const original = target[method]!.bind(statement);
      target[method] = async (...args: unknown[]) => {
        const result = await original(...args);
        if (fired < times && match.test(sql)) {
          fired++;
          await hook();
        }
        return result;
      };
    }
    return statement;
  };
  return {
    prepare: (query: string) => patch(db.prepare(query), query),
    batch: (list: D1PreparedStatement[]) => db.batch(list),
    exec: (query: string) => db.exec(query),
  } as unknown as D1Database;
}

/** A D1 binding whose batches fail as if D1 were unavailable. Reads still work. */
export function failingBatchDb(db: D1Database): D1Database {
  return {
    prepare: (query: string) => db.prepare(query),
    batch: async () => {
      throw new Error("D1_ERROR: simulated outage");
    },
    exec: (query: string) => db.exec(query),
  } as unknown as D1Database;
}

/** A D1 binding whose batches fail with a constraint violation, worded as D1 words it. */
export function constraintFailingDb(db: D1Database): D1Database {
  return {
    prepare: (query: string) => db.prepare(query),
    batch: async () => {
      throw new Error("D1_ERROR: CHECK constraint failed: simulated: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)");
    },
    exec: (query: string) => db.exec(query),
  } as unknown as D1Database;
}

/** A D1 binding where any write whose SQL matches fails, as if the Worker died right there. */
export function failWritesMatching(db: D1Database, match: RegExp): D1Database {
  const doomed = new WeakSet<object>();
  const track = (statement: D1PreparedStatement): D1PreparedStatement => {
    doomed.add(statement);
    const target = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    const bind = target.bind!.bind(statement);
    target.bind = (...values: unknown[]) => track(bind(...values) as D1PreparedStatement);
    target.run = async () => {
      throw new Error("D1_ERROR: simulated crash");
    };
    return statement;
  };
  return {
    prepare: (query: string) => (match.test(query) ? track(db.prepare(query)) : db.prepare(query)),
    batch: async (list: D1PreparedStatement[]) => {
      if (list.some((statement) => doomed.has(statement))) throw new Error("D1_ERROR: simulated crash");
      return db.batch(list);
    },
    exec: (query: string) => db.exec(query),
  } as unknown as D1Database;
}

/**
 * A D1 binding whose next batch, once armed, waits `ms` before D1 runs it: as if the Worker stalled
 * between building the batch and D1 executing it.
 */
export function stallingDb(db: D1Database): { db: D1Database; stallNextBatch: (ms: number) => void } {
  let stallMs = 0;
  const wrapped = {
    prepare: (query: string) => db.prepare(query),
    batch: async (list: D1PreparedStatement[]) => {
      const ms = stallMs;
      stallMs = 0;
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      return db.batch(list);
    },
    exec: (query: string) => db.exec(query),
  } as unknown as D1Database;
  return {
    db: wrapped,
    stallNextBatch: (ms: number) => {
      stallMs = ms;
    },
  };
}

/** A D1 binding whose batches wait until `open()` is called, to observe what happens meanwhile. */
export function gatedDb(db: D1Database): { db: D1Database; open: () => void; waiting: () => boolean } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = false;
  const wrapped = {
    prepare: (query: string) => db.prepare(query),
    batch: async (list: D1PreparedStatement[]) => {
      waiting = true;
      await gate;
      waiting = false;
      return db.batch(list);
    },
    exec: (query: string) => db.exec(query),
  } as unknown as D1Database;
  return { db: wrapped, open: release, waiting: () => waiting };
}
