/**
 * Console login. A member opens an invite link (from a QR) and taps "Entrar": that POST uses the
 * invite and opens a session in one batch. A GET never uses an invite, so a link preview can't burn
 * it. Every request re-reads the session and the membership. Forms carry a CSRF value derived from
 * the session. Dev mode (the local simulator only) skips all of this with a fixed demo member.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
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
    if (preview === null) return c.html(simplePage(COPY.enterTitle, html`<p>${COPY.inviteUnusable}</p>`), 400);
    return c.html(
      simplePage(
        COPY.enterTitle,
        html`<p>${COPY.enterBody(preview.storeName)}</p>
<form method="post" action="/console/entrar"><input type="hidden" name="codigo" value="${code}"><button>${COPY.enterButton}</button></form>`,
      ),
    );
  });

  app.post("/entrar", async (c) => {
    const { config, deps } = c.get("runtime");
    if (config.devConsole) return c.redirect("/console/preparacion", 303);
    if (config.linkSigningSecret === "") return notReady(c);
    const form = await c.req.parseBody();
    const code = form["codigo"];
    if (!isWellFormedToken(code)) return c.html(simplePage(COPY.enterTitle, html`<p>${COPY.inviteUnusable}</p>`), 400);
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
      return c.html(simplePage(COPY.enterTitle, html`<p>${COPY.inviteUnusable}</p>`), 400);
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

/** Every console page and action after this needs an open session of an active member. */
export const requireMember: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  const { config, deps } = c.get("runtime");
  if (config.devConsole) {
    c.set("member", DEV_MEMBER);
    c.set("csrf", DEV_CSRF);
    return next();
  }
  if (config.linkSigningSecret === "") return notReady(c);
  const token = getCookie(c, SESSION_COOKIE);
  const member = isWellFormedToken(token) ? await deps.consoleAuth.findSession(await hashToken(token), deps.clock.now()) : null;
  if (member === null) return c.html(simplePage(COPY.enterTitle, html`<p>${COPY.loginNeeded}</p>`), 401);
  c.set("member", member);
  c.set("csrf", await csrfToken(config.linkSigningSecret, member.sessionId));
  return next();
};

/** A POST must carry the session's CSRF value. */
export const requireCsrf: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  if (c.req.method !== "POST") return next();
  const sent = (await c.req.parseBody())["csrf"];
  if (typeof sent !== "string" || !sameToken(sent, c.get("csrf"))) {
    c.get("runtime").deps.log.warn("console_csrf_refused", { businessId: c.get("member").businessId });
    return c.html(simplePage("Consola", html`<p>${COPY.formExpired}</p><p><a href="/console/preparacion">Volver</a></p>`), 403);
  }
  return next();
};

export const requireOwner: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  if (c.get("member").role !== "owner") return c.html(simplePage("Consola", html`<p>${COPY.ownerOnly}</p>`), 403);
  return next();
};

function notReady(c: Context<ConsoleEnv>) {
  c.get("runtime").deps.log.error("console_not_configured");
  return c.html(simplePage("Consola", html`<p>${COPY.notReady}</p>`), 503);
}
