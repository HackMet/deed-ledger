/**
 * The store's one product list (K6, #40): the only writer for products, whichever engine runs.
 *
 * A product lives in two tables with one ID: `products` (the ledger's catalog, which the order engine
 * and the invoices read) and `store_products` (name, other names, "No hay", how it's sold and the
 * current price, which retrieval and the pretend engine read). Every write here touches both in one
 * guarded batch, so a product is never in one list and missing from the other:
 *
 * - Adding a product writes both rows with the same ID and, when a price is given, its confirmed
 *   price fact.
 * - A price goes through the order engine's price rule (a staff proposal, the owner's confirmation)
 *   and is recorded as a ledger fact; a confirmation also sets `store_products.price_centavos` in the
 *   same batch, and a post guard checks the two agree.
 * - Name, other names, "No hay" and how it's sold are details: a rename changes both tables' names.
 *
 * Owner only, except proposing a price. Every write is scoped to the member's store: a product ID
 * from a form only ever matches a row of that store.
 */
import type { ActionEnvelope, ConsoleAction } from "../domain/contract/actions";
import type { Centavos, DecimalString } from "../domain/contract/numbers";
import type { EngineOutcome } from "../domain/contract/outcomes";
import type { FactCommit } from "../domain/facts";
import type { SoldBy } from "../domain/planner/types";
import { isPrice, priceKey } from "../domain/price";
import { cleanProductName, MAX_OTHER_NAMES, MAX_PRODUCT_NAME, type ProductSelling, productNameKey } from "../domain/store-setup";
import type { Engine, MemberContext } from "./engine";
import type { OrderFactLedger } from "./engine/order-engine";
import { FactRefusedError, PermanentWriteError } from "./errors";
import type { Commit, IdSource, Tenant } from "./ports";

/** One name for both tables: `store_products` allows 80 letters, so that's the limit. */
export const PRODUCT_NAME_MAX = MAX_PRODUCT_NAME;

/** Products saved per batch by the paste box. */
export const PASTE_GROUP = 25;

export interface CatalogRow {
  readonly id: string;
  readonly name: string;
  /** The live confirmed price fact; null is "sin precio", never zero. */
  readonly price: Centavos | null;
  /** A proposal waiting for the owner, newer than the confirmed price. */
  readonly proposed: Centavos | null;
  /**
   * A price typed on the old Tienda screen with no price fact behind it. Shown for the owner to
   * confirm; the order engine treats it as unknown until then (no fact is ever made up for it).
   */
  readonly unconfirmed: Centavos | null;
  readonly otherNames: readonly string[];
  readonly noHay: boolean;
  readonly soldBy: SoldBy | null;
  readonly usualQuantity: DecimalString | null;
}

export interface NewProduct {
  readonly id: string;
  readonly name: string;
  readonly otherNames: readonly string[];
  readonly price: Centavos | null;
  readonly nowMs: number;
}

export interface ProductDetails {
  readonly name: string;
  readonly otherNames: readonly string[];
  /** Undefined leaves how it's sold unchanged. */
  readonly selling?: ProductSelling;
}

export interface CatalogStore {
  list(tenant: Tenant): Promise<readonly CatalogRow[]>;
  product(tenant: Tenant, productId: string): Promise<CatalogRow | null>;
  /** Names compare by `productNameKey` across both tables; `exceptId` is the product being renamed. */
  nameTaken(tenant: Tenant, name: string, exceptId?: string): Promise<boolean>;
  /** Both rows, same ID. */
  insertProduct(tenant: Tenant, product: NewProduct): Commit;
  /** The current price on `store_products`, checked after the batch's writes to equal `price`. */
  priceColumn(tenant: Tenant, product: { readonly id: string; readonly name: string }, price: Centavos, nowMs: number): Commit;
  details(tenant: Tenant, productId: string, details: ProductDetails, nowMs: number): Commit;
  noHay(tenant: Tenant, product: { readonly id: string; readonly name: string }, noHay: boolean, nowMs: number): Commit;
  remove(tenant: Tenant, productId: string): Commit;
  /** A `store_products` row the ledger's catalog doesn't have yet gets its `products` row (same ID), so the engine finds it. */
  ensureLedger(tenant: Tenant, productId: string): Promise<void>;
}

/** Runs commits as one guarded batch. */
export interface CommitRunner {
  run(commits: readonly Commit[]): Promise<void>;
}

export type AddProductResult =
  | { readonly type: "added"; readonly productId: string }
  | { readonly type: "refused"; readonly reason: "not_allowed" | "name" | "price" | "name_taken" | "other_names" };

export type ChangePriceResult = { readonly type: "outcome"; readonly outcome: EngineOutcome } | { readonly type: "not_ready" };

