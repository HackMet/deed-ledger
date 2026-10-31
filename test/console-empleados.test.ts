import { describe, expect, it } from "vitest";
import { demoOrders } from "../src/infrastructure/memory/demo-orders";
import { MemoryEngine } from "../src/infrastructure/memory/memory-engine";
import { hashToken } from "../src/infrastructure/tokens";
import { csrfFor, invite, login, send, storeWithStaff } from "./helpers/console";
import { type Harness, harness, rows } from "./helpers/harness";
import { newPhone } from "./helpers/seed";

/** Eight digits as an owner types them, starting with 0 so no real number matches. */
const localPhone = () => `0${newPhone().slice(5)}`;

const consoleHarness = () => harness({ engine: new MemoryEngine(() => demoOrders(0)) });

async function membership(businessId: string, userId: string) {
  const [row] = await rows<{ role: string; active: number; can_approve_fiado: number }>(
    `SELECT role, active, can_approve_fiado FROM memberships WHERE business_id = ? AND user_id = ?`,
    businessId,
    userId,
  );
  return row;
}

async function nameIn(businessId: string, userId: string) {
  const [row] = await rows<{ display_name: string | null }>(
    `SELECT display_name FROM memberships WHERE business_id = ? AND user_id = ?`,
    businessId,
    userId,
  );
  return row?.display_name;
}

/** A store with its owner logged in, and the owner's CSRF value. */
async function ownerSession(h: Harness) {
  const store = await storeWithStaff();
  const [owner, staff] = store.members as [(typeof store.members)[number], (typeof store.members)[number]];
  const cookie = await login(h, store.businessId, owner.userId);
  const csrf = await csrfFor(h, cookie);
  const post = (path: string, form: Record<string, string>, origin?: string) =>
    send(h, path, { method: "POST", form: { csrf, ...form }, cookie, ...(origin === undefined ? {} : { origin }) });
  return { store, owner, staff, cookie, csrf, post };
}

const codeIn = (page: string) => /\/console\/entrar\?codigo=([A-Za-z0-9_-]{43})/.exec(page)?.[1];

describe("the shared layout", () => {
  it("renders the list and Empleados, each from its own file, inside the same layout and tabs", async () => {
    const h = consoleHarness();
    const { cookie } = await ownerSession(h);
    for (const [path, title] of [
      ["/console/preparacion", "Pedidos por preparar"],
      ["/console/empleados", "Empleados"],
    ] as const) {
      const response = await send(h, path, { cookie });
      expect(response.status, path).toBe(200);
      const page = await response.text();
      expect(page).toContain('<body data-layout="console">');
      expect(page).toContain(`<h1>${title}</h1>`);
      expect(page).toContain(`<a href="${path}" aria-current="page">`);
      expect(page).toContain('<a href="/console/preparacion"');
      expect(page).toContain('<a href="/console/empleados"');
    }
  });

  it("hides the Empleados tab from staff", async () => {
    const h = consoleHarness();
    const store = await storeWithStaff();
    const cookie = await login(h, store.businessId, store.members[1]!.userId);
    const page = await (await send(h, "/console/preparacion", { cookie })).text();
    expect(page).toContain('<body data-layout="console">');
    expect(page).not.toContain('href="/console/empleados"');
  });
});

describe("the first-login notice", () => {
  it("shows the voice-note notice on first login until Entendido, then goes straight to the list", async () => {
    const h = consoleHarness();
    const store = await storeWithStaff();
    const staff = store.members[1]!.userId;
    const first = await send(h, "/console/entrar", { method: "POST", form: { codigo: await invite(h, store.businessId, staff) } });
    expect(first.headers.get("location")).toBe("/console/bienvenida");
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;

    const notice = await send(h, "/console/bienvenida", { cookie });
    const page = await notice.text();
    expect(page).toContain("Las notas de voz que le mandés al WhatsApp de la tienda se guardan como registro de la tienda.");
    expect(page).toContain('<body data-layout="console">');

    const csrf = await csrfFor(h, cookie);
    expect((await send(h, "/console/bienvenida", { method: "POST", form: {}, cookie })).status).toBe(403);
    const ok = await send(h, "/console/bienvenida", { method: "POST", form: { csrf }, cookie });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/console/preparacion");

    const again = await send(h, "/console/entrar", { method: "POST", form: { codigo: await invite(h, store.businessId, staff) } });
    expect(again.headers.get("location")).toBe("/console/preparacion");
  });
});

