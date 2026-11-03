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
 *
 * Products, prices, "No hay" marks, hours and the delivery fee come from the store's own setup in
 * D1 (#40, `setup`), read per store on every call; tests and the dev console pass a static catalog
 * instead.
 */
import type { CustomerContext, Engine, EngineResult, LineMatch, MemberContext } from "../../application/engine";
import type { OrderReadingSource } from "../../application/order-reading";
import type { CatalogProduct } from "../../application/perception/matching";
import type { PlannerContext, PlannerSource } from "../../application/planner/source";
import type { TurnPlan } from "../../domain/planner/types";
import type { Commit, Tenant } from "../../application/ports";
import type { ActionEnvelope, ConsoleAction, CustomerAction } from "../../domain/contract/actions";
import type { BurstReading, PerceptionContext } from "../../domain/contract/observation";
import type { Centavos } from "../../domain/contract/numbers";
import type { Claim, PreparationCard, StoreHours } from "../../domain/contract/outcomes";
import type { StoreProduct, StoreSetup } from "../../domain/store-setup";
import { MemoryEngine, type PretendProduct, type PretendStoreSnapshot } from "./memory-engine";

/** The pretend engine's snapshot moved on since it was read: the batch saved nothing; run it again. */
export class PretendStateMovedError extends Error {
  constructor() {
    super("pretend engine state changed since it was read");
    this.name = "PretendStateMovedError";
  }
}

/** Reads one store's setup (`D1StoreSetupRepository`). */
export interface StoreSetupSource {
  read(tenant: Tenant): Promise<StoreSetup>;
}

export interface D1PretendEngineOptions {
  /** The store's own products, hours and fee, per store. When set, the static options below are ignored. */
  readonly setup?: StoreSetupSource;
  /** The products and prices the readback uses. No orders are seeded. */
  readonly catalog?: readonly PretendProduct[];
  /** Store hours as settings would hold them (#40); absent or null means unset ("te confirmo"). */
  readonly storeHours?: StoreHours | null;
  readonly deliveryFee?: Centavos | null;
}

interface Loaded {
  readonly engine: MemoryEngine;
  /** The stored version, or null when the store has no snapshot yet. */
  readonly version: number | null;
  readonly json: string;
}

export class D1PretendEngine implements Engine, OrderReadingSource, PlannerSource {
  constructor(
    private readonly db: D1Database,
    private readonly options: D1PretendEngineOptions = {},
  ) {}

  async onBurst(context: CustomerContext, reading: BurstReading, matches: readonly LineMatch[], plan?: TurnPlan): Promise<EngineResult> {
    return this.change(context, context.nowMs, (engine) => engine.onBurst(context, reading, matches, plan));
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

  async plannerContext(context: CustomerContext): Promise<PlannerContext> {
    return (await this.load(context)).engine.plannerContext(context);
  }

  async catalog(tenant: Tenant): Promise<readonly CatalogProduct[]> {
    return (await this.storeOptions(tenant)).catalog ?? [];
  }

  /** The catalog, hours and fee for this store: its setup in D1, or the static options. */
  private async storeOptions(tenant: Tenant): Promise<Omit<D1PretendEngineOptions, "setup">> {
    if (this.options.setup === undefined) return this.options;
    const setup = await this.options.setup.read(tenant);
    return { catalog: setup.products.map(pretendProduct), storeHours: setup.hours, deliveryFee: setup.deliveryFee };
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
    const [row, options] = await Promise.all([
      this.db
        .prepare(`SELECT version, state_json FROM pretend_engine_state WHERE business_id = ?`)
        .bind(tenant.businessId)
        .first<{ version: number; state_json: string }>(),
      this.storeOptions(tenant),
    ]);
    const engine = new MemoryEngine(() => [], {
      ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
      ...(options.storeHours === undefined ? {} : { storeHours: options.storeHours }),
      ...(options.deliveryFee === undefined ? {} : { deliveryFee: options.deliveryFee }),
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

/** A store product as the pretend engine sees it: "No hay" is "se_acabo"; unmarked is unknown. */
function pretendProduct(product: StoreProduct): PretendProduct {
  return {
    productId: product.productId,
    names: [product.name],
    aliases: product.otherNames,
    barcode: null,
    price: product.price,
    ...(product.noHay ? { availability: "se_acabo" as const } : {}),
    // How it's sold (L1, store_product_selling): the planner path's pounds and usual amounts.
    ...(product.soldBy === null ? {} : { soldBy: product.soldBy }),
    ...(product.usualQuantity === null ? {} : { usualQuantity: product.usualQuantity }),
  };
}
