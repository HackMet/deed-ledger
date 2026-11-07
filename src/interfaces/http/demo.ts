/**
 * The public demo (`/demo`): anyone can open a made-up store of their own, signed in as its owner,
 * and play its customer on a phone beside the console. The phone's messages go through the same
 * intake, queue, models and engine as WhatsApp; only the channel differs (demo-guards.ts). Every
 * request after the start needs the demo's session, and only ever reaches that visitor's demo store.
 */
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { acceptEvents } from "../../application/intake";
import { openDemoStore } from "../../application/demo-store";
import type { InboundMessageEvent, SpendReservation } from "../../application/ports";
import { describeError } from "../../application/errors";
import { isWellFormedToken, SESSION_COOKIE } from "../../domain/console-auth";
import {
  DEMO_DAILY_CAP_MICRO_USD,
  DEMO_MAX_MESSAGES_PER_STORE,
  DEMO_MAX_TEXT,
  DEMO_PRESETS,
  DEMO_VOICE_NOTE_MICRO_USD,
  demoVisitorKey,
  isDemoBusiness,
  isDemoPreset,
} from "../../domain/demo";
import type { DemoStore } from "../../infrastructure/d1/demo-store-repository";
import { csrfToken, hashToken, newToken, sameToken } from "../../infrastructure/tokens";
import { LISTA_JPEG_BASE64, VOZ_OGG_BASE64 } from "../../infrastructure/demo-preset-files";
import { afterIntake } from "./app";
import { languageOf } from "./console/language";
import { buttonInEnglish, customerInEnglish, replyInEnglish } from "./demo-english";
import { demoLandingPage, demoLimitedPage, demoPhonePage, demoSplitPage } from "./demo-pages";
import { DEMO_TOUR_GIF_BASE64 } from "./demo-tour";
import type { HttpEnv } from "./env";

export const DEMO_PATH = "/demo";

let tourGif: ArrayBuffer | undefined;
/** The demo's own copy of the session token, for the phone's routes (the console's cookie is path /console). */
const DEMO_COOKIE = "demo_sesion";
const MAX_SEND_BYTES = 4 * 1024;
/**
 * The phone's own ID for one send (request field `clientMessageId`), the same on every retry of that
 * send, so a retry is recorded once. A UUID fits; anything else is refused.
 */
export const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{16,64}$/u;

type DemoEnv = HttpEnv;

interface DemoSession {
  readonly store: DemoStore;
  readonly csrf: string;
  /** The demo store's owner, whose session a reset ends. */
  readonly userId: string;
}

