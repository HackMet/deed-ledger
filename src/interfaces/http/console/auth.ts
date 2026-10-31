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
};
const DEV_CSRF = "dev";

const COPY = {
  enterTitle: "Entrar a la consola",
  enterBody: (store: string) => `Vas a entrar a la consola de ${store}.`,
  enterButton: "Entrar",
  inviteUnusable: "Este código ya no sirve. Pedí uno nuevo en la tienda.",
  loginNeeded: "Para entrar, escaneá el código que te dan en la tienda.",
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
    return c.redirect("/console/preparacion", 303);
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
    c.set("member", DEV_MEMBER);
    c.set("csrf", DEV_CSRF);
    return next();
  }
  if (config.linkSigningSecret === "") return notReady(c);
  const member = await sessionMember(c);
  if (member === null) return c.html(simplePage(COPY.enterTitle, html`<p>${COPY.loginNeeded}</p>`), 401);
  c.set("member", member);
  c.set("csrf", await csrfToken(config.linkSigningSecret, member.sessionId));
  return next();
};

const MAX_FORM_BYTES = 16 * 1024;
const crossSiteCheck = csrf();
const sizeCheck = bodyLimit({ maxSize: MAX_FORM_BYTES, onError: (c) => formRefused(c, 413) });

/**
 * Refuses form posts from another site, the login form included (its invite would otherwise let a
 * stranger swap the victim's session for one in their store), and forms larger than any console form.
 */
export const sameSiteForms: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  try {
    await crossSiteCheck(c, async () => {});
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) return formRefused(c, 403);
    throw error;
  }
  return sizeCheck(c, next);
};

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

export function simplePage(title: string, body: unknown) {
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{margin:0;padding:24px 18px;font:17px/1.5 system-ui,sans-serif;background:#f4f4f2;color:#1b1b1b}
h1{font-size:20px}button{min-height:48px;width:100%;font-size:17px;border:0;border-radius:8px;background:#2f6f45;color:#fff}
li{padding:6px 0}</style>
</head>
<body><h1>${title}</h1>${body}</body>
</html>`;
}