export type DetailsResult = "saved" | "missing" | "name_taken" | "not_allowed" | "name" | "other_names";

export type ImportResult = { readonly type: "saved" } | { readonly type: "refused"; readonly reason: "not_allowed" | "busy" };

/** The product isn't this store's (or was removed between the read and the batch): nothing was written. */
export class ProductMissingError extends Error {
  override readonly name = "ProductMissingError";
}

/** The current price on `store_products` doesn't equal the price fact the batch recorded: nothing was written. */
export class PriceColumnMismatchError extends Error {
  override readonly name = "PriceColumnMismatchError";
}

export class CatalogService {
  constructor(
    private readonly deps: {
      readonly catalog: CatalogStore;
      readonly ledger: OrderFactLedger;
      readonly runner: CommitRunner;
      readonly ids: IdSource;
      /** Decides price facts (`OrderEngine`'s K6 rule). Wired to the order engine whichever engine runs the chat. */
      readonly engine: Engine | null;
    },
  ) {}

  list(tenant: Tenant): Promise<readonly CatalogRow[]> {
    return this.deps.catalog.list(tenant);
  }

  product(tenant: Tenant, productId: string): Promise<CatalogRow | null> {
    return this.deps.catalog.product(tenant, productId);
  }

  /** Owner only. A price is optional: absent is "sin precio", never zero. */
  async addProduct(
    member: MemberContext,
    input: { readonly name: string; readonly price: Centavos | null; readonly otherNames?: readonly string[] },
  ): Promise<AddProductResult> {
    const { catalog, runner, ids } = this.deps;
    if (member.role !== "owner") return { type: "refused", reason: "not_allowed" };
    const name = typeof input.name === "string" ? cleanProductName(input.name) : null;
    if (name === null) return { type: "refused", reason: "name" };
    if (input.price !== null && !isPrice(input.price)) return { type: "refused", reason: "price" };
    const otherNames = input.otherNames ?? [];
    if (otherNames.length > MAX_OTHER_NAMES) return { type: "refused", reason: "other_names" };
    if (await catalog.nameTaken(member, name)) return { type: "refused", reason: "name_taken" };

    const productId = ids.newId();
    const commits = [
      catalog.insertProduct(member, { id: productId, name, otherNames, price: input.price, nowMs: member.nowMs }),
      ...(input.price === null ? [] : [this.confirmedPriceFact(member, productId, input.price)]),
    ];
    try {
      // One batch: both rows and the price go in together, or none of it does.
      await runner.run(commits);
    } catch (error) {
      // The same name saved by another tap between the read and the batch: the UNIQUE rule refused it.
      if (isUniqueFailure(error)) return { type: "refused", reason: "name_taken" };
      throw error;
    }
    return { type: "added", productId };
  }

  /**
   * A staff proposal or the owner's confirmation, under the key the engine derives. A confirmation
   * also sets the current price on `store_products` in the same batch.
   */
  async changePrice(
    member: MemberContext,
    productId: string,
    price: Centavos,
    type: "propose_price" | "confirm_price",
  ): Promise<ChangePriceResult> {
    const { engine, runner, catalog } = this.deps;
    if (engine === null) return { type: "not_ready" };
    if (typeof productId !== "string" || productId.length === 0 || productId.length > 64) return { type: "outcome", outcome: { type: "rejected", reason: "not_found", order: null } };
    await catalog.ensureLedger(member, productId);
    const envelope: ActionEnvelope<ConsoleAction> = {
      operationKey: priceKey(productId, member.nowMs, type),
      actor: { type: "member", memberId: member.memberId, role: member.role },
      action: { type, productId, price },
    };
    const { outcome, commits } = await engine.onConsoleAction(member, envelope);
    // Only a fresh confirmation moves the current price; a proposal, a duplicate or a refusal leaves it.
    const product = type === "confirm_price" && outcome.type === "action_saved" && commits.length > 0 ? await catalog.product(member, productId) : null;
    try {
      await runner.run(product === null ? commits : [...commits, catalog.priceColumn(member, product, price, member.nowMs)]);
    } catch (error) {
      // A race the read couldn't see (the price changed between the read and the batch): nothing was written.
      if (error instanceof FactRefusedError) return { type: "outcome", outcome: { type: "rejected", reason: "invalid_state", order: null } };
      throw error;
    }
    return { type: "outcome", outcome };
  }

