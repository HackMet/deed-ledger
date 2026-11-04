/**
 * Empleados (owner only): invite someone, make a new login code, turn the fiado permission on or
 * off, and "Quitar" (deactivate and end every session on every phone).
 *
 * The store is always the session's. A person's ID from a form is only ever used together with that
 * store, and only staff can be changed here: owners are managed with `npm run admin:invite`, so an
 * owner can't lock themselves out from the console.
 */
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import type { MemberSummary } from "../../../application/ports";
import { INVITE_TTL_MS } from "../../../domain/console-auth";
import { hashToken, newToken } from "../../../infrastructure/tokens";
import { type ConsoleEnv, requireOwner } from "./auth";
import { csrfField, shell } from "./layout";

const PATH = "/console/empleados";
const MAX_NAME = 120;
/** Empleados is opened from Más: the tab it lights, and where "←" goes. */
const FROM = "/console/mas";
const SUBTITLE = "Quién entra a la consola";

const NOTICES = {
  quitado: "Listo. Esa persona ya no puede entrar a la consola.",
  fiado_si: "Listo. Ya puede aprobar fiado.",
  fiado_no: "Listo. Ya no aprueba fiado.",
  falta: "Esa persona ya no está en la lista de empleados.",
  dueno: "Ese número es del dueño. Al dueño no se le invita desde aquí.",
  telefono: "No pude leer ese número. Escribilo así: 9999-9999.",
} as const;
type NoticeKey = keyof typeof NOTICES;

export function empleadosScreen(app: Hono<ConsoleEnv>) {
  app.get("/empleados", requireOwner, async (c) => {
    const members = await c.get("runtime").deps.consoleAuth.listMembers(c.get("member"));
    const notice = c.req.query("aviso");
    const csrf = c.get("csrf");
    return c.html(
      shell(c, {
        title: "Empleados",
        subtitle: SUBTITLE,
        back: FROM,
        path: PATH,
        tab: FROM,
        notice: notice !== undefined && Object.hasOwn(NOTICES, notice) ? NOTICES[notice as NoticeKey] : null,
        style: STYLE,
        body: html`${inviteForm(csrf)}${members.map((m) => memberCard(m, csrf))}`,
      }),
    );
  });

  app.post("/empleados/invitar", requireOwner, async (c) => {
    const { deps } = c.get("runtime");
    const form = await c.req.parseBody();
    const phone = parsePhone(form["telefono"]);
    if (phone === null) return back(c, "telefono");
    const name = typeof form["nombre"] === "string" ? cleanName(form["nombre"]) : null;
    const member = c.get("member");
    const person = await deps.consoleAuth.addStaff(member, { phone, displayName: name, nowMs: deps.clock.now() });
    if (person.role !== "staff") return back(c, "dueno");
    return inviteFor(c, person.userId);
  });

  app.post("/empleados/codigo", requireOwner, async (c) => {
    const userId = personField(await c.req.parseBody());
    if (userId === null) return c.text("Bad request", 400);
    return inviteFor(c, userId);
  });

  app.get("/empleados/quitar", requireOwner, async (c) => {
    const userId = c.req.query("persona");
    const members = await c.get("runtime").deps.consoleAuth.listMembers(c.get("member"));
    // Looked up in this store's own list: an ID from elsewhere finds nothing.
    const target = members.find((m) => m.userId === userId && m.role === "staff" && m.active);
    if (target === undefined) return back(c, "falta");
    const name = target.displayName ?? "esta persona";
    return c.html(
      shell(c, {
        title: "Empleados",
        subtitle: SUBTITLE,
        back: FROM,
        path: PATH,
        tab: FROM,
        style: STYLE,
        body: html`<section class="card">
<h2>¿Quitar a ${name}?</h2>
<p>Ya no va a poder entrar a la consola en ningún teléfono. Si vuelve, le hacés un código nuevo.</p>
<form method="post" action="${PATH}/quitar">${csrfField(c.get("csrf"))}<input type="hidden" name="persona" value="${target.userId}"><button class="primary danger-fill">Sí, quitar</button></form>
<p class="cancel"><a href="${PATH}">Cancelar</a></p>
</section>`,
      }),
    );
  });

  app.post("/empleados/quitar", requireOwner, async (c) => {
    const { deps } = c.get("runtime");
    const userId = personField(await c.req.parseBody());
    if (userId === null) return c.text("Bad request", 400);
    const member = c.get("member");
    const nowMs = deps.clock.now();
    // Deactivation and ending every session are one write, so an old session can't survive to come
    // back if the person is invited again.
    const removed = await deps.consoleAuth.removeStaff(member, userId, nowMs);
    if (removed === null) return back(c, "falta");
    deps.log.info("console_member_removed", { businessId: member.businessId, count: removed.sessionsEnded });
    return back(c, "quitado");
  });

  app.post("/empleados/fiado", requireOwner, async (c) => {
    const { deps } = c.get("runtime");
    const form = await c.req.parseBody();
    const userId = personField(form);
    const allow = form["permitir"];
    if (userId === null || (allow !== "1" && allow !== "0")) return c.text("Bad request", 400);
    const member = c.get("member");
    if (!(await deps.consoleAuth.setFiadoPermission(member, userId, allow === "1"))) return back(c, "falta");
    deps.log.info("console_fiado_permission", { businessId: member.businessId, outcome: allow === "1" ? "allowed" : "not_allowed" });
    return back(c, allow === "1" ? "fiado_si" : "fiado_no");
  });
}

