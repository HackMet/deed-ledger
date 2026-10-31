import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { INVITE_TTL_MS } from "../../src/domain/console-auth";
import { hashToken, newToken } from "../../src/infrastructure/tokens";
import type { Harness } from "./harness";
import { newPhone, seedStore } from "./seed";

/** A store with an owner (members[0]) and one staff member (members[1]). */
export async function storeWithStaff() {
  return seedStore({
    members: [
      { phone: newPhone(), role: "owner" },
      { phone: newPhone(), role: "staff" },
    ],
  });
}

/** An invite for a member, created now by the harness clock. Returns the raw code. */
export async function invite(h: Harness, businessId: string, userId: string): Promise<string> {
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

export async function send(
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
export async function login(h: Harness, businessId: string, userId: string): Promise<string> {
  const response = await send(h, "/console/entrar", { method: "POST", form: { codigo: await invite(h, businessId, userId) } });
  expect(response.status).toBe(303);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

export const csrfOf = (page: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1];

/** The CSRF value on a page this session can open. */
export async function csrfFor(h: Harness, cookie: string, path = "/console/bienvenida"): Promise<string> {
  const value = csrfOf(await (await send(h, path, { cookie })).text());
  expect(value).toBeDefined();
  return value!;
}
