import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { receiptHandler } from "../src/application/engine/receipt-handler";
import { randomIds } from "../src/infrastructure/runtime";
import { D1ReceiptDrafts } from "../src/infrastructure/d1/draft-store";
import { D1FactLedger } from "../src/infrastructure/d1/fact-ledger";
import { ALREADY_SAVED } from "../src/domain/receipt";
import { FakeClock } from "./helpers/fakes";
import { type Harness, harness, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { imageMessage, textMessage, wamid, webhook } from "./helpers/whatsapp";

const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

function receiptFlow() {
  const clock = new FakeClock();
  return harness({
    clock,
    jobHandler: receiptHandler({ drafts: new D1ReceiptDrafts(env.DB), ids: randomIds, clock, ledger: new D1FactLedger(env.DB) }),
  });
}

async function ownerStore() {
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  return { phone, store };
}

/** Delivers one owner message and runs its job to completion. */
async function say(h: Harness, store: { phoneNumberId: string }, message: unknown) {
  await h.post(webhook(store.phoneNumberId, { messages: [message] }));
  h.clock.advance(4_000);
  await h.deliver();
}

async function ledger(businessId: string) {
  const count = async (table: string) =>
    (await rows<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE business_id = ?`, businessId))[0]!.n;
  return {
    facts: await count("facts"),
    movements: await count("stock_movements"),
    balances: (
      await rows<{ name: string; qty_milli: number }>(
        `SELECT p.canonical_name AS name, b.qty_milli FROM stock_balances b
         JOIN products p ON p.business_id = b.business_id AND p.id = b.product_id
         WHERE b.business_id = ? ORDER BY p.canonical_name`,
        businessId,
      )
    ).map((row) => [row.name, row.qty_milli]),
  };
}

describe("a receipt photo becomes a draft, and 'confirmar' saves it once", () => {
  it("proposes a draft from the photo, then one fact, one 'Guardado' reply and the stock", async () => {
    const h = receiptFlow();
    const { phone, store } = await ownerStore();

    await say(h, store, imageMessage({ from: phone, id: wamid(), timestampS: nowS(h), mediaId: "m-receipt" }));
    expect(await ledger(store.businessId)).toEqual({ facts: 0, movements: 0, balances: [] });
    const [draft] = await rows<{ state: string; revision: number }>(`SELECT state, revision FROM drafts WHERE business_id = ?`, store.businessId);
    expect(draft).toEqual({ state: "pending", revision: 1 });
    const [proposal] = h.sentTo(phone);
    expect(proposal).toContain("¿La registro? Confirmar / Corregir / Cancelar");
    expect(proposal).not.toMatch(/\d\s?%|confianza/i);

    await say(h, store, textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Confirmar" }));

    expect(await ledger(store.businessId)).toEqual({
      facts: 1,
      movements: 2,
      balances: [
        ["Agua Cristal 600 ml", 24_000],
        ["Coca-Cola 600 ml", 12_000],
      ],
    });
    const saved = h.sentTo(phone).filter((body) => body.startsWith("Guardado:"));
    expect(saved).toEqual(["Guardado: factura de Distribuidora La Ceiba.\n- 12 × Coca-Cola 600 ml (L 15.00 c/u)\n- 24 × Agua Cristal 600 ml (L 6.00 c/u)"]);
    const [fact] = await rows<{ draft_revision: number; actor_user_id: string }>(
      `SELECT draft_revision, actor_user_id FROM facts WHERE business_id = ?`,
      store.businessId,
    );
    expect(fact).toEqual({ draft_revision: 1, actor_user_id: store.members[0]!.userId });
    expect(
      (await rows<{ state: string }>(`SELECT state FROM drafts WHERE business_id = ?`, store.businessId))[0]!.state,
    ).toBe("committed");
  });

  it("a redelivered 'confirmar' writes no second fact and at most one 'Guardado'", async () => {
    const h = receiptFlow();
    const { phone, store } = await ownerStore();
    await say(h, store, imageMessage({ from: phone, id: wamid(), timestampS: nowS(h), mediaId: "m-receipt-2" }));

    const confirm = textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "confirmar" });
    await say(h, store, confirm);
    const afterFirst = await ledger(store.businessId);
    expect(afterFirst.facts).toBe(1);

    // The provider delivers the same message again, then the owner taps again as a new message.
    await say(h, store, confirm);
    await say(h, store, textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "confirmar" }));

    expect(await ledger(store.businessId)).toEqual(afterFirst);
    expect(h.sentTo(phone).filter((body) => body.startsWith("Guardado")).length).toBe(1);
    // The second tap is answered from the stored fact, not by another attempt to save.
    expect(h.sentTo(phone).filter((body) => body === ALREADY_SAVED).length).toBe(1);
  });
});
