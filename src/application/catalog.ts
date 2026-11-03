/**
 * The store's products and their prices on the console (K6).
 *
 * A price change is a console action, so it goes through the engine: `changePrice` asks it, then runs
 * the commits it returns. No `ConsoleAction` creates a product, so `addProduct` is a small service of
 * its own, owner only: the `products` row and the confirmed price fact are one guarded batch, so there
 * is never a product the ledger doesn't know, nor a price for a product that was never saved.
 */
import type { ActionEnvelope, ConsoleAction } from "../domain/contract/actions";
import type { Centavos } from "../domain/contract/numbers";
import type { EngineOutcome } from "../domain/contract/outcomes";
import type { FactCommit } from "../domain/facts";
import { isPrice, priceKey } from "../domain/price";
import type { Engine, MemberContext } from "./engine";
import type { OrderFactLedger } from "./engine/order-engine";
import { FactRefusedError } from "./errors";
import type { Commit, IdSource, Tenant } from "./ports";

export const PRODUCT_NAME_MAX = 120;

export interface CatalogRow {
  readonly id: string;
  readonly name: string;
  /** The live confirmed price; null is "sin precio", never zero. */
  readonly price: Centavos | null;
  /** A proposal waiting for the owner, newer than the confirmed price. */
  readonly proposed: Centavos | null;
}

export interface CatalogStore {
  list(tenant: Tenant): Promise<readonly CatalogRow[]>;
  nameTaken(tenant: Tenant, name: string): Promise<boolean>;
  /** The `products` insert, for a batch of its own with the price fact. */
  insertProduct(tenant: Tenant, product: { readonly id: string; readonly name: string; readonly nowMs: number }): Commit;
}

/** Runs commits as one guarded batch. */
export interface CommitRunner {
  run(commits: readonly Commit[]): Promise<void>;
}

export type AddProductResult =
  | { readonly type: "added"; readonly productId: string }
  | { readonly type: "refused"; readonly reason: "not_allowed" | "name" | "price" | "name_taken" };

export type ChangePriceResult = { readonly type: "outcome"; readonly outcome: EngineOutcome } | { readonly type: "not_ready" };

export class CatalogService {
  constructor(
    private readonly deps: {
      readonly catalog: CatalogStore;
      readonly ledger: OrderFactLedger;
      readonly runner: CommitRunner;
      readonly ids: IdSource;
      readonly engine: Engine | null;
    },
  ) {}

  list(tenant: Tenant): Promise<readonly CatalogRow[]> {
    return this.deps.catalog.list(tenant);
  }

  /** Owner only. Reads first: who, the name, the price, a product already named so. */
  async addProduct(member: MemberContext, input: { readonly name: string; readonly price: Centavos }): Promise<AddProductResult> {
    const { catalog, ledger, runner, ids } = this.deps;
    if (member.role !== "owner") return { type: "refused", reason: "not_allowed" };
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length === 0 || name.length > PRODUCT_NAME_MAX) return { type: "refused", reason: "name" };
    if (!isPrice(input.price)) return { type: "refused", reason: "price" };
    if (await catalog.nameTaken(member, name)) return { type: "refused", reason: "name_taken" };

    const productId = ids.newId();
    const fact: FactCommit = {
      factId: ids.newId(),
      kind: "price",
      operationKey: priceKey(productId, member.nowMs, "confirm_price"),
      draft: null,
      actorUserId: member.memberId,
      validFromMs: member.nowMs,
      body: { productId, price: input.price, status: "confirmed" },
      evidence: [{ kind: "member", refId: member.memberId, contentSha256: null }],
      dependsOn: [],
      closes: null,
      movements: [],
    };
    // One batch: the row and its price go in together, or neither does.
    await runner.run([catalog.insertProduct(member, { id: productId, name, nowMs: member.nowMs }), ledger.statementsFor(member, fact, member.nowMs)]);
    return { type: "added", productId };
  }

  /** A staff proposal or the owner's confirmation, under the key the engine derives. */
  async changePrice(
    member: MemberContext,
    productId: string,
    price: Centavos,
    type: "propose_price" | "confirm_price",
  ): Promise<ChangePriceResult> {
    const { engine, runner } = this.deps;
    if (engine === null) return { type: "not_ready" };
    const envelope: ActionEnvelope<ConsoleAction> = {
      operationKey: priceKey(productId, member.nowMs, type),
      actor: { type: "member", memberId: member.memberId, role: member.role },
      action: { type, productId, price },
    };
    const { outcome, commits } = await engine.onConsoleAction(member, envelope);
    try {
      await runner.run(commits);
    } catch (error) {
      // A race the read couldn't see (the price changed between the read and the batch): nothing was written.
      if (error instanceof FactRefusedError) return { type: "outcome", outcome: { type: "rejected", reason: "invalid_state", order: null } };
      throw error;
    }
    return { type: "outcome", outcome };
  }
}
