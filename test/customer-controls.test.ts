import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MEDIA_RECHECK_AFTER_PURGE_MS, purgeRequestedDeletions } from "../src/application/customer-deletion";
import { gatedHandler } from "../src/application/customer-gate";
import { createOrderHandler } from "../src/application/order-handler";
import { placeholderHandler } from "../src/application/placeholder-handler";
import type { JobHandler, MediaEraser } from "../src/application/ports";
import { RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import {
  controlWord,
  DELETION_CONFIRMED,
  handoffLine,
  introduction,
  RESUMED,
  STOPPED_REMINDER,
  stopConfirmed,
} from "../src/domain/customer-controls";
import { MemoryEngine } from "../src/infrastructure/memory/memory-engine";
import { LedgerEngine } from "./helpers/engines";
import { hookDb } from "./helpers/fakes";
import { type Harness, harness, rows, testEnv } from "./helpers/harness";
import { newPhone, seedIntroducedCustomer, seedStore, type SeededStore } from "./helpers/seed";
import { imageMessage, textMessage, wamid, webhook } from "./helpers/whatsapp";

const SETTLED_MS = 4_000;
const BASE_URL = "https://tienda.test";
const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);
const VOICE = { storeName: "Punto de prueba", ownerName: "Johan", privacyUrl: `${BASE_URL}/privacidad` };

async function storeWithOwner(name = "Punto de prueba"): Promise<SeededStore> {
  const store = await seedStore({ name, members: [{ phone: newPhone(), role: "owner" }] });
  await env.DB.prepare(`UPDATE users SET display_name = 'Johan Pérez' WHERE id = ?`).bind(store.members[0]!.userId).run();
  return store;
}

/** The real Worker with the pretend engine and the gate, as production wires it once an engine exists. */
function gatedHarness(jobHandler?: JobHandler) {
  return harness({
    engine: new MemoryEngine(() => []),
    env: testEnv({ PUBLIC_BASE_URL: BASE_URL } as unknown as Partial<Env>),
    ...(jobHandler === undefined ? {} : { jobHandler }),
  });
}

function customerOf(h: Harness, store: SeededStore, phone = newPhone()) {
  const post = async (message: unknown) => {
    await h.post(webhook(store.phoneNumberId, { messages: [message] }));
    h.clock.advance(SETTLED_MS);
    await h.deliver(h.takeRingsFor(store.businessId));
  };
  return {
    phone,
    say: (body: string, id = wamid()) => {
      h.clock.advance(1_000);
      return post(textMessage({ from: phone, id, timestampS: nowS(h), body }));
    },
    photo: (mediaId: string) => {
      h.clock.advance(1_000);
      return post(imageMessage({ from: phone, id: wamid(), timestampS: nowS(h), mediaId }));
    },
    sent: () => h.sentTo(phone),
    row: async () =>
      (
        await rows<{
          id: string;
          phone: string | null;
          name: string | null;
          stopped_at_ms: number | null;
          deletion_requested_at_ms: number | null;
          deleted_at_ms: number | null;
        }>(
          `SELECT id, phone, name, stopped_at_ms, deletion_requested_at_ms, deleted_at_ms FROM customers
           WHERE business_id = ? AND (phone = ? OR id = (SELECT id FROM customers WHERE business_id = ? AND phone = ?))`,
          store.businessId,
          phone,
          store.businessId,
          phone,
        )
      )[0],
  };
}