export function demoRoutes() {
  const app = new Hono<DemoEnv>();
  // Cross-site posts are refused: another site can't open stores or send messages for a visitor.
  app.use("*", async (c, next) => {
    if (c.req.method !== "POST" || c.req.header("origin") === new URL(c.req.url).origin) return next();
    return c.text("Forbidden", 403);
  });

  app.get("/", async (c) => {
    const session = await demoSession(c);
    return c.html(demoLandingPage(session !== null));
  });

  // The landing page's recording of a demo visit: one fixed file, decoded once per isolate.
  app.get("/recorrido.gif", (c) => {
    tourGif ??= Uint8Array.from(atob(DEMO_TOUR_GIF_BASE64), (ch) => ch.charCodeAt(0)).buffer;
    return c.body(tourGif, 200, {
      "content-type": "image/gif",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    });
  });

  app.post("/empezar", async (c) => {
    const runtime = c.get("runtime");
    const { config, deps } = runtime;
    if (config.linkSigningSecret === "" || config.senderHashSalt === "") return c.text("Not configured", 500);
    // A keyed hash of the visitor's IP, only to limit how many stores one visitor opens an hour.
    const ip = c.req.header("cf-connecting-ip") ?? "local";
    const visitorHash = await deps.hasher.hash("sender", `demo-visitor:${demoVisitorKey(ip)}`);
    const previous = await demoSession(c);
    const opened = await openDemoStore(
      {
        stores: runtime.demoStores,
        catalog: runtime.catalog,
        business: runtime.business.service,
        setup: runtime.storeSetup,
        ids: deps.ids,
        clock: deps.clock,
        log: deps.log,
        random: (n) => crypto.getRandomValues(new Uint8Array(n)),
        hashToken,
        newToken,
        history: runtime.demoHistory,
      },
      visitorHash,
    );
    if (opened.type === "limited") return c.html(demoLimitedPage(opened.limit, previous !== null), 429);
    // Starting over (the landing page or the top bar's "Empezar de nuevo"): the old store's login ends
    // now, so its tabs can't reach it. The store itself is left to expire.
    if (previous !== null) {
      await deps.consoleAuth.revokeSessions({ businessId: previous.store.businessId }, previous.userId, deps.clock.now());
      deps.log.info("demo_store_left", { businessId: previous.store.businessId });
    }
    const maxAge = Math.max(0, Math.floor((opened.expiresAtMs - deps.clock.now()) / 1000));
    const secure = new URL(c.req.url).protocol === "https:";
    setCookie(c, SESSION_COOKIE, opened.sessionToken, { httpOnly: true, secure, sameSite: "Lax", path: "/console", maxAge });
    setCookie(c, DEMO_COOKIE, opened.sessionToken, { httpOnly: true, secure, sameSite: "Lax", path: DEMO_PATH, maxAge });
    return c.redirect(`${DEMO_PATH}/tienda`, 303);
  });

  app.get("/tienda", async (c) => {
    const session = await demoSession(c);
    if (session === null) return c.redirect(DEMO_PATH, 302);
    return c.html(demoSplitPage(languageOf(c)));
  });

  app.get("/telefono", async (c) => {
    const session = await demoSession(c);
    if (session === null) return c.redirect(DEMO_PATH, 302);
    return c.html(demoPhonePage(session.csrf, languageOf(c)));
  });

  // The phone's chat since a moment: what the customer sent and the store's replies.
  app.get("/telefono/mensajes", async (c) => {
    const session = await demoSession(c);
    if (session === null) return c.json({ error: "expired" }, 401);
    const after = Number(c.req.query("despues") ?? "0");
    const lines = await c.get("runtime").demoStores.chat(session.store, Number.isFinite(after) ? after : 0);
    // English subtitles for visitors who don't read Spanish (D-63); the messages themselves stay as sent.
    return c.json({
      lines: lines.map((line) => ({
        ...line,
        en: line.side === "out" ? replyInEnglish(line.body) : customerInEnglish(line.kind, line.body),
        buttons: line.buttons.map((button) => ({ ...button, en: buttonInEnglish(button.title) })),
      })),
    });
  });

  // The preset photo and voice note, so the phone can show what the customer sent.
  app.get("/telefono/archivo/:nombre", async (c) => {
    if ((await demoSession(c)) === null) return c.text("Not found", 404);
    const name = c.req.param("nombre");
    if (name === "lista") return binary(LISTA_JPEG_BASE64, DEMO_PRESETS.lista.mimeType);
    if (name === "voz") return binary(VOZ_OGG_BASE64, "audio/ogg");
    return c.text("Not found", 404);
  });

  app.post(
    "/telefono/enviar",
    bodyLimit({ maxSize: MAX_SEND_BYTES, onError: (c) => c.json({ error: "too_large" }, 413) }),
    async (c) => {
      const session = await demoSession(c);
      if (session === null) return c.json({ error: "expired" }, 401);
      if (!sameToken(c.req.header("x-csrf") ?? "", session.csrf)) return c.json({ error: "csrf" }, 403);
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        return c.json({ error: "bad_request" }, 400);
      }
      const runtime = c.get("runtime");
      const { deps } = runtime;
      const nowMs = deps.clock.now();
      const event = inboundEvent(session.store, input, nowMs);
      if (event === null) return c.json({ error: "bad_request" }, 400);
      const { demoStores } = runtime;
      const store = session.store;
      const limited = (reason: "messages" | "budget") => {
        deps.log.info("demo_send_limited", { businessId: store.businessId, reason });
        return c.json({ error: reason === "messages" ? "limit" : "budget" }, 429);
      };
      // A retry of a send already recorded answers as it did, before any limit: it costs nothing.
      if (await demoStores.hasPhoneMessage(store, event.providerMessageId)) return c.json({ ok: true });
      // A demo store's life is a few orders: past that the visitor starts a fresh store.
      if ((await demoStores.messageCount(store)) >= DEMO_MAX_MESSAGES_PER_STORE) return limited("messages");
      // Once today's pool is spent, nothing more goes in: the store couldn't read it anyway.
      if ((await runtime.demoPoolSpent(nowMs)) >= DEMO_DAILY_CAP_MICRO_USD) return limited("budget");
      // The same limit, taken in one guarded write: parallel sends can't pass it together.
      if (!(await demoStores.takePhoneSend(store, DEMO_MAX_MESSAGES_PER_STORE, nowMs))) return limited("messages");
      // A voice note is transcribed before any capped model call, so it pays into the demo's pool first.
      let charged: SpendReservation | null = null;
      // Nothing new went in: the send and a voice note's charge come back, each at most once per request.
      let sendReturned = false;
      let chargeReturned = false;
      const giveBack = async () => {
        if (!sendReturned) {
          sendReturned = true;
          await demoStores.returnPhoneSend(store);
        }
        if (charged !== null && !chargeReturned) {
          chargeReturned = true;
          await runtime.demoSpend.settle(charged, 0);
        }
      };
      if (event.kind === "audio") {
        try {
          charged = await runtime.demoSpend.reserve({ businessId: store.businessId }, nowMs, DEMO_VOICE_NOTE_MICRO_USD, DEMO_DAILY_CAP_MICRO_USD);
        } catch (error) {
          deps.log.error("demo_send_failed", { businessId: store.businessId, reason: describeError(error) });
          await giveBack();
          return c.json({ error: "retry" }, 500);
        }
        if (charged === null) {
          await giveBack();
          return limited("budget");
        }
      }
      try {
        const outcome = await acceptEvents(deps, [event]);
        // A retry of a send already recorded (same clientMessageId), or intake's own limit.
        if (outcome.conversations.length === 0) await giveBack();
        c.executionCtx.waitUntil(afterIntake(deps, outcome));
      } catch (error) {
        deps.log.error("demo_send_failed", { businessId: store.businessId, reason: describeError(error) });
        try {
          await giveBack();
        } catch (cleanup) {
          deps.log.error("demo_send_give_back_failed", { businessId: store.businessId, reason: describeError(cleanup) });
        }
        return c.json({ error: "retry" }, 500);
      }
      return c.json({ ok: true });
    },
  );

  return app;
}

