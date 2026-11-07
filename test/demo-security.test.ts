/**
 * The public demo's security walls, past the obvious paths: percent-encoded console paths, small
 * uploads, the service-level refusals behind the walls, the demo's total limit, retried sends, the
 * console's per-store reading limit, the webhook's streaming size limit and the real console's frame
 * policy. Local D1 and R2; no network.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DemoUploadRefusedError, readConsoleInput } from "../src/application/console-reader";
import { openDemoStore, type DemoStoreDeps } from "../src/application/demo-store";
import {
  DEMO_MAX_CONSOLE_READS_PER_STORE,
  DEMO_SPEND_POOL_ID,
  DEMO_STORES_PER_HOUR,
  DEMO_STORES_TOTAL,
  DEMO_VOICE_NOTE_MICRO_USD,
  demoLimitReached,
} from "../src/domain/demo";
import { D1ConsoleAuthRepository } from "../src/infrastructure/d1/console-auth-repository";
import { D1DemoStoreRepository } from "../src/infrastructure/d1/demo-store-repository";
import { hashToken } from "../src/infrastructure/tokens";
import { MAX_WEBHOOK_BYTES, readAtMost } from "../src/interfaces/http/app";
import { REAL_STORE_FRAME_POLICY, wallPath } from "../src/interfaces/http/console/demo-walls";
import { CLIENT_MESSAGE_ID, inboundEvent } from "../src/interfaces/http/demo";
import { login, storeWithStaff } from "./helpers/console";
import { FakeClock, RecordingLogger } from "./helpers/fakes";
import { type Harness, harness, rows, TEST_APP_SECRET } from "./helpers/harness";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ORIGIN = "https://worker.test";

async function call(
  h: Harness,
  path: string,
  init: { method?: string; json?: unknown; body?: BodyInit; cookie?: string; ip?: string; csrf?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { origin: ORIGIN, "cf-connecting-ip": init.ip ?? "203.0.113.9", ...init.headers };
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  if (init.csrf !== undefined) headers["x-csrf"] = init.csrf;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const body = init.json !== undefined ? JSON.stringify(init.json) : init.body;
  // A browser always sends the length of a form it posts.
  if (body instanceof ArrayBuffer) headers["content-length"] = String(body.byteLength);
  const request = new IncomingRequest(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, redirect: "manual", ...(body === undefined ? {} : { body }) });
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(request, h.env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function openDemo(h: Harness) {
  const response = await call(h, "/demo/empezar", { method: "POST", ip: `198.51.100.${Math.floor(Math.random() * 250)}` });
  expect(response.status).toBe(303);
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
  const phone = await (await call(h, "/demo/telefono", { cookie })).text();
  const csrf = /id="csrf">"([0-9a-f]{64})"/.exec(phone)![1]!;
  const token = /demo_sesion=([^;]+)/.exec(cookie)![1]!;
  const [store] = await rows<{ business_id: string }>(`SELECT business_id FROM console_sessions WHERE token_hash = ?`, await hashToken(token));
  return { cookie, csrf, businessId: store!.business_id };
}

/** A multipart form as bytes, so the request carries a Content-Length like a browser's. */
async function multipart(fields: Record<string, string | Blob>): Promise<{ body: ArrayBuffer; type: string }> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") form.append(key, value);
    else form.append(key, value, "foto.jpg");
  }
  const encoded = new Response(form);
  return { body: await encoded.arrayBuffer(), type: encoded.headers.get("content-type")! };
}

const tinyJpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], { type: "image/jpeg" });

async function objectsUnder(businessId: string): Promise<number> {
  return (await env.MEDIA.list({ prefix: `stores/${businessId}/` })).objects.length;
}

const REFUSED = "No disponible en la demostración";

