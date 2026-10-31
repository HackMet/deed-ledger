import type { AnyPendiente, Logger, Pendientes, Tenant } from "../application/ports";

/**
 * Stands in for Pendientes until contract gap (c) is agreed: the item is only logged (IDs and
 * codes), not stored, so nobody sees it on the console yet.
 */
export class LoggingPendientes implements Pendientes {
  constructor(private readonly log: Logger) {}

  async raise(tenant: Tenant, item: AnyPendiente): Promise<void> {
    if (item.kind === "customer_question") {
      this.log.warn("pendiente_raised", {
        businessId: tenant.businessId,
        conversationId: item.conversationId,
        inboundId: item.inboundId,
        reason: item.kind,
        outcome: item.topic,
        count: item.unknown,
      });
      return;
    }
    if (item.kind === "notice_waiting_window") {
      this.log.warn("pendiente_raised", {
        businessId: tenant.businessId,
        conversationId: item.conversationId,
        outboxId: item.outboxId,
        reason: item.kind,
        outcome: item.notice,
      });
      return;
    }
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
    if (item.kind === "customer_handoff") {
      this.log.warn("pendiente_raised", {
        businessId: tenant.businessId,
        conversationId: item.conversationId,
        inboundId: item.inboundId,
        reason: item.kind,
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
