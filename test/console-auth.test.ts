import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MemberContext } from "../src/application/engine";
import { INVITE_TTL_MS } from "../src/domain/console-auth";
import { demoOrders } from "../src/infrastructure/memory/demo-orders";
import { MemoryEngine } from "../src/infrastructure/memory/memory-engine";
import { hashToken, newToken } from "../src/infrastructure/tokens";
import { type Harness, harness, rows, testEnv } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";

/** Records which store each preparation-list read was for. */
function recordingEngine() {
  const engine = new MemoryEngine(() => demoOrders(0));
  const reads: string[] = [];
  const list = engine.preparationList.bind(engine);
  engine.preparationList = async (tenant) => {
    reads.push(tenant.businessId);
    return list(tenant);
  };
  return { engine, reads };
}

async function storeWithStaff() {
  return seedStore({
    members: [
      { phone: newPhone(), role: "owner" },
      { phone: newPhone(), role: "staff" },
    ],
  });
}

/** An invite for a member, created now by the harness clock. Returns the raw code. */
async function invite(h: Harness, businessId: string, userId: string): Promise<string> {
  const code = newToken();
  const now = h.clock.now();
  await env.DB.prepare(
    `INSERT INTO console_invites (id, business_id, user_id, token_hash, expires_at_ms, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), businessId, userId, await hashToken(code), now + INVITE_TTL_MS, now)
    .run();
  return code;
}

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function send(
  h: Harness,
  path: string,
  init: { method?: string; form?: Record<string, string>; cookie?: string; origin?: string } = {},
) {
  // Browsers send Origin on every form post; the default is this worker's own.
  const headers: Record<string, string> = { origin: init.origin ?? "https://worker.test" };
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  const request = new IncomingRequest(`https://worker.test${path}`, {
    method: init.method ?? "GET",
    headers,
    redirect: "manual",
    ...(init.form === undefined ? {} : { body: new URLSearchParams(init.form) }),
  });
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(request, h.env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Opens a session with a fresh invite; returns the cookie header to send back. */
async function login(h: Harness, businessId: string, userId: string): Promise<string> {
  const response = await send(h, "/console/entrar", { method: "POST", form: { codigo: await invite(h, businessId, userId) } });
  expect(response.status).toBe(303);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

const csrfOf = (page: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1];

describe("console login", () => {
  it("shows an invite without using it, then uses it once on Entrar", async () => {
    const h = harness({ engine: recordingEngine().engine });
    const store = await storeWithStaff();
    const code = await invite(h, store.businessId, store.members[1]!.userId);

    for (let i = 0; i < 2; i++) {
      const preview = await send(h, `/console/entrar?codigo=${code}`);
      expect(preview.status).toBe(200);
      expect(await preview.text()).toContain("Vas a entrar a la consola de Tienda de prueba.");
    }
    expect((await send(h, "/console/entrar", { method: "POST", form: { codigo: code } })).status).toBe(303);
    const again = await send(h, "/console/entrar", { method: "POST", form: { codigo: code } });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("Este código ya no sirve. Pedí uno nuevo en la tienda.");
    expect(await rows(`SELECT id FROM console_sessions WHERE business_id = ?`, store.businessId)).toHaveLength(1);
  });

  it("sets a long-lived, HttpOnly, Secure, SameSite cookie, and stores only hashes", async () => {
    const h = harness({ engine: recordingEngine().engine });
    const store = await storeWithStaff();
    const code = await invite(h, store.businessId, store.members[1]!.userId);
    const response = await send(h, "/console/entrar", { method: "POST", form: { codigo: code } });
    expect(response.headers.get("location")).toBe("/console/preparacion");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^consola=[A-Za-z0-9_-]{43};/);
    for (const attribute of ["Max-Age=2592000", "Path=/console", "HttpOnly", "Secure", "SameSite=Lax"]) {
      expect(cookie).toContain(attribute);
    }
    const token = cookie.split(";")[0]!.split("=")[1]!;
    const stored = await rows<{ token_hash: string }>(`SELECT token_hash FROM console_sessions WHERE business_id = ?`, store.businessId);
    expect(stored[0]!.token_hash).toBe(await hashToken(token));
    const invites = await rows<{ token_hash: string }>(`SELECT token_hash FROM console_invites WHERE business_id = ?`, store.businessId);
    expect(invites[0]!.token_hash).not.toBe(code);
  });

  it("accepts an invite 14 minutes old and refuses one 16 minutes old", async () => {
    const h = harness({ engine: recordingEngine().engine });
    const store = await storeWithStaff();
    const staff = store.members[1]!.userId;
    const fresh = await invite(h, store.businessId, staff);
    const stale = await invite(h, store.businessId, staff);
    h.clock.advance(14 * 60_000);
    expect((await send(h, "/console/entrar", { method: "POST", form: { codigo: fresh } })).status).toBe(303);
    h.clock.advance(2 * 60_000);
    expect((await send(h, "/console/entrar", { method: "POST", form: { codigo: stale } })).status).toBe(400);
  });

  it("refuses a login form posted from another site, and leaves the invite unused", async () => {
    const h = harness();
    const store = await storeWithStaff();
    const code = await invite(h, store.businessId, store.members[1]!.userId);
    const forged = await send(h, "/console/entrar", { method: "POST", form: { codigo: code }, origin: "https://evil.test" });
    expect(forged.status).toBe(403);
    expect(forged.headers.get("set-cookie")).toBeNull();
    expect((await send(h, "/console/entrar", { method: "POST", form: { codigo: code } })).status).toBe(303);
  });

  it("refuses a malformed code without looking it up", async () => {
    const h = harness({ engine: recordingEngine().engine });
    expect((await send(h, "/console/entrar?codigo=abc")).status).toBe(400);
    expect((await send(h, "/console/entrar", { method: "POST", form: { codigo: "x".repeat(200) } })).status).toBe(400);
  });

  it("serves the list for the session's own store only", async () => {
    const { engine, reads } = recordingEngine();
    const h = harness({ engine });
    const store = await storeWithStaff();
    const other = await storeWithStaff();
    const cookie = await login(h, store.businessId, store.members[1]!.userId);
    expect((await send(h, "/console/preparacion", { cookie })).status).toBe(200);
    expect(reads).toEqual([store.businessId]);
    expect(reads).not.toContain(other.businessId);
  });

  it("asks for a login without a session, or with an unknown one", async () => {
    const h = harness({ engine: recordingEngine().engine });
    expect((await send(h, "/console/preparacion")).status).toBe(401);
    expect((await send(h, "/console/preparacion", { cookie: `consola=${newToken()}` })).status).toBe(401);
  });

  it("refuses owner pages to staff, and shows them to the owner", async () => {
    const h = harness({ engine: recordingEngine().engine });
    const store = await storeWithStaff();
    const staff = await login(h, store.businessId, store.members[1]!.userId);
    const owner = await login(h, store.businessId, store.members[0]!.userId);
    const refused = await send(h, "/console/empleados", { cookie: staff });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("Esta parte es solo para el dueño.");
    const shown = await send(h, "/console/empleados", { cookie: owner });
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain("Empleado");
  });

  it("rejects a form without the session's CSRF value, and accepts it with one", async () => {
    const h = harness({ engine: recordingEngine().engine });
    const store = await storeWithStaff();
    const cookie = await login(h, store.businessId, store.members[1]!.userId);
    const tap = { type: "mark_ready", orderId: "demo-order-1", version: "2", operationKey: "k-csrf" };

    expect((await send(h, "/console/acciones", { method: "POST", form: tap, cookie })).status).toBe(403);
    expect((await send(h, "/console/acciones", { method: "POST", form: { ...tap, csrf: "0".repeat(64) }, cookie })).status).toBe(403);

    const csrf = csrfOf(await (await send(h, "/console/preparacion", { cookie })).text());
    expect(csrf).toBeDefined();
    const saved = await send(h, "/console/acciones", { method: "POST", form: { ...tap, csrf: csrf! }, cookie });
    expect(saved.status).toBe(303);
  });

  it("logs out a deactivated member, and a removed session, on the next request", async () => {
    const h = harness({ engine: recordingEngine().engine });
    const store = await storeWithStaff();
    const [owner, staff] = store.members as [(typeof store.members)[number], (typeof store.members)[number]];
    const staffCookie = await login(h, store.businessId, staff.userId);
    const ownerCookie = await login(h, store.businessId, owner.userId);

    await env.DB.prepare(`UPDATE memberships SET active = 0 WHERE business_id = ? AND user_id = ?`)
      .bind(store.businessId, staff.userId)
      .run();
    expect((await send(h, "/console/preparacion", { cookie: staffCookie })).status).toBe(401);

    expect(await h.deps.consoleAuth.revokeSessions(store, owner.userId, h.clock.now())).toBe(1);
    expect((await send(h, "/console/preparacion", { cookie: ownerCookie })).status).toBe(401);
  });

  it("an invite for a deactivated member opens nothing", async () => {
    const h = harness({ engine: recordingEngine().engine });
    const store = await storeWithStaff();
    const staff = store.members[1]!.userId;
    const code = await invite(h, store.businessId, staff);
    await env.DB.prepare(`UPDATE memberships SET active = 0 WHERE business_id = ? AND user_id = ?`).bind(store.businessId, staff).run();
    expect((await send(h, "/console/entrar", { method: "POST", form: { codigo: code } })).status).toBe(400);
  });

  it("fails closed without LINK_SIGNING_SECRET", async () => {
    const h = harness({ env: testEnv({ LINK_SIGNING_SECRET: "" }), engine: recordingEngine().engine });
    const store = await storeWithStaff();
    const code = await invite(h, store.businessId, store.members[1]!.userId);
    expect((await send(h, `/console/entrar?codigo=${code}`)).status).toBe(503);
    expect((await send(h, "/console/entrar", { method: "POST", form: { codigo: code } })).status).toBe(503);
    expect((await send(h, "/console/preparacion")).status).toBe(503);
  });

  it("gives the engine the session's member as actor", async () => {
    const engine = new MemoryEngine(() => demoOrders(0));
    const seen: MemberContext[] = [];
    const act = engine.onConsoleAction.bind(engine);
    engine.onConsoleAction = async (member, envelope) => {
      seen.push(member);
      return act(member, envelope);
    };
    const h = harness({ engine });
    const store = await storeWithStaff();
    const staff = store.members[1]!;
    const cookie = await login(h, store.businessId, staff.userId);
    const csrf = csrfOf(await (await send(h, "/console/preparacion", { cookie })).text())!;
    await send(h, "/console/acciones", {
      method: "POST",
      form: { type: "start_preparing", orderId: "demo-order-2", version: "1", operationKey: "k-actor", csrf },
      cookie,
    });
    expect(seen).toMatchObject([{ businessId: store.businessId, memberId: staff.userId, role: "staff" }]);
  });
});