describe("the demo's console walls, by any spelling of the path (S1)", () => {
  it("refuses staff pages and invites under percent-encoded, doubled and trailing-slash paths", async () => {
    const h = harness();
    const { cookie, businessId } = await openDemo(h);
    for (const path of ["/console/%65mpleados", "/console/%45mpleados", "/console//empleados", "/console/empleados/"]) {
      const page = await call(h, path, { cookie });
      expect(page.status, path).toBe(403);
      expect(await page.text(), path).toContain(REFUSED);
    }
    const form = new URLSearchParams({ telefono: "9999-0000", nombre: "Alguien" });
    const invite = await call(h, "/console/%65mpleados/invitar", {
      method: "POST",
      cookie,
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(invite.status).toBe(403);
    expect(await invite.text()).toContain(REFUSED);
    expect(await rows(`SELECT user_id FROM memberships WHERE business_id = ? AND role = 'staff'`, businessId)).toEqual([]);
    expect(await rows(`SELECT id FROM console_invites WHERE business_id = ?`, businessId)).toEqual([]);
  });

  it("refuses an encoded invoice upload before anything reaches R2", async () => {
    const h = harness();
    const { cookie, businessId } = await openDemo(h);
    const { body, type } = await multipart({ foto: tinyJpeg() });
    const upload = await call(h, "/console/facturas/%6Eueva", { method: "POST", cookie, body, headers: { "content-type": type } });
    expect(upload.status).toBe(403);
    expect(await upload.text()).toContain(REFUSED);
    expect(await objectsUnder(businessId)).toBe(0);
  });

  it("holds an encoded Anotar post to the same size limit", async () => {
    const h = harness();
    const { cookie } = await openDemo(h);
    const big = await call(h, "/console/%61notar", { method: "POST", cookie, body: "x".repeat(17 * 1024) });
    expect(big.status).toBe(413);
  });

  it("matches what the router matches, never less", () => {
    expect(wallPath("/console/empleados")).toBe("/empleados");
    expect(wallPath("/console//Empleados/")).toBe("/empleados");
    expect(wallPath("/console")).toBe("/");
    expect(wallPath("/consolex/empleados")).toBe("/consolex/empleados");
  });
});

describe("no file of any size goes into a demo store (S2)", () => {
  it("refuses a small photo posted to Anotar, and lets a text-only note with an empty photo field through", async () => {
    const h = harness();
    const { cookie, businessId } = await openDemo(h);
    const photo = await multipart({ texto: "vendí 2", foto: tinyJpeg() });
    const refused = await call(h, "/console/anotar", { method: "POST", cookie, body: photo.body, headers: { "content-type": photo.type } });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("En la demostración no se suben fotos.");
    expect(await objectsUnder(businessId)).toBe(0);

    // A browser sends an empty file part when no photo is chosen: that's a note, not an upload.
    const page = await (await call(h, "/console/anotar", { cookie })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const note = await multipart({ csrf, texto: "vendí 2", foto: new Blob([], { type: "application/octet-stream" }) });
    const passed = await call(h, "/console/anotar", { method: "POST", cookie, body: note.body, headers: { "content-type": note.type } });
    expect([403, 413, 429]).not.toContain(passed.status);
    expect(await passed.text()).not.toContain(REFUSED);
  });

  it("refuses at the services too: staff and the console reader store nothing for a demo store", async () => {
    const h = harness();
    const { businessId } = await openDemo(h);
    const runtime = h.deps;
    const auth = new D1ConsoleAuthRepository(env.DB);
    const tenant = { businessId };
    await expect(auth.addStaff(tenant, { phone: "50499990000", displayName: null, nowMs: h.clock.now() })).rejects.toThrow("demo");
    await expect(
      auth.createStaffInvite(tenant, "someone", { id: "i", tokenHash: "t", nowMs: h.clock.now(), expiresAtMs: h.clock.now() + 1 }),
    ).rejects.toThrow("demo");

    const [owner] = await rows<{ user_id: string }>(`SELECT user_id FROM memberships WHERE business_id = ? AND role = 'owner'`, businessId);
    const member = { businessId, memberId: owner!.user_id, role: "owner" as const, canApproveFiado: true, nowMs: h.clock.now() };
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]).buffer;
    let reads = 0;
    const reader = { read: async () => ((reads += 1), { ok: false as const, reason: "unavailable" as const, calls: [] }) };
    await expect(
      readConsoleInput({ reader, mediaStore: runtime.mediaStore, log: new RecordingLogger() }, member, {
        purpose: "report",
        inputs: [{ type: "photo", bytes, contentType: "image/jpeg" }],
      }),
    ).rejects.toBeInstanceOf(DemoUploadRefusedError);
    expect(reads).toBe(0);
    expect(await objectsUnder(businessId)).toBe(0);
  });
});

describe("the demo's total counts only open stores (S3)", () => {
  it("names a full demo apart from a busy hour", () => {
    expect(demoLimitReached(0, DEMO_STORES_PER_HOUR, 0)).toBe("everyone");
    expect(demoLimitReached(0, 0, DEMO_STORES_TOTAL)).toBe("full");
    expect(demoLimitReached(0, 0, DEMO_STORES_TOTAL - 1)).toBeNull();
  });

  it("stops counting a store once it expires", async () => {
    const repo = new D1DemoStoreRepository(env.DB);
    const nowMs = Date.UTC(2032, 2, 1, 12);
    const visitorHash = `open-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    const digits = id.replace(/\D/gu, "").padEnd(16, "4");
    await repo.create({
      businessId: `demo-${id}`,
      locationId: `loc-${id}`,
      channelAccountId: `ca-${id}`,
      phoneNumberId: `0${digits.slice(0, 15)}`,
      ownerUserId: `user-${id}`,
      ownerPhone: `0${digits.slice(1, 15)}`,
      ownerName: "Dueño (demo)",
      storeName: "Mercadito Demo",
      customerPhone: `0${digits.slice(2, 16)}`,
      visitorHash,
      sessionId: `s-${id}`,
      sessionTokenHash: `h-${id}`,
      nowMs,
      expiresAtMs: nowMs + 60_000,
    });
    const open = (await repo.recentCounts(visitorHash, nowMs)).open;
    const later = (await repo.recentCounts(visitorHash, nowMs + 60_000)).open;
    expect(open - later).toBe(1);
  });

  it("answers a full demo with its own reason, in the page's status and the log", async () => {
    const log = new RecordingLogger();
    const deps = {
      stores: {
        recentCounts: async () => ({ visitor: 0, everyone: 0, open: DEMO_STORES_TOTAL }),
        create: async () => {
          throw new Error("never written");
        },
      },
      clock: new FakeClock(),
      log,
    } as unknown as DemoStoreDeps;
    expect(await openDemoStore(deps, "v")).toEqual({ type: "limited", limit: "full" });
    expect(log.fields("demo_store_limited")).toEqual([expect.objectContaining({ reason: "full" })]);
  });
});

describe("a retried phone send is recorded once (S6, S5)", () => {
  it("dedupes by the phone's clientMessageId within the store, and refunds a repeated voice note", async () => {
    const h = harness();
    const { cookie, csrf, businessId } = await openDemo(h);
    const clientMessageId = crypto.randomUUID();
    for (let n = 0; n < 2; n += 1) {
      const sent = await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf, json: { text: "hola", clientMessageId } });
      expect(sent.status).toBe(200);
    }
    const texts = await rows(`SELECT id FROM inbound_messages WHERE business_id = ? AND kind = 'text'`, businessId);
    expect(texts).toHaveLength(1);
    const [counted] = await rows<{ phone_sends: number }>(`SELECT phone_sends FROM demo_stores WHERE business_id = ?`, businessId);
    expect(counted!.phone_sends).toBe(1);

    const pool = async () => (await rows<{ micro_usd: number }>(`SELECT micro_usd FROM model_spend WHERE business_id = ?`, DEMO_SPEND_POOL_ID))[0]?.micro_usd ?? 0;
    const before = await pool();
    const voiceId = crypto.randomUUID();
    for (let n = 0; n < 2; n += 1) {
      expect((await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf, json: { preset: "voz", clientMessageId: voiceId } })).status).toBe(200);
    }
    expect((await pool()) - before).toBe(DEMO_VOICE_NOTE_MICRO_USD);
    expect(await rows(`SELECT id FROM inbound_messages WHERE business_id = ? AND kind = 'audio'`, businessId)).toHaveLength(1);
  });

  it("answers a retry of a recorded send as accepted even once the store's limit is reached", async () => {
    const h = harness();
    const { cookie, csrf, businessId } = await openDemo(h);
    const clientMessageId = crypto.randomUUID();
    expect((await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf, json: { text: "hola", clientMessageId } })).status).toBe(200);
    await env.DB.prepare(`UPDATE demo_stores SET phone_sends = 40 WHERE business_id = ?`).bind(businessId).run();
    expect((await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf, json: { text: "hola", clientMessageId } })).status).toBe(200);
    expect((await call(h, "/demo/telefono/enviar", { method: "POST", cookie, csrf, json: { text: "otra", clientMessageId: crypto.randomUUID() } })).status).toBe(429);
    const [counted] = await rows<{ phone_sends: number }>(`SELECT phone_sends FROM demo_stores WHERE business_id = ?`, businessId);
    expect(counted!.phone_sends).toBe(40);
  });

  it("refuses a malformed clientMessageId, and gives a fresh ID when there is none", () => {
    const store = { businessId: "demo-x", phoneNumberId: "0123456789012345", customerPhone: "012345678901234", expiresAtMs: 0 };
    expect(inboundEvent(store, { text: "hola", clientMessageId: "short" }, 0)).toBeNull();
    expect(inboundEvent(store, { text: "hola", clientMessageId: "a b".repeat(10) }, 0)).toBeNull();
    expect(inboundEvent(store, { text: "hola", clientMessageId: 5 }, 0)).toBeNull();
    const id = crypto.randomUUID();
    expect(CLIENT_MESSAGE_ID.test(id)).toBe(true);
    expect(inboundEvent(store, { text: "hola", clientMessageId: id }, 0)?.providerMessageId).toBe(`demo.client.${id}`);
    const a = inboundEvent(store, { text: "hola" }, 0)!.providerMessageId;
    const b = inboundEvent(store, { text: "hola" }, 0)!.providerMessageId;
    expect(a).not.toBe(b);
  });

  it("takes the phone's lifetime limit in one guarded write: parallel takes never pass it", async () => {
    const h = harness();
    const { businessId } = await openDemo(h);
    const repo = new D1DemoStoreRepository(env.DB);
    const store = (await repo.find(businessId, h.clock.now()))!;
    const taken = await Promise.all(Array.from({ length: 8 }, () => repo.takePhoneSend(store, 5, h.clock.now())));
    expect(taken.filter(Boolean)).toHaveLength(5);
    await repo.returnPhoneSend(store);
    expect(await repo.takePhoneSend(store, 5, h.clock.now())).toBe(true);
    expect(await repo.takePhoneSend(store, 5, h.clock.now())).toBe(false);
  });
});

describe("the demo console's readings are limited per store (S4)", () => {
  it("refuses Anotar once the store's readings are used up", async () => {
    const h = harness();
    const { cookie, businessId } = await openDemo(h);
    await env.DB.prepare(`UPDATE demo_stores SET console_reads = ? WHERE business_id = ?`).bind(DEMO_MAX_CONSOLE_READS_PER_STORE - 1, businessId).run();
    const page = await (await call(h, "/console/anotar", { cookie })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const note = async () => {
      const form = await multipart({ csrf, texto: "vendí 2 refrescos" });
      return call(h, "/console/anotar", { method: "POST", cookie, body: form.body, headers: { "content-type": form.type } });
    };
    expect([403, 413, 429]).not.toContain((await note()).status);
    const refused = await note();
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain("ya usó todas sus lecturas");
    expect(await new D1DemoStoreRepository(env.DB).takeConsoleRead("real-store", 5, h.clock.now())).toBe(false);
  });
});

describe("the webhook never buffers an oversized body (S7)", () => {
  const stream = (chunks: number, size: number) => {
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === chunks) return controller.close();
        sent += 1;
        controller.enqueue(new Uint8Array(size));
      },
      cancel() {
        cancelled = true;
      },
    });
    return { body, read: () => sent, cancelled: () => cancelled };
  };

  it("stops reading and cancels as soon as the count passes the limit", async () => {
    const big = stream(100, 64 * 1024);
    expect(await readAtMost(big.body, 256 * 1024)).toBeNull();
    expect(big.read()).toBeLessThan(10);
    expect(big.cancelled()).toBe(true);
    const small = stream(3, 10);
    expect((await readAtMost(small.body, 256 * 1024))?.byteLength).toBe(30);
    expect((await readAtMost(null, 10))?.byteLength).toBe(0);
  });

  it("answers 413 to a body without Content-Length past the limit", async () => {
    const h = harness();
    const big = stream(Math.ceil(MAX_WEBHOOK_BYTES / (256 * 1024)) + 2, 256 * 1024);
    const request = new IncomingRequest(`${ORIGIN}/webhooks/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      body: big.body,
      // @ts-expect-error: workerd needs duplex for a streamed request body.
      duplex: "half",
    });
    expect(request.headers.get("content-length")).toBeNull();
    const ctx = createExecutionContext();
    const response = await h.worker.fetch(request, h.env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(413);
    expect(TEST_APP_SECRET).not.toBe("");
  });
});

describe("a real store's console can't be framed (S8)", () => {
  it("tells browsers no site may frame a real store's pages, while the demo keeps its own frame", async () => {
    const h = harness();
    const store = await storeWithStaff();
    const cookie = await login(h, store.businessId, store.members[0]!.userId);
    expect((await call(h, "/console/inicio", { cookie })).headers.get("content-security-policy")).toBe(REAL_STORE_FRAME_POLICY);
    // The notice for a real store opened in the demo's frame must show there.
    const framed = await call(h, "/console/inicio", { cookie, headers: { "sec-fetch-dest": "iframe" } });
    expect(framed.status).toBe(409);
    expect(framed.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    const demo = await openDemo(h);
    expect((await call(h, "/console/inicio", { cookie: demo.cookie })).headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect((await call(h, "/demo")).headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  });
});
