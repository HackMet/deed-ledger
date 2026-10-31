import { env } from "cloudflare:workers";
import type { CustomerContext, Engine, EngineResult, MemberContext } from "../../src/application/engine";
import type { BurstReader, CustomerContextWithName } from "../../src/application/order-handler";
import type { BatchGuard, JobHandler, Tenant } from "../../src/application/ports";
import type { ActionEnvelope, ConsoleAction } from "../../src/domain/contract/actions";
import type { Observation } from "../../src/domain/contract/observation";
import type { CustomerNotice, EngineOutcome } from "../../src/domain/contract/outcomes";
import { createOrderHandler } from "../../src/application/order-handler";
import type { Harness } from "./harness";

/**
 * Stands in for perception, with no model: each text message is one order line in its own words,
 * and "Me llamo X" is the customer's name.
 */
export const lineReader: BurstReader = {
  async read({ messages }) {
    const observations: Observation[] = messages.map((message, n) => {
      const text = message.textBody ?? "";
      const named = /^me llamo (.+)$/iu.exec(text);
      const evidence = { source: "text", message: n, start: 0, end: text.length } as const;
      if (named !== null) return { kind: "customer_name", name: named[1]!, evidence, issues: [] };
      return {
        kind: "customer_order",
        lines: [{ text, name: text, quantity: "1", unit: null, restrictedCategory: false, evidence }],
        issues: [],
      };
    });
    return { reading: { observations, calls: [] }, matches: [], pendingQuestion: null };
  },
};

/** Test-only table for the lines a burst saved. Not a migration: the engine's real tables are kercmari's. */
export async function ensureLinesTable(): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS test_burst_lines (business_id TEXT NOT NULL, job_id TEXT NOT NULL, text TEXT NOT NULL)`,
  ).run();
}

export async function savedLines(businessId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT text FROM test_burst_lines WHERE business_id = ? ORDER BY rowid`)
    .bind(businessId)
    .all<{ text: string }>();
  return results.map((row) => row.text);
}

/**
 * A fake engine whose burst saves are real commits: one row per order line, saved in the job's
 * completion batch or not at all. It asks for the name once if `askName`, and otherwise asks
 * pickup or delivery. `beforeSave` runs inside onBurst, to crash or interleave work there.
 */
export class LedgerEngine implements Engine {
  readonly contexts: CustomerContextWithName[] = [];
  beforeSave: ((context: CustomerContext) => Promise<void>) | undefined;

  constructor(private readonly options: { readonly askName?: boolean } = {}) {}

  async onBurst(context: CustomerContext, reading: Parameters<Engine["onBurst"]>[1]): Promise<EngineResult> {
    const withName = context as CustomerContextWithName;
    this.contexts.push(withName);
    await this.beforeSave?.(context);
    const lines = reading.observations.flatMap((observation) =>
      observation.kind === "customer_order" ? observation.lines.map((line) => line.text) : [],
    );
    const statements = lines.map((text) =>
      env.DB.prepare(`INSERT INTO test_burst_lines (business_id, job_id, text) VALUES (?, ?, ?)`).bind(
        context.businessId,
        context.jobId,
        text,
      ),
    );
    const askName = this.options.askName === true && withName.customerName === null && !withName.customerNameAsked;
    const outcome: EngineOutcome =
      lines.length === 0
        ? { type: "nothing" }
        : { type: "ask", question: askName ? "customer_name" : "pickup_or_delivery", line: null, order: null };
    return { outcome, notices: [], commits: statements.length === 0 ? [] : [{ guards: [], statements }] };
  }

  async onCustomerAction(): Promise<EngineResult> {
    return { outcome: { type: "nothing" }, notices: [], commits: [] };
  }

  async onConsoleAction(): Promise<EngineResult> {
    return { outcome: { type: "nothing" }, notices: [], commits: [] };
  }

  async verifyClaims(_tenant: Tenant, claims: readonly unknown[]): Promise<readonly boolean[]> {
    return claims.map(() => false);
  }

  async preparationList() {
    return [];
  }
}

/** The order handler on a harness's own repositories, with a reader. Built late: the harness makes the deps. */
export function lateOrderHandler(engine: Engine, reader: BurstReader | null = lineReader) {
  let handler: JobHandler | undefined;
  return {
    jobHandler: { handle: (input) => handler!.handle(input) } satisfies JobHandler,
    attach(h: Harness) {
      handler = createOrderHandler({
        engine,
        jobs: h.deps.jobs,
        customers: h.deps.customers,
        clock: h.clock,
        log: h.log,
        pendientes: h.deps.pendientes,
        reader,
      });
    },
  };
}

/**
 * A fake engine for console actions whose decisions are real commits: each action saves one row in
 * test_burst_lines (job_id = the operation key) behind a guard that holds unless `failGuard` is
 * set, and returns `notices` as they are, every time (no operation-key memory of its own).
 */
export class CommitEngine implements Engine {
  failGuard = false;
  notices: readonly CustomerNotice[] = [];

  async onBurst(): Promise<EngineResult> {
    return { outcome: { type: "nothing" }, notices: [], commits: [] };
  }

  async onCustomerAction(): Promise<EngineResult> {
    return { outcome: { type: "nothing" }, notices: [], commits: [] };
  }

  async onConsoleAction(context: MemberContext, envelope: ActionEnvelope<ConsoleAction>): Promise<EngineResult> {
    const guard: BatchGuard = {
      holdsSql: this.failGuard ? `SELECT NULL` : `SELECT 1`,
      params: [],
      error: () => new StaleOrderError(),
    };
    const statement = env.DB.prepare(`INSERT INTO test_burst_lines (business_id, job_id, text) VALUES (?, ?, ?)`).bind(
      context.businessId,
      envelope.operationKey,
      envelope.action.type,
    );
    const order = this.notices.find((n) => "order" in n.notice);
    return {
      outcome: { type: "action_saved", order: order !== undefined && "order" in order.notice ? order.notice.order : null },
      notices: this.notices,
      commits: [{ guards: [guard], statements: [statement] }],
    };
  }

  async verifyClaims(_tenant: Tenant, claims: readonly unknown[]): Promise<readonly boolean[]> {
    return claims.map(() => true);
  }

  async preparationList() {
    return [];
  }
}

/** What a commit guard of CommitEngine throws when it doesn't hold. */
export class StaleOrderError extends Error {
  override readonly name = "StaleOrderError";
}
