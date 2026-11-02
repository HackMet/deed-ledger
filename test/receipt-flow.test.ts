import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { receiptHandler } from "../src/application/engine/receipt-handler";
import { randomIds } from "../src/infrastructure/runtime";
import { D1ReceiptDrafts } from "../src/infrastructure/d1/draft-store";
import { D1FactLedger, D1FactPrecheck } from "../src/infrastructure/d1/fact-ledger";
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
    jobHandler: receiptHandler({
      drafts: new D1ReceiptDrafts(env.DB),
      ids: randomIds,
      clock,
      ledger: new D1FactLedger(env.DB),
      precheck: new D1FactPrecheck(env.DB),
    }),
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

  // Typed "confirmar" carries no revision (`isConfirmation`), and the handler pins the commit to
  // the revision it just read, so this slice cannot produce a stale tap. The button path does
  // (`confirm:<order>:v<version>`, docs/contract.md) and belongs to the engine, issue #11. What is
  // testable here is the other half of the rule: when the records move between the read and the
  // batch, the guard still refuses, nothing is saved, and the retry's read answers the owner.
  it("the guard still refuses when the draft moves after the precheck: a real race saves nothing", async () => {
    const clock = new FakeClock();
    let raced = false;
    const h = harness({
      clock,
      jobHandler: receiptHandler({
        drafts: new D1ReceiptDrafts(env.DB),
        ids: randomIds,
        clock,
        ledger: new D1FactLedger(env.DB),
        // The reads come back clear, then the draft is revised before the batch runs: exactly the
        // window the guard exists for.
        precheck: {
          async read(lease, commit) {
            const reads = await new D1FactPrecheck(env.DB).read(lease, commit);
            if (!raced) {
              raced = true;
              await env.DB.prepare(`UPDATE drafts SET revision = revision + 1 WHERE business_id = ?`).bind(lease.businessId).run();
            }
            return reads;
          },
        },
      }),
    });
    const { phone, store } = await ownerStore();
    await say(h, store, imageMessage({ from: phone, id: wamid(), timestampS: nowS(h), mediaId: "m-receipt-race" }));
    await say(h, store, textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "confirmar" }));

    // G3 did not hold, so the batch rolled back: no fact, and the draft is still pending.
    expect((await ledger(store.businessId)).facts).toBe(0);
    expect(
      (await rows<{ state: string }>(`SELECT state FROM drafts WHERE business_id = ?`, store.businessId))[0]!.state,
    ).toBe("pending");
    // Nothing claimed otherwise: the owner was never told it was saved.
    expect(h.sentTo(phone).filter((body) => body.startsWith("Guardado"))).toEqual([]);
  });
});
