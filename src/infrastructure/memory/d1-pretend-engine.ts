/**
 * The pretend engine with its state in D1, so a deployed demo works when the queue consumer
 * (customer messages) and the console (staff taps) run in different isolates. Stand-in until the
 * real engine lands; turned on with PRETEND_ENGINE=1.
 *
 * Each store's state is one JSON snapshot of the in-memory pretend engine (migration 0016). Every
 * call loads the snapshot, runs `MemoryEngine` on it, and, when the state changed, returns the new
 * snapshot as a `Commit`: written in the caller's batch (the job's completion batch, or the console
 * action's batch) under a guard that the version it was read at is still the stored one. So the
 * snapshot lands with the job's replies and read marks, or not at all; and when two calls race,
 * the second batch fails loudly (`PretendStateMovedError`) and nothing of it is saved. The caller's
 * retry path runs it again on the newer snapshot: a customer's job is deferred and retried, a staff
 * tap shows "no se guardó" and is tapped again. No update is lost.
 *
 * The store always comes from the context the caller built from the lease or the session.
 */
import type { CustomerContext, Engine, EngineResult, LineMatch, MemberContext } from "../../application/engine";
import type { OrderReadingSource } from "../../application/order-reading";
import type { CatalogProduct } from "../../application/perception/matching";
import type { Commit, Tenant } from "../../application/ports";
import type { ActionEnvelope, ConsoleAction, CustomerAction } from "../../domain/contract/actions";
import type { BurstReading, PerceptionContext } from "../../domain/contract/observation";
import type { Claim, PreparationCard, StoreHours } from "../../domain/contract/outcomes";
import { MemoryEngine, type PretendProduct, type PretendStoreSnapshot } from "./memory-engine";

/** The pretend engine's snapshot moved on since it was read: the batch saved nothing; run it again. */
export class PretendStateMovedError extends Error {
  constructor() {
    super("pretend engine state changed since it was read");
    this.name = "PretendStateMovedError";
  }
}

export interface D1PretendEngineOptions {
  /** The products and prices the readback uses. No orders are seeded. */
  readonly catalog?: readonly PretendProduct[];
  /** Store hours as settings would hold them (#40); absent or null means unset ("te confirmo"). */
  readonly storeHours?: StoreHours | null;
}

interface Loaded {
  readonly engine: MemoryEngine;
  /** The stored version, or null when the store has no snapshot yet. */
  readonly version: number | null;
  readonly json: string;
}

export class D1PretendEngine implements Engine, OrderReadingSource {
  constructor(
    private readonly db: D1Database,
    private readonly options: D1PretendEngineOptions = {},
  ) {}

  async onBurst(context: CustomerContext, reading: BurstReading, matches: readonly LineMatch[]): Promise<EngineResult> {
    return this.change(context, context.nowMs, (engine) => engine.onBurst(context, reading, matches));
  }

  async onCustomerAction(context: CustomerContext, envelope: ActionEnvelope<CustomerAction>): Promise<EngineResult> {
    return this.change(context, context.nowMs, (engine) => engine.onCustomerAction(context, envelope));
  }

  async onConsoleAction(context: MemberContext, envelope: ActionEnvelope<ConsoleAction>): Promise<EngineResult> {
    return this.change(context, context.nowMs, (engine) => engine.onConsoleAction(context, envelope));
  }

  async verifyClaims(tenant: Tenant, claims: readonly Claim[]): Promise<readonly boolean[]> {
    return (await this.load(tenant)).engine.verifyClaims(tenant, claims);
  }

  async preparationList(tenant: Tenant): Promise<readonly PreparationCard[]> {
    return (await this.load(tenant)).engine.preparationList(tenant);
  }

  async perceptionContext(context: CustomerContext): Promise<PerceptionContext> {
    return (await this.load(context)).engine.perceptionContext(context);
  }

  async catalog(): Promise<readonly CatalogProduct[]> {
    return this.options.catalog ?? [];
  }

  /** Runs a change on the stored state and returns, with its result, the commit that saves it. */
  private async change(tenant: Tenant, nowMs: number, run: (engine: MemoryEngine) => Promise<EngineResult>): Promise<EngineResult> {
    const loaded = await this.load(tenant);
    const result = await run(loaded.engine);
    const json = JSON.stringify(loaded.engine.exportStore(tenant));
    if (json === loaded.json) return result; // a duplicate or a refusal: nothing to save
    return { ...result, commits: [...result.commits, this.saveCommit(tenant, loaded.version, json, nowMs)] };
  }

  private async load(tenant: Tenant): Promise<Loaded> {
    const row = await this.db
      .prepare(`SELECT version, state_json FROM pretend_engine_state WHERE business_id = ?`)
      .bind(tenant.businessId)
      .first<{ version: number; state_json: string }>();
    const engine = new MemoryEngine(() => [], {
      ...(this.options.catalog === undefined ? {} : { catalog: this.options.catalog }),
      ...(this.options.storeHours === undefined ? {} : { storeHours: this.options.storeHours }),
    });
    if (row !== null) engine.importStore(tenant, JSON.parse(row.state_json) as PretendStoreSnapshot);
    return { engine, version: row?.version ?? null, json: JSON.stringify(engine.exportStore(tenant)) };
  }

  /** Writes the snapshot only while the version it was read at is still the stored one. */
  private saveCommit(tenant: Tenant, version: number | null, json: string, nowMs: number): Commit {
    const error = () => new PretendStateMovedError();
    if (version === null) {
      return {
        guards: [
          {
            holdsSql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pretend_engine_state WHERE business_id = ?)`,
            params: [tenant.businessId],
            error,
          },
        ],
        statements: [
          this.db
            .prepare(`INSERT INTO pretend_engine_state (business_id, version, state_json, updated_at_ms) VALUES (?, 1, ?, ?)`)
            .bind(tenant.businessId, json, nowMs),
        ],
      };
    }
    return {
      guards: [
        {
          holdsSql: `SELECT 1 FROM pretend_engine_state WHERE business_id = ? AND version = ?`,
          params: [tenant.businessId, version],
          error,
        },
      ],
      statements: [
        this.db
          .prepare(
            `UPDATE pretend_engine_state SET version = version + 1, state_json = ?, updated_at_ms = ?
             WHERE business_id = ? AND version = ?`,
          )
          .bind(json, nowMs, tenant.businessId, version),
      ],
    };
  }
}
