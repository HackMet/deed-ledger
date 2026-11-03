import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { formatStoreTime } from "../src/domain/store-time";
import { D1Pendientes } from "../src/infrastructure/d1/pendientes-repository";
import { consoleLogger, randomIds, systemClock } from "../src/infrastructure/runtime";
import { whatHappened } from "../src/interfaces/http/console/pendientes";
import { csrfFor, login, send, storeWithStaff } from "./helpers/console";
import { type Harness, harness, rows } from "./helpers/harness";
import type { SeededStore } from "./helpers/seed";
import { newPhone } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

const SETTLED_MS = 4_000;

/** A customer of the store writing through the real webhook, behind the customer gate (no engine). */
function customerOf(h: Harness, store: SeededStore, phone = newPhone()) {
  return {
    phone,
    say: async (body: string) => {
      h.clock.advance(1_000);
      await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body })] }));
      h.clock.advance(SETTLED_MS);
      await h.deliver(h.takeRingsFor(store.businessId));
    },
  };
}

async function ownerAndStaff(h: Harness, store: SeededStore) {
  const owner = await login(h, store.businessId, store.members[0]!.userId);
  const staff = await login(h, store.businessId, store.members[1]!.userId);
  return { owner, staff, ownerCsrf: await csrfFor(h, owner) };
}

const openItems = (businessId: string) =>
  rows<{ id: string; kind: string }>(`SELECT id, kind FROM conversation_pendientes WHERE business_id = ? AND done_at_ms IS NULL`, businessId);

describe("Pendientes", () => {
  it("shows the owner a customer who asked for a person, with their name and the end of their number", async () => {
    const h = harness();
    const store = await storeWithStaff();
    const customer = customerOf(h, store);
    await customer.say("Hola");
    await customer.say("Quiero hablar con una persona");
    await env.DB.prepare(`UPDATE customers SET name = 'Marta Reyes', name_saved_at_ms = ? WHERE business_id = ?`).bind(h.clock.now(), store.businessId).run();

    const { owner } = await ownerAndStaff(h, store);
    const page = await (await send(h, "/console/pendientes", { cookie: owner })).text();
    expect(page).toContain("Piden hablar con vos (1)");
    expect(page).toContain("Marta Reyes");
    expect(page).toContain(`Su número termina en ${customer.phone.slice(-4)}`);
    expect(page).toContain("Pidió hablar con alguien de la tienda.");
    // Only the ending: the full number never reaches the page.
    expect(page).not.toContain(customer.phone);
  });

  it("is the owner's: staff get a refusal, pages and Listo alike", async () => {
    const h = harness();
    const store = await storeWithStaff();
    await customerOf(h, store).say("quiero hablar con una persona");
    const [item] = await openItems(store.businessId);
    const { staff } = await ownerAndStaff(h, store);
    expect((await send(h, "/console/pendientes", { cookie: staff })).status).toBe(403);
    const staffCsrf = await csrfFor(h, staff);
    expect((await send(h, "/console/pendientes/listo", { method: "POST", form: { csrf: staffCsrf, pendiente: item!.id }, cookie: staff })).status).toBe(403);
    expect(await openItems(store.businessId)).toHaveLength(1);
  });

  it("keeps one item per event: the same handoff raised again adds nothing", async () => {
    const store = await storeWithStaff();
    const board = new D1Pendientes(env.DB, randomIds, systemClock, consoleLogger);
    const item = { kind: "customer_handoff", conversationId: null as unknown as string, customerId: "c", inboundId: "in-1" } as const;
    await board.raise(store, { ...item });
    await board.raise(store, { ...item });
    expect(await openItems(store.businessId)).toHaveLength(1);
  });

  it("Listo takes it off the list; another store's owner can't touch it", async () => {
    const h = harness();
    const store = await storeWithStaff();
    const other = await storeWithStaff();
    await customerOf(h, store).say("quiero hablar con una persona");
    const [item] = await openItems(store.businessId);

    const outsider = await login(h, other.businessId, other.members[0]!.userId);
    const refused = await send(h, "/console/pendientes/listo", {
      method: "POST",
      form: { csrf: await csrfFor(h, outsider), pendiente: item!.id },
      cookie: outsider,
    });
    expect(refused.headers.get("location")).toBe("/console/pendientes?aviso=falta");
    expect(await openItems(store.businessId)).toHaveLength(1);

    const { owner, ownerCsrf } = await ownerAndStaff(h, store);
    const done = await send(h, "/console/pendientes/listo", { method: "POST", form: { csrf: ownerCsrf, pendiente: item!.id }, cookie: owner });
    expect(done.headers.get("location")).toBe("/console/pendientes?aviso=listo");
    expect(await openItems(store.businessId)).toHaveLength(0);
    const page = await (await send(h, "/console/pendientes?aviso=listo", { cookie: owner })).text();
    expect(page).toContain("Listo, ya no aparece en la lista.");
    expect(page).toContain("No hay nada pendiente.");
    const [row] = await rows<{ done_by_user_id: string }>(`SELECT done_by_user_id FROM conversation_pendientes WHERE id = ?`, item!.id);
    expect(row!.done_by_user_id).toBe(store.members[0]!.userId);
  });

  it("keeps IDs and codes only, never what the customer wrote", async () => {
    const h = harness();
    const store = await storeWithStaff();
    await customerOf(h, store).say("quiero hablar con una persona");
    const stored = JSON.stringify(await rows(`SELECT * FROM conversation_pendientes WHERE business_id = ?`, store.businessId));
    expect(stored).not.toContain("persona");
  });

  it("goes when the customer's data is deleted", async () => {
    const h = harness();
    const store = await storeWithStaff();
    const customer = customerOf(h, store);
    await customer.say("Hola");
    await customer.say("quiero hablar con una persona");
    expect(await openItems(store.businessId)).toHaveLength(1);
    await customer.say("Borren mis datos");
    await h.runCron();
    expect(await rows(`SELECT 1 FROM conversation_pendientes WHERE business_id = ?`, store.businessId)).toEqual([]);
  });
});

describe("what the owner reads", () => {
  it("says what happened in plain words, never a code", () => {
    const cases = [
      { kind: "slow_reply", detail: null, count: null },
      { kind: "customer_handoff", detail: null, count: null },
      { kind: "customer_question", detail: "price", count: 1 },
      { kind: "customer_question", detail: "availability", count: 3 },
      { kind: "customer_question", detail: "store_hours", count: 1 },
      { kind: "notice_waiting_window", detail: "order_ready", count: null },
      { kind: "notice_waiting_window", detail: "something_else", count: null },
      { kind: "claim_blocked", detail: "before_send", count: null },
    ] as const;
    for (const item of cases) {
      const text = whatHappened(item);
      expect(text, JSON.stringify(item)).toMatch(/^[A-ZÁÉÍÓÚÑ¿].+\.$/u);
      expect(text).not.toMatch(/_|price|availability|order_ready|before_send/u);
    }
    expect(whatHappened({ kind: "customer_question", detail: "availability", count: 3 })).toContain("3 productos");
  });

  it("tells the time as the store reads it (UTC-6)", () => {
    const at = Date.UTC(2026, 9, 31, 14, 5); // 8:05 a. m. in Honduras
    expect(formatStoreTime(at, at + 60_000)).toBe("8:05 a. m.");
    expect(formatStoreTime(Date.UTC(2026, 9, 31, 2, 30), at)).toBe("ayer 8:30 p. m.");
    expect(formatStoreTime(Date.UTC(2026, 9, 28, 18, 0), at)).toBe("28/10 12:00 p. m.");
  });
});
