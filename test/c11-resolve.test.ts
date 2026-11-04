/**
 * C11, end to end: a real send (webhook or console tap, the handler, the outbox, dispatch and the fake channel)
 * gives a message the ID WhatsApp returned; that ID, posted to the search, reaches the order's Libro, which shows it,
 * and the exported entry never holds it. No row here is seeded with an ID.
 */
import { OPEN_STATES } from "../src/domain/replies";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Engine, LineMatch } from "../src/application/engine";
import { staffKey } from "../src/application/engine/order-engine";
import type { ConsoleAction } from "../src/domain/contract/actions";
import { ANSWER_NEW_READBACK, WHAT_TO_CORRECT } from "../src/domain/order-copy";
import { COPY, flattenClaims, renderNotice, secondCheckHolds } from "../src/domain/replies";
import { addAndPickup, moreSugar } from "./fixtures/contract";
import { csrfFor, csrfOf, login, send } from "./helpers/console";
import { type Harness, harness, rows } from "./helpers/harness";
import { engine, firstPickupOrder, newStore, save, store } from "./helpers/orders";
import { newPhone } from "./helpers/seed";
import { buttonReply, textMessage, wamid, webhook } from "./helpers/whatsapp";

const SETTLED_MS = 4_000;
const SEARCH = "/console/deed/buscar";
const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

type Scene = Awaited<ReturnType<typeof scene>>;

/** A store with an owner who is logged in, and a customer who has written, so a notice can reach them. */
async function scene(using: Engine = engine) {
  const s = await newStore();
  const [member] = await rows<{ user_id: string }>(`SELECT user_id FROM memberships WHERE business_id = ? AND role = 'owner'`, s.businessId);
  const h = harness({ engine: using });
  const phone = newPhone();
  const [account] = await rows<{ phone_number_id: string }>(`SELECT phone_number_id FROM channel_accounts WHERE business_id = ?`, s.businessId);
  const storePhone = account!.phone_number_id;
  const write = async (message: ReturnType<typeof textMessage> | ReturnType<typeof buttonReply>) => {
    await h.post(webhook(storePhone, { messages: [message] }));
    h.clock.advance(SETTLED_MS);
    await h.deliver(h.takeRingsFor(s.businessId));
  };
  await write(textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" }));
  const [customer] = await rows<{ id: string }>(`SELECT id FROM customers WHERE business_id = ?`, s.businessId);
  await env.DB.prepare(`UPDATE customers SET introduced_at_ms = 1, name_asked_at_ms = 1 WHERE id = ?`).bind(customer!.id).run();
  const [conversation] = await rows<{ id: string }>(`SELECT id FROM conversations WHERE business_id = ?`, s.businessId);
  const cookie = await login(h, s.businessId, member!.user_id);
  return {
    s,
    h,
    phone,
    cookie,
    customerId: customer!.id,
    conversationId: conversation!.id,
    say: (body: string) => {
      h.clock.advance(1_000);
      return write(textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body }));
    },
    tap: (replyId: string, title: string) => {
      h.clock.advance(1_000);
      return write(buttonReply({ from: phone, id: wamid(), timestampS: nowS(h), replyId, title }));
    },
    /** The ID the channel returned for the last message this customer was sent, with its text. */
    last: () => {
      const sent = h.channel.sent.filter((message) => message.toPhone === phone).at(-1)!;
      return { body: sent.body, id: sent.providerMessageId };
    },
  };
}

/** The order the customer is reading back, saved by the engine (no model in this test). */
async function placed(c: Scene, matches: readonly LineMatch[] = c.s.matches): Promise<string> {
  const result = await engine.onBurst(c.s.context({ customerId: c.customerId, conversationId: c.conversationId, nowMs: c.h.clock.now() }), firstPickupOrder, matches);
  if (result.outcome.type !== "readback") throw new Error(`expected a readback, got ${result.outcome.type}`);
  await save(result);
  return result.outcome.order.orderId;
}

async function confirmed(c: Scene, matches: readonly LineMatch[] = c.s.matches): Promise<string> {
  const orderId = await placed(c, matches);
  await c.tap(`confirm:${orderId}:v1`, "Confirmar");
  return orderId;
}

/** A confirmed order with a change waiting for the owner's answer. */
async function withChange(c: Scene): Promise<{ orderId: string; requestId: string }> {
  const orderId = await confirmed(c);
  c.h.clock.advance(1_000);
  const result = await engine.onBurst(c.s.context({ customerId: c.customerId, conversationId: c.conversationId, nowMs: c.h.clock.now() }), addAndPickup, []);
  await save(result);
  if (result.outcome.type !== "order_status") throw new Error(`expected the status, got ${result.outcome.type}`);
  return { orderId, requestId: result.outcome.order!.openChangeRequest!.id };
}