/** Makes a single-use code for a staff member of the session's store and shows its link. */
async function inviteFor(c: Context<ConsoleEnv>, userId: string) {
  const { deps } = c.get("runtime");
  const member = c.get("member");
  const code = newToken();
  const nowMs = deps.clock.now();
  const person = await deps.consoleAuth.createStaffInvite(member, userId, {
    id: deps.ids.newId(),
    tokenHash: await hashToken(code),
    nowMs,
    expiresAtMs: nowMs + INVITE_TTL_MS,
  });
  if (person === null) return back(c, "falta");
  deps.log.info("console_invite_created", { businessId: member.businessId });

  const link = `${new URL(c.req.url).origin}/console/entrar?codigo=${code}`;
  const message = `Para entrar a la consola de la tienda, abrí este enlace y tocá Entrar: ${link}`;
  const name = person.displayName ?? "Esta persona";
  // The link opens a session for someone else; it's shown as text, not as a link the owner might tap.
  c.header("Cache-Control", "no-store");
  return c.html(
    shell(c, {
      title: "Empleados",
      subtitle: SUBTITLE,
      back: FROM,
      path: PATH,
      tab: FROM,
      style: STYLE,
      body: html`<section class="card">
<h2>Código para ${person.displayName ?? "entrar"}</h2>
<p>${name} abre este enlace en su teléfono y toca Entrar. Sirve una sola vez y vence en 15 minutos.</p>
<input class="link" readonly value="${link}" aria-label="Enlace para entrar">
<p><a class="button primary" href="https://wa.me/${person.phone}?text=${encodeURIComponent(message)}">Mandarlo por WhatsApp</a></p>
<p class="cancel"><a href="${PATH}">Volver a Empleados</a></p>
</section>`,
    }),
  );
}

function back(c: Context<ConsoleEnv>, notice: NoticeKey) {
  return c.redirect(`${PATH}?aviso=${notice}`, 303);
}

function personField(form: Record<string, unknown>): string | null {
  const value = form["persona"];
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

/**
 * A WhatsApp number as digits only (E.164 without "+"). Eight digits is a Honduran number and gets
 * 504 in front; anything else must already carry its country code.
 */
export function parsePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.trim().replace(/^\+/, "").replace(/[\s\-().]/g, "");
  if (!/^[0-9]+$/.test(digits)) return null;
  const full = digits.length === 8 ? `504${digits}` : digits;
  return full.length >= 10 && full.length <= 15 ? full : null;
}

function cleanName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ").slice(0, MAX_NAME).trim();
  return name === "" ? null : name;
}

// ---------------------------------------------------------------------------------------------
// Rendering. `html` escapes every interpolated string.

function inviteForm(csrf: string) {
  return html`<section class="card">
<h2>Invitar a alguien</h2>
<form method="post" action="${PATH}/invitar">${csrfField(csrf)}
<label>Nombre<input name="nombre" maxlength="${MAX_NAME}" autocomplete="off"></label>
<label>Teléfono<input name="telefono" inputmode="tel" placeholder="9999-9999" required></label>
<button class="primary">Hacer código</button>
</form>
</section>`;
}

function memberCard(m: MemberSummary, csrf: string) {
  const name = m.displayName ?? "Sin nombre";
  if (m.role === "owner") {
    return html`<section class="card member"><div class="head"><strong>${name}</strong><span>Dueño</span></div></section>`;
  }
  if (!m.active) {
    return html`<section class="card member off"><div class="head"><strong>${name}</strong><span>Quitado</span></div>
<form method="post" action="${PATH}/codigo">${csrfField(csrf)}<input type="hidden" name="persona" value="${m.userId}"><button>Volver a invitar</button></form>
</section>`;
  }
  return html`<section class="card member"><div class="head"><strong>${name}</strong><span>Empleado</span></div>
<p class="meta">${m.canApproveFiado ? "Puede aprobar fiado" : "No aprueba fiado"}</p>
<div class="buttons">
<form method="post" action="${PATH}/fiado">${csrfField(csrf)}<input type="hidden" name="persona" value="${m.userId}"><input type="hidden" name="permitir" value="${m.canApproveFiado ? "0" : "1"}"><button>${m.canApproveFiado ? "Quitar fiado" : "Permitir fiado"}</button></form>
<form method="post" action="${PATH}/codigo">${csrfField(csrf)}<input type="hidden" name="persona" value="${m.userId}"><button>Código nuevo</button></form>
<a class="button danger" href="${PATH}/quitar?persona=${encodeURIComponent(m.userId)}">Quitar</a>
</div>
</section>`;
}

const STYLE = `
input.link{font-size:14px;background:var(--cream)}
.head{display:flex;justify-content:space-between;align-items:center;gap:8px}.head strong{font-size:18px;font-weight:800}
.head span{flex:none;padding:3px 10px;border-radius:8px;background:var(--soft);color:var(--green);font-size:13px;font-weight:800}
.member.off{background:var(--cream)}.meta{margin:6px 0 10px;font-size:15px;color:var(--mute)}
.buttons{display:flex;flex-wrap:wrap;gap:8px}
.cancel{text-align:center;margin-top:14px}
`;
