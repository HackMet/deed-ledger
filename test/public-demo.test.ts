/**
 * The public demo (`/demo`): a visitor opens a made-up store of their own and plays its customer.
 * What must hold: a demo store never reaches WhatsApp or Meta's media, its spend is pooled under
 * one cap, a visitor only ever reaches their own demo store, and opening stores is limited.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SpendLedger } from "../src/application/ports";
import {
  DEMO_DAILY_CAP_MICRO_USD,
  DEMO_MAX_MESSAGES_PER_STORE,
  DEMO_SPEND_POOL_ID,
  DEMO_STORES_PER_VISITOR_PER_HOUR,
  DEMO_VOICE_NOTE_MICRO_USD,
  isDemoPhone,
  isDemoPhoneNumberId,
} from "../src/domain/demo";
import { DemoGuardedChannel, DemoGuardedMediaSource, DemoPooledSpendLedger } from "../src/infrastructure/demo-guards";
import { inboundEvent } from "../src/interfaces/http/demo";
import { hashToken } from "../src/infrastructure/tokens";
import { D1SpendLedger } from "../src/infrastructure/d1/spend-repository";
import { FakeChannel, FakeMediaSource } from "./helpers/fakes";
import { login, send, storeWithStaff } from "./helpers/console";
import { type Harness, harness, rows } from "./helpers/harness";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ORIGIN = "https://worker.test";

/** A request as a browser sends it: same origin, the visitor's IP, their cookies. */
async function call(h: Harness, path: string, init: { method?: string; json?: unknown; cookie?: string; ip?: string; csrf?: string; origin?: string } = {}) {
  const headers: Record<string, string> = { origin: init.origin ?? ORIGIN, "cf-connecting-ip": init.ip ?? "203.0.113.7" };
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  if (init.csrf !== undefined) headers["x-csrf"] = init.csrf;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const request = new IncomingRequest(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers,
    redirect: "manual",
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(request, h.env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Opens a demo store; returns both cookies (console and demo) as one header, and the store's ID. */
async function openDemo(h: Harness, ip = `198.51.100.${Math.floor(Math.random() * 250)}`) {
  const response = await call(h, "/demo/empezar", { method: "POST", ip });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/demo/tienda");
  const cookies = response.headers.getSetCookie().map((c) => c.split(";")[0]!);
  expect(cookies.map((c) => c.split("=")[0]).sort()).toEqual(["consola", "demo_sesion"]);
  const cookie = cookies.join("; ");
  const phone = await call(h, "/demo/telefono", { cookie });
  expect(phone.status).toBe(200);
  const csrf = /id="csrf">"([0-9a-f]{64})"/.exec(await phone.text())?.[1];
  expect(csrf).toBeDefined();
  const token = cookies.find((c) => c.startsWith("demo_sesion="))!.split("=")[1]!;
  const [store] = await rows<{ business_id: string }>(`SELECT business_id FROM console_sessions WHERE token_hash = ?`, await hashToken(token));
  return { cookie, csrf: csrf!, businessId: store!.business_id };
}

describe("opening a demo store", () => {
  it("gives the visitor a synthetic store of their own, signed in as its owner, with products and prices", async () => {
    const h = harness();
    const { cookie, businessId } = await openDemo(h);
    expect(businessId.startsWith("demo-")).toBe(true);

    const [account] = await rows<{ phone_number_id: string }>(`SELECT phone_number_id FROM channel_accounts WHERE business_id = ?`, businessId);
    expect(isDemoPhoneNumberId(account!.phone_number_id)).toBe(true);
    const [demo] = await rows<{ customer_phone: string }>(`SELECT customer_phone FROM demo_stores WHERE business_id = ?`, businessId);
    expect(isDemoPhone(demo!.customer_phone)).toBe(true);

    const products = await rows<{ name: string; price_centavos: number }>(`SELECT name, price_centavos FROM store_products WHERE business_id = ?`, businessId);
    expect(products.length).toBeGreaterThanOrEqual(30);
    expect(products.find((p) => p.name === "Coca-Cola 600 ml")?.price_centavos).toBe(2500);

    const consolePage = await call(h, "/console/productos", { cookie });
    expect(consolePage.status).toBe(200);
    expect(await consolePage.text()).toContain("Coca-Cola 600 ml");
    expect((await call(h, "/demo/tienda", { cookie })).status).toBe(200);
  });

  it("limits how many stores one visitor opens an hour", async () => {
    const h = harness();
    const ip = "192.0.2.44";
    for (let i = 0; i < DEMO_STORES_PER_VISITOR_PER_HOUR; i++) await openDemo(h, ip);
    const refused = await call(h, "/demo/empezar", { method: "POST", ip });
    expect(refused.status).toBe(429);
    expect(refused.headers.getSetCookie()).toEqual([]);
    // An hour later the visitor can open one again.
    h.clock.advance(60 * 60 * 1000 + 1);
    await openDemo(h, ip);
  });

  it("refuses a store opened from another site", async () => {
    const h = harness();
    const response = await call(h, "/demo/empezar", { method: "POST", origin: "https://evil.example" });
    expect(response.status).toBe(403);
  });

  it("sends the bare address to the demo, and the console's login wall links to it", async () => {
    const h = harness();
    const root = await call(h, "/");
    expect(root.headers.get("location")).toBe("/demo");
    const wall = await call(h, "/console/inicio");
    expect(wall.status).toBe(401);
    expect(await wall.text()).toContain(`href="/demo"`);
  });
});

describe("the demo's phone", () => {
  it("sends the visitor's messages through the real intake and shows the store's reply, never on WhatsApp", async () => {
    const h = harness();
    const { cookie, csrf, businessId } = await openDemo(h);
    const sent = await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf, json: { preset: "texto" } });
    expect(sent.status).toBe(200);
    // The burst window, as a customer who stopped typing.
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(businessId));

    const chat = (await (await call(h, "/demo/telefono/mensajes?despues=0", { cookie })).json()) as {
      lines: { side: string; body: string | null; en: string | null }[];
    };
    expect(chat.lines[0]).toMatchObject({
      side: "in",
      body: "Buenas, me manda 2 coca de 600 y una libra de frijoles para llevar",
      en: "Hi, send me 2 Coca-Cola 600 ml and a pound of beans, to go",
    });
    const reply = chat.lines.find((line) => line.side === "out" && (line.body ?? "").includes("Mercadito Demo"));
    // The message stays as the assistant sent it, in Spanish; the subtitle is beside it.
    expect(reply?.body).toContain("Soy el asistente de *Mercadito Demo*");
    expect(reply?.en).toContain("I'm the ordering assistant for *Mercadito Demo*");
    // The reply counts as delivered without ever reaching the channel.
    expect(h.channel.sent.filter((m) => isDemoPhoneNumberId(m.fromPhoneNumberId) || isDemoPhone(m.toPhone))).toEqual([]);
    const outbox = await rows<{ status: string }>(`SELECT status FROM outbound_messages WHERE business_id = ?`, businessId);
    expect(outbox.length).toBeGreaterThan(0);
    expect(outbox.every((row) => row.status === "sent")).toBe(true);
  });

  it("serves a phone script that parses, regular expressions intact", async () => {
    const h = harness();
    const { cookie } = await openDemo(h);
    const page = await (await call(h, "/demo/telefono", { cookie })).text();
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0]!)).not.toThrow();
    expect(scripts[0]).toContain("\\*[^*\\n]+\\*");
  });

  it("serves a store page whose script parses and reloads only the console's showing screens", async () => {
    const h = harness();
    const { cookie } = await openDemo(h);
    const page = await (await call(h, "/demo/tienda", { cookie })).text();
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0]!)).not.toThrow();
    const pattern = /new RegExp\("([^"]+)"\)/.exec(scripts[0]!)?.[1];
    expect(pattern).toBeDefined();
    const shows = new RegExp(pattern!);
    for (const path of ["/console", "/console/inicio", "/console/pedidos", "/console/pedidos/abc", "/console/preparacion", "/console/pendientes"]) {
      expect(shows.test(path), path).toBe(true);
    }
    for (const path of ["/console/anotar", "/console/productos", "/console/productos/abc", "/console/tienda/editar", "/console/negocio"]) {
      expect(shows.test(path), path).toBe(false);
    }
  });

  it("stops a store's phone at its message limit, and says why", async () => {
    const h = harness();
    const { cookie, csrf, businessId } = await openDemo(h);
    for (let n = 0; n < DEMO_MAX_MESSAGES_PER_STORE; n += 1) {
      const sent = await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf, json: { text: `hola ${n}` } });
      expect(sent.status).toBe(200);
    }
    const refused = await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf, json: { text: "una más" } });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "limit" });
    const [count] = await rows<{ n: number }>(`SELECT count(*) AS n FROM inbound_messages WHERE business_id = ?`, businessId);
    expect(count!.n).toBe(DEMO_MAX_MESSAGES_PER_STORE);
  });

  it("charges a voice note to the demo's pool before it is transcribed, and refuses it when the pool is spent", async () => {
    const h = harness();
    const { cookie, csrf, businessId } = await openDemo(h);
    const pool = () => rows<{ micro_usd: number }>(`SELECT micro_usd FROM model_spend WHERE business_id = ?`, DEMO_SPEND_POOL_ID);
    const before = (await pool())[0]?.micro_usd ?? 0;
    expect((await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf, json: { preset: "voz" } })).status).toBe(200);
    expect((await pool())[0]!.micro_usd).toBe(before + DEMO_VOICE_NOTE_MICRO_USD);
    // Spend the rest of today's pool: the next voice note is refused before it reaches the store.
    const ledger = new D1SpendLedger(env.DB);
    expect(await ledger.reserve({ businessId: DEMO_SPEND_POOL_ID }, h.clock.now(), DEMO_DAILY_CAP_MICRO_USD - before - DEMO_VOICE_NOTE_MICRO_USD, DEMO_DAILY_CAP_MICRO_USD)).not.toBeNull();
    const refused = await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf, json: { preset: "voz" } });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "budget" });
    const audio = await rows<{ n: number }>(`SELECT count(*) AS n FROM inbound_messages WHERE business_id = ? AND kind = 'audio'`, businessId);
    expect(audio[0]!.n).toBe(1);
    // Text still goes through: its model calls meet the same cap on their own.
    expect((await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf, json: { text: "hola" } })).status).toBe(200);
  });

  it("refuses a send without the session's CSRF value", async () => {
    const h = harness();
    const { cookie } = await openDemo(h);
    const response = await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf: "0".repeat(64), json: { text: "hola" } });
    expect(response.status).toBe(403);
  });

  it("shows each visitor only their own store's chat", async () => {
    const h = harness();
    const a = await openDemo(h);
    const b = await openDemo(h);
    await call(h, "/demo/telefono/enviar", { method: "POST", cookie: a.cookie, csrf: a.csrf, json: { text: "solo para A" } });
    const seenByB = (await (await call(h, "/demo/telefono/mensajes?despues=0", { cookie: b.cookie })).json()) as { lines: unknown[] };
    expect(seenByB.lines).toEqual([]);
    // B's CSRF value doesn't work with A's session.
    expect((await call(h, "/demo/telefono/enviar", { method: "POST", cookie: a.cookie, csrf: b.csrf, json: { text: "x" } })).status).toBe(403);
  });

  it("never opens a real store's session as a demo", async () => {
    const h = harness();
    const store = await storeWithStaff();
    const consoleCookie = await login(h, store.businessId, store.members[0]!.userId);
    const token = consoleCookie.split("=")[1]!;
    const response = await call(h, "/demo/telefono/mensajes?despues=0", { cookie: `demo_sesion=${token}` });
    expect(response.status).toBe(401);
    expect((await send(h, "/demo/tienda", { cookie: `demo_sesion=${token}` })).headers.get("location")).toBe("/demo");
  });

  it("starts over from the top bar: a fresh store, an empty chat, and the old store out of reach", async () => {
    const h = harness();
    const ip = "192.0.2.90";
    const first = await openDemo(h, ip);
    await call(h, "/demo/telefono/enviar", { method: "POST", cookie: first.cookie, csrf: first.csrf, json: { preset: "texto" } });
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(first.businessId));
    expect(await (await call(h, "/demo/tienda", { cookie: first.cookie })).text()).toContain(`action="/demo/empezar"`);

    // The top bar's form posts with the visitor's cookies and lands back on the split view.
    const reset = await call(h, "/demo/empezar", { method: "POST", cookie: first.cookie, ip });
    expect(reset.status).toBe(303);
    expect(reset.headers.get("location")).toBe("/demo/tienda");
    const cookie = reset.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
    const token = /demo_sesion=([^;]+)/.exec(cookie)![1]!;
    const [fresh] = await rows<{ business_id: string }>(`SELECT business_id FROM console_sessions WHERE token_hash = ?`, await hashToken(token));
    expect(fresh!.business_id).not.toBe(first.businessId);

    const chat = (await (await call(h, "/demo/telefono/mensajes?despues=0", { cookie })).json()) as { lines: unknown[] };
    expect(chat.lines).toEqual([]);
    expect(await rows(`SELECT id FROM orders WHERE business_id = ?`, fresh!.business_id)).toEqual([]);
    expect(await rows(`SELECT id FROM inbound_messages WHERE business_id = ?`, fresh!.business_id)).toEqual([]);

    // The old store's cookies no longer open anything; its rows stay until it expires.
    expect((await call(h, "/demo/telefono/mensajes?despues=0", { cookie: first.cookie })).status).toBe(401);
    expect((await call(h, "/console/inicio", { cookie: first.cookie })).status).toBe(401);
    expect(await rows(`SELECT id FROM inbound_messages WHERE business_id = ?`, first.businessId)).toHaveLength(1);
  });

  it("counts a reset as a new store for the hourly limit", async () => {
    const h = harness();
    const ip = "192.0.2.91";
    let { cookie } = await openDemo(h, ip);
    for (let i = 1; i < DEMO_STORES_PER_VISITOR_PER_HOUR; i++) {
      const reset = await call(h, "/demo/empezar", { method: "POST", cookie, ip });
      expect(reset.status).toBe(303);
      cookie = reset.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
    }
    const refused = await call(h, "/demo/empezar", { method: "POST", cookie, ip });
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain(`href="/demo/tienda"`);
    // Refused, the visitor keeps the store they had.
    expect((await call(h, "/demo/telefono/mensajes?despues=0", { cookie })).status).toBe(200);
  });

  it("ends with the store: an expired demo can't send or read", async () => {
    const h = harness();
    const { cookie, csrf } = await openDemo(h);
    h.clock.advance(24 * 60 * 60 * 1000 + 1);
    expect((await call(h, "/demo/telefono/mensajes?despues=0", { cookie })).status).toBe(401);
    expect((await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf, json: { text: "hola" } })).status).toBe(401);
  });
});

