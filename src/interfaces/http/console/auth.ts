/**
 * Console login. A member opens an invite link (from a QR) and taps "Entrar": that POST uses the
 * invite and opens a session in one batch. A GET never uses an invite, so a link preview can't burn
 * it. Every request re-reads the session and the membership. Forms carry a CSRF value derived from
 * the session. Dev mode (the local simulator only) skips all of this with a fixed demo member.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { html } from "hono/html";
import { HTTPException } from "hono/http-exception";
import type { MemberContext } from "../../../application/engine";
import type { ConsoleMember } from "../../../application/ports";
import type { Runtime } from "../../../composition";
import { isWellFormedToken, SESSION_COOKIE, SESSION_TTL_MS } from "../../../domain/console-auth";
import { csrfToken, hashToken, newToken, sameToken } from "../../../infrastructure/tokens";
import { simplePage } from "./layout";

export type ConsoleEnv = {
  Bindings: Env;
  Variables: { runtime: Runtime; member: ConsoleMember; csrf: string };
};

const DEV_MEMBER: ConsoleMember = {
  businessId: "dev-store",
  userId: "dev-staff",
  sessionId: "dev",
  role: "staff",
  canApproveFiado: false,
  displayName: "Rosa",
};
const DEV_CSRF = "dev";

const COPY = {
  enterTitle: "Entrar a la consola",
  enterBody: (store: string) => `Vas a entrar a la consola de ${store}.`,
  enterButton: "Entrar",
  inviteUnusable: "Este código ya no sirve. Pedí uno nuevo en la tienda.",
  loginNeeded: "Para entrar, escaneá el código que te dan en la tienda.",
  tryDemo: "¿Querés probarlo? Abrí una tienda de demostración",
  ownerOnly: "Esta parte es solo para el dueño.",
  formExpired: "Esa acción venció. Volvé a la lista e intentá otra vez.",
  notReady: "La consola no está lista todavía.",
};

/** The member a console handler acts for, as the engine expects it. */
export function memberContext(c: Context<ConsoleEnv>): MemberContext {
  const member = c.get("member");
  return {
    businessId: member.businessId,
    memberId: member.userId,
    role: member.role,
    canApproveFiado: member.canApproveFiado,
    nowMs: c.get("runtime").deps.clock.now(),
  };
}

/** GET shows the invite; POST uses it. Mounted before `requireMember`. */
export function registerEntryRoutes(app: Hono<ConsoleEnv>) {
  app.get("/entrar", async (c) => {
    const { config, deps } = c.get("runtime");
    if (config.devConsole) return c.redirect("/console/preparacion", 302);
    if (config.linkSigningSecret === "") return notReady(c);
    const code = c.req.query("codigo");
    const preview = isWellFormedToken(code) ? await deps.consoleAuth.previewInvite(await hashToken(code), deps.clock.now()) : null;
    if (preview === null) return inviteRefused(c);
    return c.html(
      simplePage(
        COPY.enterTitle,
        html`<p>${COPY.enterBody(preview.storeName)}</p>
<form method="post" action="/console/entrar" onsubmit="this.querySelector('button').disabled = true"><input type="hidden" name="codigo" value="${code}"><button>${COPY.enterButton}</button></form>`,
      ),
    );
  });

  app.post("/entrar", async (c) => {
    const { config, deps } = c.get("runtime");
    if (config.devConsole) return c.redirect("/console/preparacion", 303);
    if (config.linkSigningSecret === "") return notReady(c);
    const form = await c.req.parseBody();
    const code = form["codigo"];
    if (!isWellFormedToken(code)) return inviteRefused(c);
    const token = newToken();
    const nowMs = deps.clock.now();
    const member = await deps.consoleAuth.acceptInvite(await hashToken(code), {
      id: deps.ids.newId(),
      tokenHash: await hashToken(token),
      nowMs,
      expiresAtMs: nowMs + SESSION_TTL_MS,
    });
    if (member === null) {
      deps.log.info("console_invite_refused");
      return inviteRefused(c);
    }
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/console",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    deps.log.info("console_session_opened", { businessId: member.businessId });
    // Until the member has read the voice-note notice, logging in shows it first.
    const seen = await deps.consoleAuth.voiceNoticeSeen(member, member.userId);
    return c.redirect(seen ? "/console/preparacion" : "/console/bienvenida", 303);
  });
}