async function review(c: Scene, orderId: string, requestId: string, decision: "approve" | "decline") {
  const path = `/console/pedidos/${orderId}`;
  const csrf = await csrfFor(c.h, c.cookie, path);
  const response = await send(c.h, `${path}/revision`, { method: "POST", cookie: c.cookie, form: { csrf, cambio: requestId, decision, motivo: "Ya está empacado" } });
  expect(response.status).toBe(303);
  await c.h.deliver(c.h.takeRingsFor(c.s.businessId));
}

/** A tap on Preparación's form, under the key the engine derives for it. */
async function staffTap(c: Scene, action: Extract<ConsoleAction, { type: "start_preparing" | "mark_ready" | "mark_line" }>) {
  const csrf = await csrfFor(c.h, c.cookie, SEARCH);
  const form: Record<string, string> = { csrf, type: action.type, orderId: action.orderId, version: String(action.version), operationKey: staffKey(action)! };
  if (action.type === "mark_line") Object.assign(form, { lineId: action.lineId, mark: action.mark });
  const response = await send(c.h, "/console/acciones", { method: "POST", cookie: c.cookie, form });
  expect(response.status).toBe(303);
  await c.h.deliver(c.h.takeRingsFor(c.s.businessId));
}

async function search(h: Harness, cookie: string, typed: string) {
  const csrf = await csrfFor(h, cookie, SEARCH);
  return send(h, SEARCH, { method: "POST", cookie, form: { csrf, codigo: typed } });
}

const libro = (orderId: string) => `/console/deed/${encodeURIComponent(orderId)}/libro`;

/** The whole trip: the ID reaches the order's Libro, the Libro shows it, and the entry doesn't hold it. */
async function expectResolves(c: Scene, orderId: string, id: string) {
  const response = await search(c.h, c.cookie, id);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(libro(orderId));
  const page = await (await send(c.h, libro(orderId), { cookie: c.cookie })).text();
  expect(page).toContain("ID de WhatsApp");
  expect(page).toContain(id);
  const entry = await (await send(c.h, `/console/deed/${encodeURIComponent(orderId)}/entrada.json`, { cookie: c.cookie })).text();
  expect(entry).not.toContain(id);
  expect(entry).not.toContain("wamid.");
}

