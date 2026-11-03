/**
 * The owner saves what the store says about itself (K15). No `ConsoleAction` carries it, so this is a
 * small service of its own, owner only: one `business_info` fact resting on the member, closing the
 * one it replaces `superseded` in the same batch.
 */
import { type BusinessInfo, businessInfoKey, type BusinessInfoField, validateBusinessInfo } from "../domain/business-info";
import type { FactCommit } from "../domain/facts";
import type { MemberContext } from "./engine";
import type { OrderFactLedger } from "./engine/order-engine";
import type { CommitRunner } from "./catalog";
import type { BusinessContext, IdSource, Tenant } from "./ports";

/** What a save reads before writing: the live fact to replace, and whether this minute's key is used. */
export interface BusinessInfoStore extends BusinessContext {
  currentFact(tenant: Tenant): Promise<{ readonly factId: string; readonly info: BusinessInfo } | null>;
  keyUsed(tenant: Tenant, operationKey: string): Promise<boolean>;
}

export type RecordBusinessInfoResult =
  | { readonly type: "saved" }
  | { readonly type: "refused"; readonly reason: "not_allowed" }
  | { readonly type: "invalid"; readonly field: BusinessInfoField }
  /** Already saved this minute: nothing written. */
  | { readonly type: "duplicate" };

export class BusinessService {
  constructor(
    private readonly deps: {
      readonly store: BusinessInfoStore;
      readonly ledger: OrderFactLedger;
      readonly runner: CommitRunner;
      readonly ids: IdSource;
    },
  ) {}

  async recordBusinessInfo(member: MemberContext, input: unknown): Promise<RecordBusinessInfoResult> {
    const { store, ledger, runner, ids } = this.deps;
    if (member.role !== "owner") return { type: "refused", reason: "not_allowed" };
    const checked = validateBusinessInfo(input);
    if (!checked.ok) return { type: "invalid", field: checked.field };
    const operationKey = businessInfoKey(member.nowMs);
    if (await store.keyUsed(member, operationKey)) return { type: "duplicate" };

    const previous = await store.currentFact(member);
    const fact: FactCommit = {
      factId: ids.newId(),
      kind: "business_info",
      operationKey,
      draft: null,
      actorUserId: member.memberId,
      validFromMs: member.nowMs,
      body: checked.info,
      evidence: [{ kind: "member", refId: member.memberId, contentSha256: null }],
      dependsOn: [],
      closes: previous === null ? null : { factId: previous.factId, reason: "superseded" },
      movements: [],
    };
    await runner.run([ledger.statementsFor(member, fact, member.nowMs)]);
    return { type: "saved" };
  }
}
