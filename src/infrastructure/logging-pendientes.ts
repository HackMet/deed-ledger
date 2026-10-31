import type { Logger, PendienteItem, Pendientes, SlowReplyPendiente, Tenant } from "../application/ports";

/**
 * Stands in for Pendientes until contract gap (c) is agreed: the item is only logged (IDs and
 * codes), not stored, so nobody sees it on the console yet.
 */
export class LoggingPendientes implements Pendientes {
  constructor(private readonly log: Logger) {}

  async raise(tenant: Tenant, item: PendienteItem | SlowReplyPendiente): Promise<void> {
    if (item.kind === "slow_reply") {
      this.log.warn("pendiente_raised", {
        businessId: tenant.businessId,
        conversationId: item.conversationId,
        inboundId: item.inboundId,
        outboxId: item.outboxId,
        reason: item.kind,
        status: item.urgency,
      });
      return;
    }
    this.log.warn("pendiente_raised", {
      businessId: tenant.businessId,
      ...(item.conversationId === null ? {} : { conversationId: item.conversationId }),
      ...(item.outboxId === null ? {} : { outboxId: item.outboxId }),
      reason: `${item.kind}:${item.stage}`,
      ...(item.template === null ? {} : { outcome: item.template }),
      ...(item.urgency === undefined ? {} : { status: item.urgency }),
    });
  }
}