describe("Empleados", () => {
  it("is for the owner only, pages and actions alike", async () => {
    const h = consoleHarness();
    const { store, owner } = await ownerSession(h);
    const staffCookie = await login(h, store.businessId, store.members[1]!.userId);
    const csrf = await csrfFor(h, staffCookie);
    expect((await send(h, "/console/empleados", { cookie: staffCookie })).status).toBe(403);
    for (const [path, form] of [
      ["/console/empleados/invitar", { telefono: "99999999" }],
      ["/console/empleados/codigo", { persona: owner.userId }],
      ["/console/empleados/quitar", { persona: owner.userId }],
      ["/console/empleados/fiado", { persona: store.members[1]!.userId, permitir: "1" }],
    ] as const) {
      const refused = await send(h, path, { method: "POST", form: { csrf, ...form }, cookie: staffCookie });
      expect(refused.status, path).toBe(403);
    }
    expect(await membership(store.businessId, store.members[1]!.userId)).toMatchObject({ active: 1, can_approve_fiado: 0 });
  });

  it("invites a new person: the code logs them in as staff of this store", async () => {
    const h = consoleHarness();
    const { store, post } = await ownerSession(h);
    const local = localPhone();
    const response = await post("/console/empleados/invitar", { nombre: "  Carla   Núñez ", telefono: `${local.slice(0, 4)}-${local.slice(4)}` });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.text();
    expect(page).toContain("Código para Carla Núñez");
    expect(page).toContain(`https://wa.me/504${local}?text=`);
    const code = codeIn(page);
    expect(code).toBeDefined();

    const [user] = await rows<{ id: string; display_name: string | null }>(`SELECT id, display_name FROM users WHERE phone = ?`, `504${local}`);
    // The name is this store's: it sits on the membership, never on the person's shared record.
    expect(user).toMatchObject({ display_name: null });
    expect(await membership(store.businessId, user!.id)).toMatchObject({ role: "staff", active: 1, can_approve_fiado: 0 });
    expect(await nameIn(store.businessId, user!.id)).toBe("Carla Núñez");

    const entered = await send(h, "/console/entrar", { method: "POST", form: { codigo: code! } });
    expect(entered.status).toBe(303);
    const cookie = entered.headers.get("set-cookie")!.split(";")[0]!;
    const [session] = await rows<{ business_id: string; user_id: string }>(
      `SELECT s.business_id, s.user_id FROM console_sessions s JOIN users u ON u.id = s.user_id WHERE u.phone = ?`,
      `504${local}`,
    );
    expect(session).toEqual({ business_id: store.businessId, user_id: user!.id });
    expect((await send(h, "/console/empleados", { cookie })).status).toBe(403);
  });

  it("asks again for a number it can't read, and won't invite the owner", async () => {
    const h = consoleHarness();
    const { owner, post, cookie } = await ownerSession(h);
    for (const telefono of ["", "abc", "1234", "9".repeat(16)]) {
      const response = await post("/console/empleados/invitar", { telefono });
      expect(response.headers.get("location"), telefono).toBe("/console/empleados?aviso=telefono");
    }
    const refused = await post("/console/empleados/invitar", { telefono: `+${owner.phone}` });
    expect(refused.headers.get("location")).toBe("/console/empleados?aviso=dueno");
    expect(await rows(`SELECT id FROM console_invites WHERE user_id = ?`, owner.userId)).toHaveLength(1);
    const page = await (await send(h, "/console/empleados?aviso=dueno", { cookie })).text();
    expect(page).toContain("Ese número es del dueño.");
    // Only the screen's own notices: an inherited name like toString shows nothing.
    const odd = await (await send(h, "/console/empleados?aviso=toString", { cookie })).text();
    expect(odd).not.toContain("function");
  });

  it("Quitar ends every session of that person on the next request, and only theirs", async () => {
    const h = consoleHarness();
    const { store, staff, cookie: ownerCookie, post } = await ownerSession(h);
    const phoneA = await login(h, store.businessId, staff.userId);
    const phoneB = await login(h, store.businessId, staff.userId);
    const unused = await invite(h, store.businessId, staff.userId);
    expect((await send(h, "/console/preparacion", { cookie: phoneA })).status).toBe(200);

    const confirm = await send(h, `/console/empleados/quitar?persona=${staff.userId}`, { cookie: ownerCookie });
    expect(await confirm.text()).toContain("Ya no va a poder entrar a la consola en ningún teléfono.");

    const removed = await post("/console/empleados/quitar", { persona: staff.userId });
    expect(removed.headers.get("location")).toBe("/console/empleados?aviso=quitado");
    expect((await send(h, "/console/preparacion", { cookie: phoneA })).status).toBe(401);
    expect((await send(h, "/console/preparacion", { cookie: phoneB })).status).toBe(401);
    expect(await membership(store.businessId, staff.userId)).toMatchObject({ active: 0 });
    const open = await rows(`SELECT id FROM console_sessions WHERE user_id = ? AND revoked_at_ms IS NULL`, staff.userId);
    expect(open).toHaveLength(0);
    expect((await send(h, "/console/preparacion", { cookie: ownerCookie })).status).toBe(200);

    // Re-added later: the old sessions and the unused invite stay dead; a new code works.
    const again = await post("/console/empleados/codigo", { persona: staff.userId });
    expect(again.status).toBe(200);
    expect((await send(h, "/console/preparacion", { cookie: phoneA })).status).toBe(401);
    expect((await send(h, "/console/entrar", { method: "POST", form: { codigo: unused } })).status).toBe(400);
    const fresh = await send(h, "/console/entrar", { method: "POST", form: { codigo: codeIn(await again.text())! } });
    expect(fresh.status).toBe(303);
  });

  it("can't target another store's member, nor the owner", async () => {
    const h = consoleHarness();
    const { store, owner, cookie: ownerCookie, post } = await ownerSession(h);
    const other = await storeWithStaff();
    const otherStaff = other.members[1]!.userId;
    const otherCookie = await login(h, other.businessId, otherStaff);

    expect((await send(h, `/console/empleados/quitar?persona=${otherStaff}`, { cookie: ownerCookie })).headers.get("location")).toBe(
      "/console/empleados?aviso=falta",
    );
    for (const [path, form] of [
      ["/console/empleados/quitar", { persona: otherStaff }],
      ["/console/empleados/fiado", { persona: otherStaff, permitir: "1" }],
      ["/console/empleados/codigo", { persona: otherStaff }],
      ["/console/empleados/quitar", { persona: owner.userId }],
      ["/console/empleados/fiado", { persona: owner.userId, permitir: "0" }],
      ["/console/empleados/codigo", { persona: owner.userId }],
    ] as const) {
      const response = await post(path, form);
      expect(response.headers.get("location"), `${path} ${form.persona}`).toBe("/console/empleados?aviso=falta");
    }
    expect(await membership(other.businessId, otherStaff)).toMatchObject({ active: 1, can_approve_fiado: 0 });
    expect(await rows(`SELECT id FROM console_invites WHERE user_id = ?`, otherStaff)).toHaveLength(1);
    expect((await send(h, "/console/preparacion", { cookie: otherCookie })).status).toBe(200);
    expect(await membership(store.businessId, owner.userId)).toMatchObject({ role: "owner", active: 1 });
    expect((await send(h, "/console/empleados", { cookie: ownerCookie })).status).toBe(200);
  });

  it("keeps each store's name for a person to itself, both ways", async () => {
    const h = consoleHarness();
    const a = await ownerSession(h);
    const b = await ownerSession(h);
    // B names one member and leaves another unnamed; both phones also get invited by A.
    const named = localPhone();
    const blank = localPhone();
    await b.post("/console/empleados/invitar", { nombre: "Nombre que puso B", telefono: named });
    await b.post("/console/empleados/invitar", { telefono: blank });
    const bListBefore = await (await send(h, "/console/empleados", { cookie: b.cookie })).text();

    const shownToA = await (await a.post("/console/empleados/invitar", { telefono: named })).text();
    expect(shownToA).not.toContain("Nombre que puso B");
    expect(shownToA).toContain("Código para entrar");
    const filledByA = await (await a.post("/console/empleados/invitar", { nombre: "Nombre que puso A", telefono: blank })).text();
    expect(filledByA).toContain("Código para Nombre que puso A");
    // A typing B's owner's phone is refused and writes no name B's customers would see.
    await a.post("/console/empleados/invitar", { nombre: "Nombre que puso A", telefono: `+${b.owner.phone}` });

    const aList = await (await send(h, "/console/empleados", { cookie: a.cookie })).text();
    expect(aList).not.toContain("Nombre que puso B");
    expect(aList).toContain("Nombre que puso A");
    const bListAfter = await (await send(h, "/console/empleados", { cookie: b.cookie })).text();
    expect(bListAfter).not.toContain("Nombre que puso A");
    expect(bListAfter.replace(/value="[0-9a-f]{64}"/g, "")).toBe(bListBefore.replace(/value="[0-9a-f]{64}"/g, ""));

    const people = await rows<{ display_name: string | null }>(
      `SELECT display_name FROM users WHERE phone IN (?, ?, ?)`,
      `504${named}`,
      `504${blank}`,
      b.owner.phone,
    );
    expect(people).toEqual([{ display_name: null }, { display_name: null }, { display_name: null }]);
  });

  it("removes a person all at once: if ending the sessions fails, nothing changed", async () => {
    const h = consoleHarness();
    const { store, staff, post } = await ownerSession(h);
    const oldCookie = await login(h, store.businessId, staff.userId);
    const unused = await invite(h, store.businessId, staff.userId);
    // Make the session revocation step fail for this person only.
    const trigger = `fail_revoke_${crypto.randomUUID().replaceAll("-", "")}`;
    await rows(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE OF revoked_at_ms ON console_sessions
       WHEN OLD.user_id = '${staff.userId}' BEGIN SELECT RAISE(ABORT, 'test: revocation fails'); END`,
    );
    try {
      await expect(h.deps.consoleAuth.removeStaff(store, staff.userId, h.clock.now())).rejects.toThrow();
    } finally {
      await rows(`DROP TRIGGER ${trigger}`);
    }
    expect(await membership(store.businessId, staff.userId)).toMatchObject({ active: 1 });
    expect(await rows(`SELECT id FROM console_sessions WHERE user_id = ? AND revoked_at_ms IS NULL`, staff.userId)).toHaveLength(1);
    expect(await h.deps.consoleAuth.previewInvite(await hashToken(unused), h.clock.now())).not.toBeNull();

    // Done again it all lands, and re-inviting never brings the old session back.
    expect((await post("/console/empleados/quitar", { persona: staff.userId })).headers.get("location")).toBe(
      "/console/empleados?aviso=quitado",
    );
    expect(await membership(store.businessId, staff.userId)).toMatchObject({ active: 0 });
    expect(await rows(`SELECT id FROM console_sessions WHERE user_id = ? AND revoked_at_ms IS NULL`, staff.userId)).toHaveLength(0);
    const again = await post("/console/empleados/codigo", { persona: staff.userId });
    expect(again.status).toBe(200);
    expect(await membership(store.businessId, staff.userId)).toMatchObject({ active: 1 });
    expect((await send(h, "/console/preparacion", { cookie: oldCookie })).status).toBe(401);
    expect((await send(h, "/console/entrar", { method: "POST", form: { codigo: unused } })).status).toBe(400);
  });

  it("won't remove an owner, and then writes nothing", async () => {
    const h = consoleHarness();
    const { store, owner, cookie } = await ownerSession(h);
    const code = await invite(h, store.businessId, owner.userId);
    expect(await h.deps.consoleAuth.removeStaff(store, owner.userId, h.clock.now())).toBeNull();
    expect(await membership(store.businessId, owner.userId)).toMatchObject({ role: "owner", active: 1 });
    expect(await h.deps.consoleAuth.previewInvite(await hashToken(code), h.clock.now())).not.toBeNull();
    expect((await send(h, "/console/empleados", { cookie })).status).toBe(200);
  });

  it("turns the fiado permission on and off, and the session sees it on the next request", async () => {
    const h = consoleHarness();
    const { store, staff, post, cookie } = await ownerSession(h);
    const staffCookie = await login(h, store.businessId, staff.userId);

    const on = await post("/console/empleados/fiado", { persona: staff.userId, permitir: "1" });
    expect(on.headers.get("location")).toBe("/console/empleados?aviso=fiado_si");
    expect(await membership(store.businessId, staff.userId)).toMatchObject({ can_approve_fiado: 1 });
    const token = staffCookie.split("=")[1]!;
    expect(await h.deps.consoleAuth.findSession(await hashToken(token), h.clock.now())).toMatchObject({ canApproveFiado: true });
    expect(await (await send(h, "/console/empleados", { cookie })).text()).toContain("Puede aprobar fiado");

    const off = await post("/console/empleados/fiado", { persona: staff.userId, permitir: "0" });
    expect(off.headers.get("location")).toBe("/console/empleados?aviso=fiado_no");
    expect(await membership(store.businessId, staff.userId)).toMatchObject({ can_approve_fiado: 0 });
    expect((await post("/console/empleados/fiado", { persona: staff.userId, permitir: "si" })).status).toBe(400);
  });

  it("refuses an Empleados form from another site or without the CSRF value", async () => {
    const h = consoleHarness();
    const { store, staff, cookie, post } = await ownerSession(h);
    expect((await post("/console/empleados/quitar", { persona: staff.userId }, "https://evil.test")).status).toBe(403);
    const noCsrf = await send(h, "/console/empleados/quitar", { method: "POST", form: { persona: staff.userId }, cookie });
    expect(noCsrf.status).toBe(403);
    expect(await membership(store.businessId, staff.userId)).toMatchObject({ active: 1 });
  });

  it("escapes names on the list", async () => {
    const h = consoleHarness();
    const { post, cookie } = await ownerSession(h);
    await post("/console/empleados/invitar", { nombre: "<b>x</b>", telefono: localPhone() });
    const page = await (await send(h, "/console/empleados", { cookie })).text();
    expect(page).not.toContain("<b>x</b>");
    expect(page).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