/** The QR opened again, or a second tap that already carries the cookie: go to the list. */
async function inviteRefused(c: Context<ConsoleEnv>) {
  if ((await sessionMember(c)) !== null) return c.redirect("/console/preparacion", 303);
  return c.html(simplePage(COPY.enterTitle, html`<p>${COPY.inviteUnusable}</p>`), 400);
}

async function sessionMember(c: Context<ConsoleEnv>): Promise<ConsoleMember | null> {
  const { deps } = c.get("runtime");
  const token = getCookie(c, SESSION_COOKIE);
  return isWellFormedToken(token) ? deps.consoleAuth.findSession(await hashToken(token), deps.clock.now()) : null;
}

/** Every console page and action after this needs an open session of an active member. */
export const requireMember: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  const { config } = c.get("runtime");
  if (config.devConsole) {
    // The simulator store's owner, so its console shows the orders typed in `npm run chat`; without
    // that store, a fixed staff member of an empty demo store.
    const owner = config.devStorePhoneNumberId === "" ? null : await c.get("runtime").deps.consoleAuth.devOwner(config.devStorePhoneNumberId);
    c.set("member", owner ?? DEV_MEMBER);
    c.set("csrf", DEV_CSRF);
    return next();
  }
  if (config.linkSigningSecret === "") return notReady(c);
  const member = await sessionMember(c);
  if (member === null) {
    return c.html(simplePage(COPY.enterTitle, html`<p>${COPY.loginNeeded}</p><p><a href="/demo">${COPY.tryDemo}</a></p>`), 401);
  }
  c.set("member", member);
  c.set("csrf", await csrfToken(config.linkSigningSecret, member.sessionId));
  return next();
};

const MAX_FORM_BYTES = 16 * 1024;
/** The invoice upload (K14): a 10 MB photo and the multipart framing around it. */
export const INVOICE_UPLOAD_PATH = "/console/facturas/nueva";
const MAX_UPLOAD_FORM_BYTES = 10 * 1024 * 1024 + 64 * 1024;
const crossSiteCheck = csrf();
const sizeCheck = bodyLimit({ maxSize: MAX_FORM_BYTES, onError: (c) => formRefused(c, 413) });
/** Mounted in `index.ts` before the CSRF check, which reads the whole body. */
export const invoiceUploadLimit = bodyLimit({ maxSize: MAX_UPLOAD_FORM_BYTES, onError: (c) => c.redirect(`${INVOICE_UPLOAD_PATH}?aviso=tamano`, 303) });

/**
 * Refuses form posts from another site, the login form included (its invite would otherwise let a
 * stranger swap the victim's session for one in their store), and forms larger than any console form.
 * Screens that take uploads (`uploadPaths`) set their own size limit instead.
 */
export function sameSiteForms(uploadPaths: readonly string[] = []): MiddlewareHandler<ConsoleEnv> {
  return async (c, next) => {
    try {
      await crossSiteCheck(c, async () => {});
    } catch (error) {
      if (error instanceof HTTPException && error.status === 403) return formRefused(c, 403);
      throw error;
    }
    return uploadPaths.includes(c.req.path) ? next() : sizeCheck(c, next);
  };
}

/** A POST must carry the session's CSRF value. */
export const requireCsrf: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  if (c.req.method !== "POST") return next();
  const sent = (await c.req.parseBody())["csrf"];
  if (typeof sent !== "string" || !sameToken(sent, c.get("csrf"))) {
    c.get("runtime").deps.log.warn("console_csrf_refused", { businessId: c.get("member").businessId });
    return formRefused(c, 403);
  }
  return next();
};

function formRefused(c: Context<ConsoleEnv>, status: 403 | 413) {
  return c.html(simplePage("Consola", html`<p>${COPY.formExpired}</p><p><a href="/console/preparacion">Volver</a></p>`), status);
}

export const requireOwner: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  if (c.get("member").role !== "owner") return c.html(simplePage("Consola", html`<p>${COPY.ownerOnly}</p>`), 403);
  return next();
};

function notReady(c: Context<ConsoleEnv>) {
  c.get("runtime").deps.log.error("console_not_configured");
  return c.html(simplePage("Consola", html`<p>${COPY.notReady}</p>`), 503);
}
