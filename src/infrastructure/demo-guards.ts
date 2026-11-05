/**
 * The public demo's walls around the real providers. A demo store's replies are never sent to
 * WhatsApp: the demo's phone reads them from the outbox. Its photos and voice notes are our own
 * synthetic files, never a download from Meta. Its model spend is pooled under one daily cap.
 * Real stores pass straight through to the real channel, media source and spend ledger.
 */
import type {
  MediaBytes,
  MediaSource,
  MessagingChannel,
  OutgoingButtons,
  OutgoingText,
  SendResult,
  SpendLedger,
  SpendReservation,
  Tenant,
  TypingIndicator,
  TypingResult,
} from "../application/ports";
import { DEMO_DAILY_CAP_MICRO_USD, DEMO_PRESETS, DEMO_SPEND_POOL_ID, isDemoBusiness, isDemoPhone, isDemoPhoneNumberId } from "../domain/demo";

/** A demo message counts as delivered at once; it is shown on the demo's phone, not sent. */
function delivered(): SendResult {
  return { ok: true, providerMessageId: `demo.${crypto.randomUUID()}` };
}

/** Anything from a demo number, or to a demo phone, stops here. */
function isDemoMessage(message: OutgoingText): boolean {
  return isDemoPhoneNumberId(message.fromPhoneNumberId) || isDemoPhone(message.toPhone);
}

export class DemoGuardedChannel implements MessagingChannel {
  readonly configured: boolean;
  readonly maxTextChars: number;
  readonly sendButtons?: (message: OutgoingButtons) => Promise<SendResult>;

  constructor(private readonly real: MessagingChannel) {
    this.configured = real.configured;
    this.maxTextChars = real.maxTextChars;
    const sendButtons = real.sendButtons?.bind(real);
    if (sendButtons !== undefined) {
      this.sendButtons = (message) => (isDemoMessage(message) ? Promise.resolve(delivered()) : sendButtons(message));
    }
  }

  sendText(message: OutgoingText): Promise<SendResult> {
    return isDemoMessage(message) ? Promise.resolve(delivered()) : this.real.sendText(message);
  }

  showTyping(indicator: TypingIndicator): Promise<TypingResult> {
    return isDemoPhoneNumberId(indicator.fromPhoneNumberId) ? Promise.resolve({ ok: true }) : this.real.showTyping(indicator);
  }
}

/** The preset photo and voice note, bundled with the Worker. */
export interface DemoPresetFiles {
  readonly lista: ArrayBuffer;
  readonly voz: ArrayBuffer;
}

export class DemoGuardedMediaSource implements MediaSource {
  constructor(
    private readonly real: MediaSource,
    private readonly presets: DemoPresetFiles | null,
  ) {}

  async fetch(ref: { readonly providerMediaId: string; readonly phoneNumberId: string }): Promise<MediaBytes | null> {
    if (!isDemoPhoneNumberId(ref.phoneNumberId)) return this.real.fetch(ref);
    if (this.presets === null) return null;
    if (ref.providerMediaId === DEMO_PRESETS.lista.mediaId) {
      return { bytes: this.presets.lista.slice(0), contentType: DEMO_PRESETS.lista.mimeType };
    }
    if (ref.providerMediaId === DEMO_PRESETS.voz.mediaId) {
      return { bytes: this.presets.voz.slice(0), contentType: DEMO_PRESETS.voz.mimeType };
    }
    return null;
  }
}

/** Every demo store spends from one pool, capped at the demo's daily budget; real stores keep their own cap. */
export class DemoPooledSpendLedger implements SpendLedger {
  constructor(private readonly real: SpendLedger) {}

  reserve(tenant: Tenant, nowMs: number, microUsd: number, capMicroUsd: number): Promise<SpendReservation | null> {
    if (!isDemoBusiness(tenant.businessId)) return this.real.reserve(tenant, nowMs, microUsd, capMicroUsd);
    return this.real.reserve({ businessId: DEMO_SPEND_POOL_ID }, nowMs, microUsd, DEMO_DAILY_CAP_MICRO_USD);
  }

  settle(reservation: SpendReservation, actualMicroUsd: number): Promise<void> {
    return this.real.settle(reservation, actualMicroUsd);
  }
}