describe("what the phone may send", () => {
  const store = { businessId: "demo-x", phoneNumberId: "0123456789012345", customerPhone: "012345678901234", expiresAtMs: 0 };

  it("builds only this store's number and customer, whatever the body says", () => {
    const event = inboundEvent(store, { text: "hola", phoneNumberId: "100000000000001", senderPhone: "50499999999" }, 1_000_000);
    expect(event).toMatchObject({ phoneNumberId: store.phoneNumberId, senderPhone: store.customerPhone, kind: "text", textBody: "hola" });
  });

  it("turns the presets into the demo's own media", () => {
    expect(inboundEvent(store, { preset: "lista" }, 0)).toMatchObject({ kind: "image", media: { providerMediaId: "demo-preset-lista" } });
    expect(inboundEvent(store, { preset: "voz" }, 0)).toMatchObject({ kind: "audio", media: { providerMediaId: "demo-preset-voz" } });
  });

  it("refuses empty, oversized and unknown messages", () => {
    expect(inboundEvent(store, { text: "  " }, 0)).toBeNull();
    expect(inboundEvent(store, { text: "a".repeat(301) }, 0)).toBeNull();
    expect(inboundEvent(store, { preset: "toString" }, 0)).toBeNull();
    expect(inboundEvent(store, { preset: "otra" }, 0)).toBeNull();
    expect(inboundEvent(store, null, 0)).toBeNull();
  });
});