describe("C11: every customer message about an order resolves to it, from a real send", () => {
  it("the confirmation", async () => {
    const c = await scene();
    const orderId = await confirmed(c);
    expect(c.last().body).toContain("quedó anotado");
    await expectResolves(c, orderId, c.last().id);
  });

  it("the change approved notice, with its copy unchanged", async () => {
    const c = await scene();
    const { orderId, requestId } = await withChange(c);
    await review(c, orderId, requestId, "approve");
    expect(c.last().body).toBe("Tu cambio fue aprobado. Tu pedido ya quedó actualizado ✅");
    await expectResolves(c, orderId, c.last().id);
  });

  it("the change declined notice, with its copy unchanged", async () => {
    const c = await scene();
    const { orderId, requestId } = await withChange(c);
    await review(c, orderId, requestId, "decline");
    expect(c.last().body).toBe("No pudimos hacer el cambio: Ya está empacado. Tu pedido sigue como estaba.");
    await expectResolves(c, orderId, c.last().id);
  });

  it("a staff tap between the approval and the send doesn't block the approved notice", async () => {
    const c = await scene();
    const { orderId, requestId } = await withChange(c);
    await review(c, orderId, requestId, "approve");
    const tenant = { businessId: c.s.businessId };
    const { view } = (await store.order(tenant, orderId))!;
    const { claims } = renderNotice({ type: "change_approved", order: view });
    await staffTap(c, { type: "start_preparing", orderId, version: view.version });
    expect(secondCheckHolds(claims, await engine.verifyClaims(tenant, flattenClaims(claims)))).toBe(true);
  });

  it("Corregir", async () => {
    const c = await scene();
    const orderId = await placed(c);
    await c.tap(`correct:${orderId}:v1`, "Corregir");
    expect(c.last().body).toBe(WHAT_TO_CORRECT);
    await expectResolves(c, orderId, c.last().id);
  });

  it("Corregir tapped on an older readback than the one last shown is about the one shown", async () => {
    const c = await scene();
    const orderId = await placed(c);
    await save(await engine.onBurst(c.s.context({ customerId: c.customerId, conversationId: c.conversationId, nowMs: c.h.clock.now() }), moreSugar, []));
    await env.DB.prepare(`UPDATE conversations SET last_readback_order_id = ?, last_readback_version = 2, last_readback_at_ms = ? WHERE id = ?`)
      .bind(orderId, c.h.clock.now(), c.conversationId)
      .run();
    await c.tap(`correct:${orderId}:v1`, "Corregir");
    expect(c.last().body).toBe(WHAT_TO_CORRECT);
    await expectResolves(c, orderId, c.last().id);
  });

  it("Corregir on a cancelled order is blocked: the claim is not true when it goes out", async () => {
    const c = await scene();
    const orderId = await placed(c);
    await c.tap(`cancel:${orderId}:v1`, "Cancelar");
    await c.tap(`correct:${orderId}:v1`, "Corregir");
    expect(c.last().body).toBe(COPY.safeReply);
    expect((await search(c.h, c.cookie, c.last().id)).status).toBe(404);
  });

  it("the answer to a word that crossed a newer readback", async () => {
    const c = await scene();
    const orderId = await placed(c);
    await env.DB.prepare(`UPDATE conversations SET last_readback_order_id = ?, last_readback_version = 1, last_readback_at_ms = ? WHERE id = ?`)
      .bind(orderId, c.h.clock.now() + 60_000, c.conversationId)
      .run();
    await c.say("confirmar");
    expect(c.last().body).toBe(ANSWER_NEW_READBACK);
    await expectResolves(c, orderId, c.last().id);
  });

  it("the never-silent line, when an answer leaves an order open and nothing else to say", async () => {
    const quiet: Engine = Object.create(engine, {
      onCustomerAction: { value: async () => ({ outcome: { type: "nothing" }, notices: [], commits: [] }) },
    });
    const c = await scene(quiet);
    const orderId = await placed(c);
    await env.DB.prepare(`UPDATE conversations SET last_readback_order_id = ?, last_readback_version = 1, last_readback_at_ms = ? WHERE id = ?`)
      .bind(orderId, c.h.clock.now() - 1, c.conversationId)
      .run();
    await c.say("confirmar");
    expect(c.last().body).toBe(COPY.anythingElse);
    await expectResolves(c, orderId, c.last().id);
  });

  it("counts an order out for delivery as open, so its never-silent line isn't blocked", () => {
    expect(OPEN_STATES).toContain("en_camino");
    expect(OPEN_STATES).not.toContain("entregado");
    expect(OPEN_STATES).not.toContain("cancelado");
  });

  it("the ready notice", async () => {
    const c = await scene();
    const orderId = await confirmed(c);
    await staffTap(c, { type: "start_preparing", orderId, version: 1 });
    await staffTap(c, { type: "mark_ready", orderId, version: 1 });
    expect(c.last().body).toContain("ya está listo");
    await expectResolves(c, orderId, c.last().id);
  });

  it("the cancellation", async () => {
    const c = await scene();
    const orderId = await placed(c);
    await c.tap(`cancel:${orderId}:v1`, "Cancelar");
    expect(c.last().body).toBe(COPY.cancelled);
    await expectResolves(c, orderId, c.last().id);
  });

  it("a line marked no-hay, when the line has no catalog product", async () => {
    const c = await scene();
    const orderId = await confirmed(c, []);
    await staffTap(c, { type: "start_preparing", orderId, version: 1 });
    await staffTap(c, { type: "mark_line", orderId, version: 1, lineId: "L1", mark: "no_hay", substituteProductId: null });
    expect(c.last().body).toContain("ahorita no hay");
    await expectResolves(c, orderId, c.last().id);
  });

  it("another store finds nothing, and its Libro is a 404", async () => {
    const c = await scene();
    const orderId = await confirmed(c);
    const other = await scene();
    const response = await search(other.h, other.cookie, c.last().id);
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect((await send(other.h, libro(orderId), { cookie: other.cookie })).status).toBe(404);
  });
});