/** The visitor's demo store, from the demo's session cookie. Null for no session, an ended one, or a real store's. */
async function demoSession(c: Context<DemoEnv>): Promise<DemoSession | null> {
  const token = getCookie(c, DEMO_COOKIE);
  if (!isWellFormedToken(token)) return null;
  const { config, deps, demoStores } = c.get("runtime");
  if (config.linkSigningSecret === "") return null;
  const nowMs = deps.clock.now();
  const member = await deps.consoleAuth.findSession(await hashToken(token), nowMs);
  if (member === null || !isDemoBusiness(member.businessId)) return null;
  const store = await demoStores.find(member.businessId, nowMs);
  if (store === null) return null;
  return { store, csrf: await csrfToken(config.linkSigningSecret, member.sessionId), userId: member.userId };
}

/**
 * What the phone sent, as the webhook would have parsed it. Only this store's number and customer.
 * With a `clientMessageId`, a retried send keeps its message ID, so intake records it once (message
 * IDs are unique per store); without one, every send is new.
 */
export function inboundEvent(store: DemoStore, input: unknown, nowMs: number): InboundMessageEvent | null {
  if (typeof input !== "object" || input === null) return null;
  const body = input as { preset?: unknown; text?: unknown; reply?: unknown; title?: unknown; clientMessageId?: unknown };
  let providerMessageId = `demo.${crypto.randomUUID()}`;
  if (body.clientMessageId !== undefined) {
    if (typeof body.clientMessageId !== "string" || !CLIENT_MESSAGE_ID.test(body.clientMessageId)) return null;
    providerMessageId = `demo.client.${body.clientMessageId}`;
  }
  const base = {
    type: "message" as const,
    phoneNumberId: store.phoneNumberId,
    senderPhone: store.customerPhone,
    providerMessageId,
    providerTimestampS: Math.floor(nowMs / 1000),
    replyId: null,
    contextMessageId: null,
    media: null,
  };
  if (isDemoPreset(body.preset)) {
    const preset = DEMO_PRESETS[body.preset];
    if (preset.kind === "text") return { ...base, kind: "text", textBody: preset.body };
    return { ...base, kind: preset.kind, textBody: null, media: { providerMediaId: preset.mediaId, mimeType: preset.mimeType, sha256: null } };
  }
  if (typeof body.reply === "string" && typeof body.title === "string") {
    const replyId = body.reply.trim();
    const title = body.title.trim();
    if (replyId === "" || replyId.length > 256 || title === "" || title.length > 40) return null;
    return { ...base, kind: "interactive", textBody: title, replyId };
  }
  if (typeof body.text === "string") {
    const text = body.text.trim();
    if (text === "" || text.length > DEMO_MAX_TEXT) return null;
    return { ...base, kind: "text", textBody: text };
  }
  return null;
}

function binary(base64: string, contentType: string): Response {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": contentType, "cache-control": "public, max-age=86400" } });
}