  /**
   * The paste box (owner only): a new name is added with its price; a name the store already has
   * gets the price confirmed. Each group of up to `PASTE_GROUP` products is one batch (all of the
   * group lands, or none), so a long list stays inside D1's per-batch limits. Pasting the same list
   * again is safe: a product already at that price is skipped. A price already confirmed this minute
   * for that product is left as it is (same operation key).
   */
  async importPrices(member: MemberContext, items: readonly { readonly name: string; readonly price: Centavos }[]): Promise<ImportResult> {
    const { catalog, runner, ids, engine } = this.deps;
    if (member.role !== "owner") return { type: "refused", reason: "not_allowed" };
    const byKey = new Map((await catalog.list(member)).map((row) => [productNameKey(row.name), row]));
    const perProduct: Commit[][] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const name = cleanProductName(item.name);
      if (name === null || !isPrice(item.price)) continue;
      const key = productNameKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = byKey.get(key);
      if (existing === undefined) {
        const productId = ids.newId();
        perProduct.push([
          catalog.insertProduct(member, { id: productId, name, otherNames: [], price: item.price, nowMs: member.nowMs }),
          this.confirmedPriceFact(member, productId, item.price),
        ]);
        continue;
      }
      if (existing.price === item.price) continue;
      if (engine === null) return { type: "refused", reason: "busy" };
      await catalog.ensureLedger(member, existing.id);
      const decided = await engine.onConsoleAction(member, {
        operationKey: priceKey(existing.id, member.nowMs, "confirm_price"),
        actor: { type: "member", memberId: member.memberId, role: member.role },
        action: { type: "confirm_price", productId: existing.id, price: item.price },
      });
      if (decided.outcome.type !== "action_saved" || decided.commits.length === 0) continue;
      perProduct.push([...decided.commits, catalog.priceColumn(member, existing, item.price, member.nowMs)]);
    }
    for (let start = 0; start < perProduct.length; start += PASTE_GROUP) {
      try {
        await runner.run(perProduct.slice(start, start + PASTE_GROUP).flat());
      } catch (error) {
        if (error instanceof FactRefusedError || isUniqueFailure(error)) return { type: "refused", reason: "busy" };
        throw error;
      }
    }
    return { type: "saved" };
  }

  /** Name, other names and how it's sold (owner only). A rename renames it in both tables. */
  async updateDetails(member: MemberContext, productId: string, input: ProductDetails): Promise<DetailsResult> {
    const { catalog, runner } = this.deps;
    if (member.role !== "owner") return "not_allowed";
    const name = cleanProductName(input.name);
    if (name === null) return "name";
    if (input.otherNames.length > MAX_OTHER_NAMES) return "other_names";
    if ((await catalog.product(member, productId)) === null) return "missing";
    if (await catalog.nameTaken(member, name, productId)) return "name_taken";
    try {
      await runner.run([catalog.details(member, productId, { ...input, name }, member.nowMs)]);
    } catch (error) {
      if (isUniqueFailure(error)) return "name_taken";
      if (error instanceof ProductMissingError) return "missing";
      throw error;
    }
    return "saved";
  }

  /** The owner's "No hay" mark. False when the product isn't this store's. */
  async setNoHay(member: MemberContext, productId: string, noHay: boolean): Promise<boolean> {
    const { catalog, runner } = this.deps;
    if (member.role !== "owner") return false;
    const product = await catalog.product(member, productId);
    if (product === null) return false;
    try {
      await runner.run([catalog.noHay(member, product, noHay, member.nowMs)]);
    } catch (error) {
      if (error instanceof ProductMissingError) return false;
      throw error;
    }
    return true;
  }

  /**
   * Takes the product off the list (owner only): both rows, its other names, how it's sold and its
   * learned aliases. The ledger keeps its facts; old orders keep their lines' words.
   */
  async removeProduct(member: MemberContext, productId: string): Promise<boolean> {
    const { catalog, runner } = this.deps;
    if (member.role !== "owner") return false;
    if ((await catalog.product(member, productId)) === null) return false;
    await runner.run([catalog.remove(member, productId)]);
    return true;
  }

  private confirmedPriceFact(member: MemberContext, productId: string, price: Centavos): Commit {
    const fact: FactCommit = {
      factId: this.deps.ids.newId(),
      kind: "price",
      operationKey: priceKey(productId, member.nowMs, "confirm_price"),
      draft: null,
      actorUserId: member.memberId,
      validFromMs: member.nowMs,
      body: { productId, price, status: "confirmed" },
      evidence: [{ kind: "member", refId: member.memberId, contentSha256: null }],
      dependsOn: [],
      closes: null,
      movements: [],
    };
    return this.deps.ledger.statementsFor(member, fact, member.nowMs);
  }
}

const isUniqueFailure = (error: unknown): boolean => error instanceof PermanentWriteError && error.message.includes("UNIQUE");