describe("the demo's walls", () => {
  it("sends a real store's messages and keeps a demo store's", async () => {
    const real = new FakeChannel();
    const channel = new DemoGuardedChannel(real);
    expect((await channel.sendText({ fromPhoneNumberId: "100000000000001", toPhone: "50400000001", body: "real" })).ok).toBe(true);
    expect((await channel.sendText({ fromPhoneNumberId: "0123456789012345", toPhone: "50400000001", body: "demo" })).ok).toBe(true);
    expect((await channel.sendButtons!({ fromPhoneNumberId: "100000000000001", toPhone: "012345678901234", body: "to a demo phone", buttons: [] })).ok).toBe(true);
    expect(real.sent.map((m) => m.body)).toEqual(["real"]);
  });

  it("never downloads a demo store's media from Meta", async () => {
    const real = new FakeMediaSource();
    const source = new DemoGuardedMediaSource(real, { lista: new Uint8Array([1, 2]).buffer, voz: new Uint8Array([3]).buffer });
    expect((await source.fetch({ providerMediaId: "demo-preset-lista", phoneNumberId: "0123456789012345" }))?.contentType).toBe("image/jpeg");
    expect(await source.fetch({ providerMediaId: "wamid.anything", phoneNumberId: "0123456789012345" })).toBeNull();
    expect(real.fetched).toEqual([]);
    await source.fetch({ providerMediaId: "m1", phoneNumberId: "100000000000001" });
    expect(real.fetched).toEqual(["m1"]);
  });

  it("pools every demo store's spend under one cap, and leaves real stores alone", async () => {
    const calls: { businessId: string; cap: number }[] = [];
    const real: SpendLedger = {
      reserve: async (tenant, _now, microUsd, cap) => {
        calls.push({ businessId: tenant.businessId, cap });
        return { businessId: tenant.businessId, day: "2026-11-05", microUsd };
      },
      settle: async () => {},
    };
    const ledger = new DemoPooledSpendLedger(real);
    await ledger.reserve({ businessId: "demo-a" }, 0, 10, 2_000_000);
    await ledger.reserve({ businessId: "demo-b" }, 0, 10, 2_000_000);
    await ledger.reserve({ businessId: "real-store" }, 0, 10, 2_000_000);
    expect(calls).toEqual([
      { businessId: DEMO_SPEND_POOL_ID, cap: DEMO_DAILY_CAP_MICRO_USD },
      { businessId: DEMO_SPEND_POOL_ID, cap: DEMO_DAILY_CAP_MICRO_USD },
      { businessId: "real-store", cap: 2_000_000 },
    ]);
  });

  it("stops the pool at the cap in D1", async () => {
    const ledger = new DemoPooledSpendLedger(new D1SpendLedger(env.DB));
    const day = Date.UTC(2031, 0, 1, 18);
    expect(await ledger.reserve({ businessId: "demo-a" }, day, DEMO_DAILY_CAP_MICRO_USD - 1, 2_000_000)).not.toBeNull();
    expect(await ledger.reserve({ businessId: "demo-b" }, day, 2, 2_000_000)).toBeNull();
  });
});
