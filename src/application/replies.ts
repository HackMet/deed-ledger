/**
 * Turns what the engine decided into replies ready for the outbox, after the claim check's first
 * pass: before the save, each reply's claims are read back from the outcome it was rendered from
 * (the records it names aren't saved yet). A reply that fails goes out as the safe fixed reply,
 * and a Pendientes item is raised. The second pass runs in dispatch, right before the send.
 */
import type { CustomerNotice, EngineOutcome } from "../domain/contract/outcomes";
import {
  firstCheck,
  type RenderedReply,
  renderNotice,
  renderOutcome,
  type ReplySource,
  safeReply,
} from "../domain/replies";
import type { SavedPlace } from "../domain/place";
import type { Deps, ReplyDraft, Tenant } from "./ports";

/** A customer reply is worth sending for this long; after that it expires unsent. */
export const CUSTOMER_REPLY_TTL_MS = 60 * 60 * 1000;

/** A notice (listo, a substitute offered) stays worth sending a little longer. */
export const CUSTOMER_NOTICE_TTL_MS = 3 * 60 * 60 * 1000;

export interface ReplyContext extends Tenant {
  readonly customerId: string;
  readonly conversationId: string;
  /** The saved place the engine was given, so "¿al mismo lugar de siempre?" can echo it (#29). */
  readonly savedPlace?: SavedPlace | null;
}

/** The reply to a customer's own burst or tap, or none. It closes the burst. */
export async function replyForOutcome(
  deps: Pick<Deps, "log" | "pendientes">,
  context: ReplyContext,
  outcome: EngineOutcome,
): Promise<ReplyDraft[]> {
  const rendered = renderOutcome(outcome, context);
  if (rendered === null) return [];
  const source: ReplySource = { kind: "outcome", outcome, customerId: context.customerId };
  const checked = await checkFirst(deps, context, source, rendered);
  return [toDraft(checked, CUSTOMER_REPLY_TTL_MS, true)];
}

/** A notice for the customer's conversation, caused by someone else's action. */
export async function replyForNotice(
  deps: Pick<Deps, "log" | "pendientes">,
  context: ReplyContext,
  notice: CustomerNotice,
): Promise<ReplyDraft> {
  const rendered = renderNotice(notice.notice);
  const checked = await checkFirst(deps, context, { kind: "notice", notice }, rendered);
  return toDraft(checked, CUSTOMER_NOTICE_TTL_MS, false);
}

async function checkFirst(
  deps: Pick<Deps, "log" | "pendientes">,
  context: ReplyContext,
  source: ReplySource,
  rendered: RenderedReply,
): Promise<RenderedReply> {
  if (firstCheck(rendered.claims, source)) return rendered;
  deps.log.warn("reply_claim_blocked", {
    businessId: context.businessId,
    conversationId: context.conversationId,
    reason: "before_save",
    outcome: rendered.template,
  });
  await deps.pendientes.raise(context, {
    kind: "claim_blocked",
    stage: "before_save",
    conversationId: context.conversationId,
    outboxId: null,
    template: rendered.template,
  });
  return safeReply();
}

function toDraft(reply: RenderedReply, ttlMs: number, closesBurst: boolean): ReplyDraft {
  return {
    body: reply.body,
    ttlMs,
    ...(closesBurst ? { closesBurst } : {}),
    ...(reply.claims.length === 0 ? {} : { claims: reply.claims }),
    ...(reply.buttons.length === 0 ? {} : { buttons: reply.buttons }),
  };
}