describe("C11: what stays unresolved, on purpose", () => {
  it("a safe reply sent in place of a blocked message: the Libro shows no ID for it", async () => {
    // The records stop backing every claim, so dispatch's second check blocks the row.
    const blocking: Engine = Object.create(engine, {
      verifyClaims: { value: async (_tenant: unknown, claims: readonly unknown[]) => claims.map(() => false) },
    });
    const c = await scene(blocking);
    const orderId = await confirmed(c);
    expect(c.last().body).toBe(COPY.safeReply);
    expect((await search(c.h, c.cookie, c.last().id)).status).toBe(404);
    const page = await (await send(c.h, libro(orderId), { cookie: c.cookie })).text();
    expect(page).not.toContain(c.last().id);
  });

  it("a no-hay notice on a catalog line goes out as itself, and resolves", async () => {
    const c = await scene();
    const orderId = await confirmed(c);
    await staffTap(c, { type: "start_preparing", orderId, version: 1 });
    const { view } = (await store.order({ businessId: c.s.businessId }, orderId))!;
    const lineId = view.lines.find((line) => line.productId !== null)!.lineId;
    await staffTap(c, { type: "mark_line", orderId, version: 1, lineId, mark: "no_hay", substituteProductId: null });
    expect(c.last().body).toContain("ahorita no hay");
    expect((await search(c.h, c.cookie, c.last().id)).status).toBe(303);
  });

  it("the owner's own words from Pendientes carry no claim, so they resolve to nothing", async () => {
    const c = await scene();
    await c.say("quiero hablar con una persona");
    const [item] = await rows<{ id: string }>(`SELECT id FROM conversation_pendientes WHERE business_id = ? AND done_at_ms IS NULL`, c.s.businessId);
    const csrf = await csrfFor(c.h, c.cookie, SEARCH);
    const response = await send(c.h, "/console/pendientes/responder", { method: "POST", cookie: c.cookie, form: { csrf, pendiente: item!.id, respuesta: "Sí hay, a L 65" } });
    expect(response.status).toBe(303);
    await c.h.deliver(c.h.takeRingsFor(c.s.businessId));
    expect(c.last().body).toContain("Sí hay, a L 65");
    expect((await search(c.h, c.cookie, c.last().id)).status).toBe(404);
  });

  it("a send whose delivery is unknown has no ID to search", async () => {
    const c = await scene();
    const orderId = await placed(c);
    c.h.channel.nextResults.push({ ok: false, disposition: "unknown", errorCode: "timeout" });
    await c.tap(`confirm:${orderId}:v1`, "Confirmar");
    const stored = await rows<{ status: string; provider_message_id: string | null }>(
      `SELECT status, provider_message_id FROM outbound_messages WHERE business_id = ? AND status = 'unknown_delivery'`,
      c.s.businessId,
    );
    expect(stored).toEqual([{ status: "unknown_delivery", provider_message_id: null }]);
    expect(await (await send(c.h, libro(orderId), { cookie: c.cookie })).text()).not.toContain("ID de WhatsApp");
  });

  it("an erased customer's messages no longer resolve", async () => {
    const c = await scene();
    const orderId = await confirmed(c);
    const { id } = c.last();
    await expectResolves(c, orderId, id);
    await c.say("Borren mis datos");
    await c.h.runCron();
    expect((await search(c.h, c.cookie, id)).status).toBe(404);
    expect(await (await send(c.h, libro(orderId), { cookie: c.cookie })).text()).not.toContain(id);
  });
});

describe("C11: the search is a POST and its IDs stay with the store's members", () => {
  it("refuses a POST without the CSRF value, and a cross-site one", async () => {
    const c = await scene();
    await confirmed(c);
    const { id } = c.last();
    const without = await send(c.h, SEARCH, { method: "POST", cookie: c.cookie, form: { codigo: id } });
    expect(without.status).toBe(403);
    expect(without.headers.get("location")).toBeNull();
    const wrong = await send(c.h, SEARCH, { method: "POST", cookie: c.cookie, form: { csrf: "0".repeat(64), codigo: id } });
    expect(wrong.status).toBe(403);
    const csrf = await csrfFor(c.h, c.cookie, SEARCH);
    const crossSite = await send(c.h, SEARCH, { method: "POST", cookie: c.cookie, origin: "https://elsewhere.test", form: { csrf, codigo: id } });
    expect(crossSite.status).toBe(403);
  });

  it("the GET is only the form: an ID in its URL searches nothing", async () => {
    const c = await scene();
    await confirmed(c);
    const response = await send(c.h, `${SEARCH}?codigo=${encodeURIComponent(c.last().id)}`, { cookie: c.cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const page = await response.text();
    expect(page).toContain(`<form method="post" action="${SEARCH}"`);
    expect(csrfOf(page)).toBeDefined();
    expect(page).not.toContain(c.last().id);
  });

  it("answers 404 with the form for an unknown ID, and doesn't show back what was typed", async () => {
    const c = await scene();
    const typed = "wamid.nothing-sent-here";
    const response = await search(c.h, c.cookie, typed);
    expect(response.status).toBe(404);
    const page = await response.text();
    expect(page).toContain(`name="codigo"`);
    expect(page).not.toContain(typed);
  });

  it("no ID reaches a page without a session", async () => {
    const c = await scene();
    const orderId = await confirmed(c);
    const response = await send(c.h, libro(orderId));
    expect(await response.text()).not.toContain(c.last().id);
    expect(response.status).not.toBe(200);
  });

  it("any member of the store sees it, not only the owner", async () => {
    const c = await scene();
    const orderId = await confirmed(c);
    await env.DB.prepare(`UPDATE memberships SET role = 'staff' WHERE business_id = ?`).bind(c.s.businessId).run();
    await expectResolves(c, orderId, c.last().id);
  });
});
