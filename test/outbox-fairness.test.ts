import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Harness, harness, OUTLIVES_TEST_MS } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

// Its own file: the sweep spans every store, and this test needs a known outbox.

const DAY = 24 * 60 * 60 * 1000;
const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

describe("outbox fairness (F14)", () => {
  it("lets one sendable reply through more than a page of conversations waiting for a closed window", async () => {
    const h = harness({
      jobHandler: {
        async handle({ isNewestOfBurst }) {
          return { replies: isNewestOfBurst ? [{ body: "Para el que sí puede recibir", ttlMs: OUTLIVES_TEST_MS }] : [] };
        },
      },
    });

    // Store X: 60 members who last wrote two days ago, each with a queued reply, all older. Only a
    // conversation's oldest reply is a candidate, so it takes many conversations to fill a page.
    const xPhones = Array.from({ length: 60 }, () => newPhone());
    const x = await seedStore({ members: xPhones.map((phone) => ({ phone, role: "staff" as const })) });
    const twoDaysAgo = h.clock.now() - 2 * DAY;
    await env.DB.batch(
      x.members.flatMap((member) => {
        const conversationId = crypto.randomUUID();
        return [
          env.DB.prepare(
            `INSERT INTO conversations (id, business_id, channel_account_id, user_id, last_inbound_at_ms, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(conversationId, x.businessId, x.channelAccountId, member.userId, twoDaysAgo, twoDaysAgo),
          env.DB.prepare(
            `INSERT INTO outbound_messages (id, business_id, channel_account_id, conversation_id, seq, kind, body_text,
               dedupe_key, status, expires_at_ms, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM outbound_messages), 'reply', 'Esperando', ?,
               'waiting_window', ?, ?, ?)`,
          ).bind(
            crypto.randomUUID(),
            x.businessId,
            x.channelAccountId,
            conversationId,
            `fairness:${crypto.randomUUID()}`,
            h.clock.now() + OUTLIVES_TEST_MS,
            twoDaysAgo,
            twoDaysAgo,
          ),
        ];
      }),
    );

    // Store Y: a member writing now, whose reply is queued last.
    const yPhone = newPhone();
    const y = await seedStore({ members: [{ phone: yPhone, role: "owner" }] });
    await h.post(webhook(y.phoneNumberId, { messages: [textMessage({ from: yPhone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
    h.clock.advance(4_000);
    h.channel.configured = false;
    await h.deliver(h.takeRingsFor(y.businessId));
    h.channel.configured = true;

    await h.runCron(); // one sweep: 50 rows per page
    expect(h.sentTo(yPhone)).toEqual(["Para el que sí puede recibir"]);
    expect(h.channel.sent.filter((sent) => xPhones.includes(sent.toPhone))).toEqual([]);
  });
});