describe("control words are decided by code from the typed text", () => {
  it("recognizes ALTO and SEGUIR alone, in any case, accent or punctuation", () => {
    for (const text of ["ALTO", "alto", "¡Alto!", "  Álto. ", "STOP"]) expect(controlWord(text)).toBe("stop");
    for (const text of ["SEGUIR", "seguir", "Seguír!"]) expect(controlWord(text)).toBe("resume");
    for (const text of ["alto el arroz", "2 alto", "un alto de cajas", "seguir con el pedido", ""]) {
      expect(controlWord(text)).toBeNull();
    }
    expect(controlWord(null)).toBeNull();
  });

  it("recognizes a request to talk to a person", () => {
    for (const text of ["Quiero hablar con Johan", "quiero hablar con una persona", "Necesito hablar con el dueño", "hablar con alguien de la tienda"]) {
      expect(controlWord(text)).toBe("handoff");
    }
    expect(controlWord("quiero 2 libras de arroz y hablar con Johan después de que me lo traigan")).toBeNull();
  });

  it("takes only an explicit deletion request, never a message that mentions data", () => {
    for (const text of ["Borren mis datos", "BORRAR MIS DATOS", "borrá mis datos por favor", "Quiero que eliminen todos mis datos", "por favor eliminen mi información"]) {
      expect(controlWord(text)).toBe("delete");
    }
    for (const text of [
      "¿Borran mis datos si cancelo?",
      "borren mis datos?",
      "no borren mis datos",
      "mis datos están bien",
      "le mandé mis datos para la entrega",
      "borren mis datos de la entrega y pongan esta dirección",
      "cómo borro mis datos",
    ]) {
      expect(controlWord(text)).not.toBe("delete");
    }
  });
});

describe("the first message", () => {
  it("says it's the store's assistant, links the privacy notice, and explains ALTO and how to reach Johan", () => {
    const intro = introduction(VOICE);
    expect(intro).toContain("asistente automático de Punto de prueba");
    expect(intro).toContain("No soy Johan ni una persona");
    expect(intro).toContain(`${BASE_URL}/privacidad`);
    expect(intro).toContain("escribí ALTO");
    expect(intro).toContain("escribí: quiero hablar con Johan");
    // Without a public URL the link is left out rather than broken; without an owner name, "una persona".
    const bare = introduction({ storeName: "X", ownerName: null, privacyUrl: null });
    expect(bare).not.toContain("http");
    expect(bare).toContain("quiero hablar con una persona");
  });

  it("goes first in a new customer's first reply, once", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const c = customerOf(h, store);
    await c.say("Hola, buenas");
    expect(c.sent()).toEqual([introduction(VOICE), RECEIVED_PLACEHOLDER]);
    await c.say("¿Tienen arroz?");
    expect(c.sent()).toEqual([introduction(VOICE), RECEIVED_PLACEHOLDER, RECEIVED_PLACEHOLDER]);
    // Logs carry IDs only.
    expect(h.log.lines.join("\n")).not.toContain(c.phone);
    expect(h.log.lines.join("\n")).not.toContain("buenas");
  });

  it("comes first even when the first message is ALTO, and the stop holds", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const c = customerOf(h, store);
    await c.say("ALTO");
    expect(c.sent()).toEqual([introduction(VOICE), stopConfirmed(VOICE)]);
    expect((await c.row())!.stopped_at_ms).not.toBeNull();
    // Introduced once: the next message gets only the reminder.
    await c.say("hola?");
    expect(c.sent()).toEqual([introduction(VOICE), stopConfirmed(VOICE), STOPPED_REMINDER]);
  });

  it("comes first even when the first message asks to delete their data", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const c = customerOf(h, store);
    await c.say("Borren mis datos");
    expect(c.sent()).toEqual([introduction(VOICE), DELETION_CONFIRMED]);
    expect((await c.row())!.deletion_requested_at_ms).not.toBeNull();
  });

  it("comes first even when the first message asks for Johan, once", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const c = customerOf(h, store);
    await c.say("quiero hablar con Johan");
    await c.say("Hola");
    expect(c.sent()).toEqual([introduction(VOICE), handoffLine(VOICE), RECEIVED_PLACEHOLDER]);
  });

  it("serves the privacy notice publicly, in Spanish", async () => {
    const h = gatedHarness();
    const response = await h.get("/privacidad");
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('lang="es"');
    for (const part of ["asistente automático", "ALTO", "SEGUIR", "borren mis datos", "Meta", "Cloudflare"]) expect(page).toContain(part);
  });
});

describe("ALTO", () => {
  it("stops replies already queued: dispatch sends only the stop's own answer", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const c = customerOf(h, store);
    h.channel.configured = false; // nothing goes out yet: the intro and the placeholder stay queued
    await c.say("Hola");
    await c.say("¡ALTO!");
    expect(c.sent()).toEqual([]);

    h.channel.configured = true;
    await h.runCron();
    await h.runCron();
    expect(c.sent()).toEqual([stopConfirmed(VOICE)]);
    const skipped = await rows<{ status: string; last_error: string | null }>(
      `SELECT o.status, o.last_error FROM outbound_messages o JOIN conversations cv ON cv.id = o.conversation_id
       WHERE o.business_id = ? AND cv.customer_id = ? AND o.kind = 'reply' ORDER BY o.seq`,
      store.businessId,
      (await c.row())!.id,
    );
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((row) => row.status === "failed")).toBe(true);
    expect(skipped[0]!.last_error).toBe("customer_stopped");
  });

  it("stops future automated messages; writing again doesn't resume, it reminds once", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const c = customerOf(h, store);
    await c.say("Hola");
    await c.say("alto");
    const before = c.sent().length;

    await c.say("2 libras de arroz");
    await c.say("y un aceite");
    expect(c.sent().slice(before)).toEqual([STOPPED_REMINDER]);
    expect((await c.row())!.stopped_at_ms).not.toBeNull();

    // An automated row queued later by anything else (an engine notice) is not sent either.
    const conversation = (await rows<{ id: string; channel_account_id: string }>(
      `SELECT id, channel_account_id FROM conversations WHERE business_id = ? AND customer_id = ?`,
      store.businessId,
      (await c.row())!.id,
    ))[0]!;
    await env.DB.prepare(
      `INSERT INTO outbound_messages (id, business_id, channel_account_id, conversation_id, seq, kind, body_text,
         dedupe_key, status, expires_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM outbound_messages), 'notice', 'Tu pedido está listo.',
         ?, 'pending', ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), store.businessId, conversation.channel_account_id, conversation.id, `test:${crypto.randomUUID()}`,
        h.clock.now() + 3_600_000, h.clock.now(), h.clock.now())
      .run();
    await h.runCron();
    expect(c.sent().slice(before)).toEqual([STOPPED_REMINDER]);

    // The messages written while stopped were marked read: resuming never acts on them.
    const unread = await rows(
      `SELECT i.id FROM inbound_messages i
       WHERE i.business_id = ? AND i.conversation_id = ?
         AND NOT EXISTS (SELECT 1 FROM burst_reads r WHERE r.business_id = i.business_id AND r.inbound_message_id = i.id)`,
      store.businessId,
      conversation.id,
    );
    expect(unread).toEqual([]);
  });

  it("is decided by code, whatever the model read: a reading of stop/delete changes nothing", async () => {
    const store = await storeWithOwner();
    let handler: JobHandler | undefined;
    const h = gatedHarness({ handle: (input) => handler!.handle(input) });
    handler = createOrderHandler({
      engine: new LedgerEngine(),
      jobs: h.deps.jobs,
      customers: h.deps.customers,
      clock: h.clock,
      log: h.log,
      pendientes: h.deps.pendientes,
      reader: {
        read: async () => ({
          reading: { observations: [{ kind: "stop", deleteRequested: true, issues: [] }], calls: [] },
          matches: [],
          pendingQuestion: null,
        }),
      },
      gate: { controls: h.deps.customerControls, jobs: h.deps.jobs, pendientes: h.deps.pendientes, clock: h.clock, log: h.log, privacyUrl: null },
    });
    const c = customerOf(h, store);
    await c.say("Ya no me escriban y borren todo lo mío, gracias");
    const row = (await c.row())!;
    expect(row.stopped_at_ms).toBeNull();
    expect(row.deletion_requested_at_ms).toBeNull();
  });
});

describe("without an engine (the placeholder answers)", () => {
  const plainHarness = () => harness({ env: testEnv({ PUBLIC_BASE_URL: BASE_URL } as unknown as Partial<Env>) });

  it("introduces, stops on ALTO, reminds once and resumes on SEGUIR", async () => {
    const store = await storeWithOwner();
    const h = plainHarness();
    const c = customerOf(h, store);
    await c.say("Hola");
    expect(c.sent()).toEqual([introduction(VOICE), RECEIVED_PLACEHOLDER]);
    await c.say("ALTO");
    await c.say("2 libras de arroz");
    await c.say("y un aceite");
    expect(c.sent().slice(2)).toEqual([stopConfirmed(VOICE), STOPPED_REMINDER]);
    await c.say("SEGUIR");
    await c.say("2 libras de arroz");
    expect(c.sent().slice(4)).toEqual([RESUMED, RECEIVED_PLACEHOLDER]);
  });

  it("raises the handoff and deletes on request", async () => {
    const store = await storeWithOwner();
    const h = plainHarness();
    const c = customerOf(h, store);
    await c.say("Hola");
    await c.say("Quiero hablar con Johan");
    expect(c.sent().at(-1)).toBe(handoffLine(VOICE));
    expect(h.log.fields("pendiente_raised").filter((line) => line.businessId === store.businessId)).toHaveLength(1);

    const id = (await c.row())!.id;
    await c.say("Borren mis datos");
    expect(c.sent().at(-1)).toBe(DELETION_CONFIRMED);
    await h.runCron();
    const gone = (await rows<{ phone: string | null; deleted_at_ms: number | null }>(`SELECT phone, deleted_at_ms FROM customers WHERE id = ?`, id))[0]!;
    expect(gone.phone).toBeNull();
    expect(gone.deleted_at_ms).not.toBeNull();
  });
});

describe("ALTO while a job is running", () => {
  it("the running job's reply is never sent: only the stop's answer goes out", async () => {
    const store = await storeWithOwner();
    const phone = newPhone();
    await seedIntroducedCustomer(store, phone);
    let h!: Harness;
    let stopSent = false;
    h = gatedHarness({
      handle: async (input) => {
        if (!stopSent) {
          // The customer types ALTO while this job (their earlier message) is being handled.
          stopSent = true;
          await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "ALTO" })] }));
        }
        return gatedHandler(gate(h), placeholderHandler).handle(input);
      },
    });
    const c = customerOf(h, store, phone);
    await c.say("2 libras de arroz");
    expect(stopSent).toBe(true);
    expect(c.sent()).toEqual([]);

    h.clock.advance(SETTLED_MS);
    await h.deliver(h.takeRingsFor(store.businessId));
    await h.runCron();
    expect(c.sent()).toEqual([stopConfirmed(VOICE)]);
    // Nothing queued for them is left to go out later.
    const pending = await rows(
      `SELECT o.id FROM outbound_messages o JOIN conversations cv ON cv.id = o.conversation_id
       WHERE o.business_id = ? AND cv.customer_id = ? AND o.status IN ('pending', 'sending', 'waiting_window')`,
      store.businessId,
      (await c.row())!.id,
    );
    expect(pending).toEqual([]);
  });
});

describe("ALTO while a job is running, when its reply is written", () => {
  it("a reply the job wrote but hadn't sent before the stop was saved is not sent", async () => {
    const store = await storeWithOwner();
    const phone = newPhone();
    await seedIntroducedCustomer(store, phone);
    let h!: Harness;
    let stopSent = false;
    h = gatedHarness({
      handle: async (input) => {
        if (!stopSent) {
          stopSent = true;
          await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "ALTO" })] }));
          // Not a burst-closing reply (like the answer to a button tap): it is written even though ALTO arrived.
          return { replies: [{ body: "Listo, anotado.", ttlMs: 3_600_000 }] };
        }
        return gatedHandler(gate(h), placeholderHandler).handle(input);
      },
    });
    const c = customerOf(h, store, phone);
    h.channel.configured = false; // the reply is queued, not sent, until after the stop is saved
    await c.say("Confirmar");
    h.clock.advance(SETTLED_MS);
    await h.deliver(h.takeRingsFor(store.businessId));
    expect((await c.row())!.stopped_at_ms).not.toBeNull();

    h.channel.configured = true;
    await h.runCron();
    await h.runCron();
    expect(c.sent()).toEqual([stopConfirmed(VOICE)]);
  });
});

function gate(h: Harness) {
  return {
    controls: h.deps.customerControls,
    jobs: h.deps.jobs,
    pendientes: h.deps.pendientes,
    clock: h.clock,
    log: h.log,
    privacyUrl: VOICE.privacyUrl,
  };
}

describe("SEGUIR", () => {
  it("resumes a stopped customer; their next message is answered again", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const c = customerOf(h, store);
    await c.say("Hola");
    await c.say("ALTO");
    await c.say("Seguir");
    expect(c.sent().at(-1)).toBe(RESUMED);
    expect((await c.row())!.stopped_at_ms).toBeNull();
    await c.say("Quiero 2 libras de arroz");
    expect(c.sent().at(-1)).toBe(RECEIVED_PLACEHOLDER);
  });
});

describe("quiero hablar con Johan", () => {
  it("raises a Pendientes item and sends one fixed line", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const c = customerOf(h, store);
    await c.say("Hola");
    const before = c.sent().length;
    await c.say("Quiero hablar con Johan");
    expect(c.sent().slice(before)).toEqual([handoffLine(VOICE)]);
    const raised = h.log.fields("pendiente_raised").filter((line) => line.businessId === store.businessId);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.reason).toBe("customer_handoff");
    expect(JSON.stringify(raised)).not.toContain("Johan");
  });

  it("works while stopped, and the stop holds", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const c = customerOf(h, store);
    await c.say("Hola");
    await c.say("alto");
    await c.say("quiero hablar con una persona");
    expect(c.sent().at(-1)).toBe(handoffLine(VOICE));
    expect((await c.row())!.stopped_at_ms).not.toBeNull();
  });
});

describe("deletion", () => {
  async function objectsUnder(businessId: string, customerId: string): Promise<string[]> {
    const prefixes = await rows<{ object_key: string }>(
      `SELECT m.object_key FROM media_assets m JOIN inbound_messages i ON i.business_id = m.business_id AND i.media_asset_id = m.id
       JOIN conversations c ON c.business_id = i.business_id AND c.id = i.conversation_id
       WHERE c.business_id = ? AND c.customer_id = ?`,
      businessId,
      customerId,
    );
    const keys: string[] = [];
    for (const { object_key } of prefixes) {
      keys.push(...(await env.MEDIA.list({ prefix: `${object_key}/` })).objects.map((object) => object.key));
    }
    return keys;
  }

  async function messagesOf(businessId: string, customerId: string) {
    return rows<{ text_body: string | null; provider_message_id: string }>(
      `SELECT i.text_body, i.provider_message_id FROM inbound_messages i
       JOIN conversations c ON c.business_id = i.business_id AND c.id = i.conversation_id
       WHERE c.business_id = ? AND c.customer_id = ?`,
      businessId,
      customerId,
    );
  }

  /** Customer A and B in one store, and A's same phone as a customer of another store. */
  async function threeCustomers() {
    const store = await storeWithOwner();
    const other = await storeWithOwner("Otra tienda");
    const h = gatedHarness();
    const a = customerOf(h, store);
    const b = customerOf(h, store);
    const aElsewhere = customerOf(h, other, a.phone);
    for (const [n, c] of [a, b, aElsewhere].entries()) {
      await c.say("Hola, soy cliente");
      await c.photo(`m-${n}-${crypto.randomUUID()}`);
    }
    await env.DB.prepare(`UPDATE customers SET name = 'Ana', name_saved_at_ms = 1 WHERE business_id = ? AND phone = ?`)
      .bind(store.businessId, a.phone)
      .run();
    const ids = { a: (await a.row())!.id, b: (await b.row())!.id, aElsewhere: (await aElsewhere.row())!.id };
    for (const [key, id] of [[store.businessId, ids.a], [store.businessId, ids.b], [other.businessId, ids.aElsewhere]] as const) {
      expect(await objectsUnder(key, id)).toHaveLength(1);
    }
    return { store, other, h, a, b, aElsewhere, ids };
  }

  it("removes that customer's data from D1 and R2 only, keeping the row without the person", async () => {
    const { store, other, h, a, ids } = await threeCustomers();
    const firstMessage = (await rows<{ provider_message_id: string }>(
      `SELECT i.provider_message_id FROM inbound_messages i JOIN conversations c ON c.id = i.conversation_id
       WHERE c.customer_id = ? ORDER BY i.received_at_ms LIMIT 1`,
      ids.a,
    ))[0]!.provider_message_id;

    await a.say("Borren mis datos");
    expect(a.sent().at(-1)).toBe(DELETION_CONFIRMED);
    await h.runCron();

    const gone = (await rows<Record<string, unknown>>(`SELECT * FROM customers WHERE id = ?`, ids.a))[0]!;
    expect(gone.phone).toBeNull();
    expect(gone.name).toBeNull();
    expect(gone.deleted_at_ms).not.toBeNull();
    const messages = await messagesOf(store.businessId, ids.a);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.text_body === null && m.provider_message_id.startsWith("deleted:"))).toBe(true);
    expect(messages.some((m) => m.provider_message_id === firstMessage)).toBe(false);
    expect(await objectsUnder(store.businessId, ids.a)).toEqual([]);
    const sentBodies = await rows<{ body_text: string; provider_message_id: string | null }>(
      `SELECT o.body_text, o.provider_message_id FROM outbound_messages o JOIN conversations c ON c.id = o.conversation_id
       WHERE c.customer_id = ?`,
      ids.a,
    );
    expect(sentBodies.every((row) => row.body_text === "-" && row.provider_message_id === null)).toBe(true);
    // Nowhere in the store's customer records is the phone kept; the tombstone holds only a keyed hash.
    expect(await rows(`SELECT id FROM customers WHERE phone = ? AND business_id = ?`, a.phone, store.businessId)).toEqual([]);
    const [tomb] = await rows<{ sender_hash: string }>(`SELECT sender_hash FROM customer_tombstones WHERE business_id = ?`, store.businessId);
    expect(tomb!.sender_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tomb!.sender_hash).not.toContain(a.phone);

    // Customer B in the same store, and the same phone in another store, are untouched.
    for (const [businessId, id] of [[store.businessId, ids.b], [other.businessId, ids.aElsewhere]] as const) {
      expect((await rows<{ phone: string | null }>(`SELECT phone FROM customers WHERE id = ?`, id))[0]!.phone).not.toBeNull();
      expect(await objectsUnder(businessId, id)).toHaveLength(1);
      expect((await messagesOf(businessId, id)).some((m) => m.text_body === "Hola, soy cliente")).toBe(true);
    }
    expect(await rows(`SELECT 1 FROM customer_tombstones WHERE business_id = ?`, other.businessId)).toEqual([]);
  });

  it("a late webhook doesn't recreate the deleted customer; a new message later starts a new one", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const a = customerOf(h, store);
    const oldId = wamid();
    const oldTimestamp = nowS(h) + 1;
    await a.say("Hola", oldId);
    await a.say("borren mis datos");
    await h.runCron();
    expect(await rows(`SELECT id FROM customers WHERE business_id = ? AND phone = ?`, store.businessId, a.phone)).toEqual([]);

    // Meta delivers the first message again (a retry), with its original ID and time.
    h.clock.advance(60_000);
    const response = await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: a.phone, id: oldId, timestampS: oldTimestamp, body: "Hola" })] }));
    expect(response.status).toBe(200);
    expect(h.takeRingsFor(store.businessId)).toEqual([]);
    expect(await rows(`SELECT id FROM customers WHERE business_id = ? AND phone = ?`, store.businessId, a.phone)).toEqual([]);

    // Writing again later is a new customer, who gets the first message again.
    const before = a.sent().length;
    await a.say("Hola de nuevo");
    const fresh = await rows<{ id: string }>(`SELECT id FROM customers WHERE business_id = ? AND phone = ?`, store.businessId, a.phone);
    expect(fresh).toHaveLength(1);
    expect(a.sent().slice(before)).toEqual([introduction(VOICE), RECEIVED_PLACEHOLDER]);
  });

  it("a late webhook whose reads ran before the purge still doesn't recreate the customer", async () => {
    const store = await storeWithOwner();
    let armed = false;
    let h!: Harness;
    // The purge commits after every read intake makes for the webhook, right before its batch.
    const db = hookDb(
      env.DB,
      /FROM channel_accounts/,
      async () => {
        if (!armed) return;
        armed = false;
        expect(await purgeRequestedDeletions(h.deps)).toMatchObject({ purged: 1 });
      },
      Number.POSITIVE_INFINITY,
    );
    h = harness({ db, engine: new MemoryEngine(() => []), env: testEnv({ PUBLIC_BASE_URL: BASE_URL } as unknown as Partial<Env>) });
    const a = customerOf(h, store);
    const oldId = wamid();
    const oldTimestamp = nowS(h) + 1;
    await a.say("Hola", oldId);
    await a.say("borren mis datos");

    h.clock.advance(60_000);
    armed = true;
    const response = await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: a.phone, id: oldId, timestampS: oldTimestamp, body: "Hola" })] }));
    expect(response.status).toBe(200);
    expect(armed).toBe(false);
    expect(h.takeRingsFor(store.businessId)).toEqual([]);
    expect(await rows(`SELECT id FROM customers WHERE business_id = ? AND phone = ?`, store.businessId, a.phone)).toEqual([]);
    expect(h.log.events()).toContain("inbound_refused_after_deletion");
  });

  it("erases a photo that an in-flight job stored after the purge's first erase", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const a = customerOf(h, store);
    await a.photo(`m-late-${crypto.randomUUID()}`);
    await a.say("Borren mis datos");
    const id = (await a.row())!.id;
    const [{ object_key: prefix }] = (await rows<{ object_key: string }>(
      `SELECT m.object_key FROM media_assets m JOIN inbound_messages i ON i.business_id = m.business_id AND i.media_asset_id = m.id
       JOIN conversations c ON c.id = i.conversation_id WHERE c.customer_id = ?`,
      id,
    )) as [{ object_key: string }];

    // A job still downloading writes its copy right after the first erase, before the D1 batch.
    let landed = 0;
    const real = h.deps.mediaEraser;
    const racing: MediaEraser = {
      erasePrefix: async (tenant, p) => {
        const erased = await real.erasePrefix(tenant, p);
        if (landed++ === 0) await env.MEDIA.put(`${p}/late-1`, "late bytes");
        return erased;
      },
    };
    await purgeRequestedDeletions({ ...h.deps, mediaEraser: racing });
    expect((await rows<{ phone: string | null }>(`SELECT phone FROM customers WHERE id = ?`, id))[0]!.phone).toBeNull();
    expect(await objectsUnder(store.businessId, id)).toEqual([]);

    // One that lands later still is erased by the next sweep, while the customer is in the window.
    await env.MEDIA.put(`${prefix}/late-2`, "late bytes");
    h.clock.advance(60_000);
    await h.runCron();
    expect(await objectsUnder(store.businessId, id)).toEqual([]);
    expect(h.log.events()).toContain("customer_late_media_erased");

    // After the window the purged customer isn't listed again.
    h.clock.advance(MEDIA_RECHECK_AFTER_PURGE_MS);
    expect(await h.deps.customerControls.purgedSince(h.clock.now() - MEDIA_RECHECK_AFTER_PURGE_MS, 100)).not.toContainEqual({
      businessId: store.businessId,
      customerId: id,
    });
  });

  it("retries a cleanup that failed, and leaves D1 as it was until the objects are gone", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const a = customerOf(h, store);
    await a.photo(`m-retry-${crypto.randomUUID()}`);
    await a.say("Eliminen mis datos por favor");
    const id = (await a.row())!.id;

    const failing: MediaEraser = {
      erasePrefix: async () => {
        throw new Error("r2 unavailable");
      },
    };
    expect(await purgeRequestedDeletions({ ...h.deps, mediaEraser: failing })).toEqual({ purged: 0, failed: 1 });
    expect((await rows<{ phone: string | null }>(`SELECT phone FROM customers WHERE id = ?`, id))[0]!.phone).toBe(a.phone);
    expect(await objectsUnder(store.businessId, id)).toHaveLength(1);

    await h.runCron();
    expect((await rows<{ phone: string | null }>(`SELECT phone FROM customers WHERE id = ?`, id))[0]!.phone).toBeNull();
    expect(await objectsUnder(store.businessId, id)).toEqual([]);
    // Nothing is purged twice.
    expect(await purgeRequestedDeletions(h.deps)).toEqual({ purged: 0, failed: 0 });
  });

  it("is never triggered by a message that only mentions data", async () => {
    const store = await storeWithOwner();
    const h = gatedHarness();
    const c = customerOf(h, store);
    await c.say("¿Borran mis datos si cancelo el pedido?");
    await c.say("mis datos para la entrega son los mismos");
    const row = (await c.row())!;
    expect(row.deletion_requested_at_ms).toBeNull();
    expect(row.phone).toBe(c.phone);
    expect(c.sent()).not.toContain(DELETION_CONFIRMED);
  });
});
