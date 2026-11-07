import type { Claim } from "../src/domain/contract/outcomes";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MemberContext } from "../src/application/engine";
import { OrderEngine, staffKey } from "../src/application/engine/order-engine";
import type { ActionEnvelope, ConsoleAction, CustomerAction } from "../src/domain/contract/actions";
import type { BurstReading } from "../src/domain/contract/observation";
import { INVITE_TTL_MS } from "../src/domain/console-auth";
import { D1DeedChecks } from "../src/infrastructure/d1/deed-checks";
import { orderCode } from "../src/domain/order-code";
import { orderRef } from "../src/domain/order-ref";
import { D1FactLedger } from "../src/infrastructure/d1/fact-ledger";
import { PlannedDeedEngine } from "../src/infrastructure/d1/planned-deed-engine";
import { toEnglish } from "../src/interfaces/http/console/language";
import { hashToken, newToken } from "../src/infrastructure/tokens";
import { ids, moreSugar } from "./fixtures/contract";
import { type Harness, harness } from "./helpers/harness";
import { T0, newStore, placeFirstOrder, save, store, tap } from "./helpers/orders";
import { newPhone, seedStore } from "./helpers/seed";

type Store = Awaited<ReturnType<typeof newStore>>;

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/** The engine that records the Deed's checks, as the demo's worker builds it. */
const checkedEngine = new OrderEngine({
  store,
  ids: { newId: () => crypto.randomUUID() },
  ledger: new D1FactLedger(env.DB),
  checks: new D1DeedChecks(env.DB),
  clock: { now: () => T0 },
});

async function get(h: Harness, path: string, cookie?: string) {
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(
    new IncomingRequest(`https://worker.test${path}`, { headers: cookie === undefined ? {} : { cookie }, redirect: "manual" }),
    h.env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** "que sean 4 de azúcar": L4 from 2 to 4, as change-requests.test.ts reads it. */
const sugarToFour: BurstReading = {
  ...moreSugar,
  observations: [
    {
      kind: "order_change",
      edits: [{ op: "set_quantity", target: { ref: "L4", said: "azúcar" }, quantity: "4", evidence: { source: "text", message: 0, start: 0, end: 20 } }],
      issues: [],
    },
  ],
};

/** A session for a member of the store, opened through the real invite. Returns the cookie. */
async function login(h: Harness, s: Store, role: "owner" | "staff"): Promise<string> {
  const member = await env.DB.prepare(`SELECT user_id AS id FROM memberships WHERE business_id = ? AND role = ?`)
    .bind(s.businessId, role)
    .first<{ id: string }>();
  const code = newToken();
  const now = h.clock.now();
  await env.DB.prepare(
    `INSERT INTO console_invites (id, business_id, user_id, token_hash, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), s.businessId, member!.id, await hashToken(code), now + INVITE_TTL_MS, now)
    .run();
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(
    new IncomingRequest("https://worker.test/console/entrar", {
      method: "POST",
      headers: { origin: "https://worker.test" },
      body: new URLSearchParams({ codigo: code }),
      redirect: "manual",
    }),
    h.env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(303);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

/** A store whose members sign in: an owner and a staff member, both in the store `newStore` seeds. */
async function storeWithMembers(): Promise<Store> {
  const base = await seedStore({
    members: [
      { phone: newPhone(), role: "owner" },
      { phone: newPhone(), role: "staff" },
    ],
  });
  const s = await newStore();
  await env.DB.batch(
    base.members.map((m) =>
      env.DB.prepare(
        `INSERT INTO memberships (business_id, user_id, location_id, role, created_at_ms)
         SELECT ?1, ?2, id, ?3, 0 FROM locations WHERE business_id = ?1`,
      ).bind(s.businessId, m.userId, m.role),
    ),
  );
  return s;
}

const cancelTap = (orderId: string, version: number): ActionEnvelope<CustomerAction> => ({
  ...tap(orderId, version),
  operationKey: `cancel:${orderId}:v${version}`,
  action: { type: "cancel_order", orderId, version },
});

/**
 * Order E's shape (demo/run.mjs): placed, confirmed, a change asked for on the confirmed order, then
 * cancelled. The cancel closes the confirm, so the change request rests on a closed fact.
 */
async function cancelledWithChange(s: Store): Promise<{ orderId: string; confirmId: string; changeId: string }> {
  const v1 = await placeFirstOrder(s, ids.customer, T0);
  const context = s.context({ nowMs: T0 + 1_000 });
  await save(await checkedEngine.onCustomerAction(context, tap(v1.orderId, 1)));
  const line = v1.lines[0]!.lineId;
  const removal: ActionEnvelope<CustomerAction> = {
    operationKey: `remove:${v1.orderId}:v1:${line}`,
    actor: { type: "customer", customerId: ids.customer },
    action: { type: "remove_line", orderId: v1.orderId, version: 1, lineId: line },
  };
  await save(await checkedEngine.onCustomerAction(s.context({ nowMs: T0 + 2_000 }), removal));
  await save(await checkedEngine.onCustomerAction(s.context({ nowMs: T0 + 3_000 }), cancelTap(v1.orderId, 1)));
  const rows = await env.DB.prepare(
    `SELECT kind, id FROM facts WHERE business_id = ? AND kind IN ('order_confirm', 'change_request') ORDER BY kind`,
  )
    .bind(s.businessId)
    .all<{ kind: string; id: string }>();
  const confirmId = rows.results.find((row) => row.kind === "order_confirm")!.id;
  const changeId = rows.results.find((row) => row.kind === "change_request")!.id;
  return { orderId: v1.orderId, confirmId, changeId };
}

/** A staff tap on an order's version, as the console sends it. */
const staffTap = (member: MemberContext, type: "mark_ready" | "mark_delivered", orderId: string, version: number) => {
  const action = { type, orderId, version } as const;
  const envelope: ActionEnvelope<ConsoleAction> = {
    operationKey: staffKey(action),
    actor: { type: "member", memberId: member.memberId, role: member.role },
    action,
  };
  return checkedEngine.onConsoleAction(member, envelope);
};

describe("/console/deed/:orderId: the order's facts as a graph", () => {
  it("draws the cancelled confirm red and what rests on it grey, each fact a link to its panel", async () => {
    const s = await storeWithMembers();
    const { orderId, confirmId, changeId } = await cancelledWithChange(s);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const response = await get(h, `/console/deed/${encodeURIComponent(orderId)}`, cookie);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(`class="node closed"`);
    expect(body).toContain(`class="node blocked"`);
    expect(body).toContain(`href="#f-${confirmId}"`);
    expect(body).toContain(`id="f-${changeId}"`);
    expect(body).toContain(`Bloqueado por`);
    expect(body).toContain(`?foco=${changeId}`);
    // No refresh on the order page: a reload would close the open panel and drop the `?foco=` path.
    expect(body).not.toContain(`http-equiv="refresh"`);
    expect(body).not.toContain("<script");
  });

  it("replays the order as it stood at ?t=, and draws the refused tap beside the cancel that decided it", async () => {
    const s = await storeWithMembers();
    const { orderId } = await cancelledWithChange(s);
    const member: MemberContext = { businessId: s.businessId, memberId: ids.staff, role: "staff", canApproveFiado: false, nowMs: T0 + 4_000 };
    await staffTap(member, "mark_ready", orderId, 1);
    const cancel = await env.DB.prepare(`SELECT id FROM facts WHERE business_id = ? AND kind = 'order_cancel'`).bind(s.businessId).first<{ id: string }>();
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const path = `/console/deed/${encodeURIComponent(orderId)}`;

    // Before the cancel: the confirm is still live, and nothing was refused yet.
    const before = await (await get(h, `${path}?t=${T0 + 2_500}`, cookie)).text();
    expect(before).toContain(`class="node live"`);
    expect(before).not.toContain(`class="node closed"`);
    expect(before).not.toContain("Intento rechazado");
    // The replay slider is hidden for now: the page offers no range, though `?t=` still answers.
    expect(before).not.toContain(`name="t"`);

    // After the refusal: the confirm is closed, the refused tap is drawn and linked to the cancel.
    const after = await (await get(h, `${path}?t=${T0 + 5_000}`, cookie)).text();
    expect(after).toContain(`class="node closed"`);
    expect(after).toContain("Intento rechazado");
    expect(after).toContain(`href="#f-${cancel!.id}"`);

    // The live view has no range to replay from, and it does not refresh (that would close an open panel).
    const live = await (await get(h, path, cookie)).text();
    expect(live).toContain(`class="node closed"`);
    expect(live).not.toContain(`http-equiv="refresh"`);
    expect(live).not.toContain(`name="t"`);
  });

  it("draws a superseded change as its own red arc, apart from the dependency line it shares with the newer change", async () => {
    const s = await storeWithMembers();
    const v1 = await placeFirstOrder(s);
    await save(await checkedEngine.onCustomerAction(s.context({ nowMs: T0 + 1_000 }), tap(v1.orderId, 1)));
    await save(await checkedEngine.onBurst(s.context({ nowMs: T0 + 2_000, jobId: crypto.randomUUID() }), sugarToFour, []));
    await save(await checkedEngine.onBurst(s.context({ nowMs: T0 + 3_000, jobId: crypto.randomUUID() }), sugarToFour, []));
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const body = await (await get(h, `/console/deed/${encodeURIComponent(v1.orderId)}`, cookie)).text();
    expect(body).toContain(`class="node closed"`);
    // Both edges join the same two boxes: the supersede is a curved path, so the grey dependency line cannot hide it.
    expect(body).not.toContain(`<line class="closes"`);
    expect(body).toMatch(/<path class="closes" d="M[\d.-]+ [\d.-]+ Q[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+"\/>/);
    expect(body).toContain(`<line class="depends"`);
  });

  it("never draws another store's refusals on this order's graph", async () => {
    const s = await storeWithMembers();
    const other = await newStore();
    const { orderId } = await cancelledWithChange(s);
    await env.DB.prepare(
      `INSERT INTO deed_checks (business_id, id, at_ms, source, order_id, result, reason_code, operation_key)
       VALUES (?, ?, ?, 'stale_version', ?, 'fail', 'stale_version', 'staff:foreign:1:mark_ready')`,
    )
      .bind(other.businessId, crypto.randomUUID(), T0 + 4_000, orderId)
      .run();
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const body = await (await get(h, `/console/deed/${encodeURIComponent(orderId)}`, cookie)).text();
    expect(body).not.toContain("Intento rechazado");
    expect(body).not.toContain("foreign");
  });

  it("answers 404 for another store's order, and lets an owner and staff open this one", async () => {
    const mine = await storeWithMembers();
    const theirs = await newStore();
    const { orderId } = await cancelledWithChange(mine);
    const foreign = await placeFirstOrder(theirs, ids.customer, T0);
    const h = harness({ engine: checkedEngine });
    const staffCookie = await login(h, mine, "staff");
    const ownerCookie = await login(h, mine, "owner");
    expect((await get(h, `/console/deed/${encodeURIComponent(foreign.orderId)}`, staffCookie)).status).toBe(404);
    expect((await get(h, `/console/deed/${encodeURIComponent(orderId)}`, staffCookie)).status).toBe(200);
    expect((await get(h, `/console/deed/${encodeURIComponent(orderId)}`, ownerCookie)).status).toBe(200);
  });

  it("is linked from the Pedidos trail as 'Cómo se armó', and leads on to every verification; Más lists Deed en vivo", async () => {
    const s = await storeWithMembers();
    const { orderId } = await cancelledWithChange(s);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const trail = await (await get(h, `/console/pedidos/${encodeURIComponent(orderId)}`, cookie)).text();
    expect(trail).toContain(`href="/console/deed/${encodeURIComponent(orderId)}">Cómo se armó</a>`);
    const deed = await (await get(h, `/console/deed/${encodeURIComponent(orderId)}`, cookie)).text();
    expect(deed).toContain(`href="/console/deed/verificaciones"`);
    const more = await (await get(h, "/console/mas", cookie)).text();
    expect(more).toContain(`href="/console/deed/en-vivo"`);
  });
});

describe("/console/deed/en-vivo: the newest order's graph and the checks, as they happen", () => {
  it("follows the order with the newest activity, refreshing itself, for owner and staff", async () => {
    const s = await storeWithMembers();
    const { orderId } = await cancelledWithChange(s);
    const h = harness({ engine: checkedEngine });
    for (const role of ["owner", "staff"] as const) {
      const cookie = await login(h, s, role);
      const page = await (await get(h, "/console/deed/en-vivo", cookie)).text();
      expect(page).toContain(`<meta http-equiv="refresh" content="3;url=/console/deed/en-vivo">`);
      expect(page).toContain(`id="grafo"`);
      expect(page).toContain(`href="/console/deed/${encodeURIComponent(orderId)}#f-`);
      expect(page).toMatch(/\d+ afirmaciones · \d+ confirmadas · \d+ sin respaldo · \d+ intentos rechazados/);
    }
  });

  it("switches to a newer order by itself, and stays on a picked one", async () => {
    const s = await storeWithMembers();
    const first = await cancelledWithChange(s);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const other = await placeFirstOrder(s, ids.customer, T0 + 60_000);
    expect(other.orderId).not.toBe(first.orderId);
    const latest = await (await get(h, "/console/deed/en-vivo", cookie)).text();
    expect(latest).toContain(`href="/console/deed/${encodeURIComponent(other.orderId)}">Ver el detalle`);
    const pinned = await get(h, `/console/deed/en-vivo?pedido=${encodeURIComponent(first.orderId)}`, cookie);
    const body = await pinned.text();
    expect(body).toContain(`href="/console/deed/${encodeURIComponent(first.orderId)}">Ver el detalle`);
    expect(body).toContain(`content="3;url=/console/deed/en-vivo?pedido=${encodeURIComponent(first.orderId)}"`);
  });

  it("draws a graph at its own size: circles, arrows to what rests on them, the newest marked", async () => {
    const s = await storeWithMembers();
    await cancelledWithChange(s);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const page = await (await get(h, "/console/deed/en-vivo", cookie)).text();
    expect(page).toMatch(/<svg id="grafo" class="livegraph" width="\d+" height="\d+"/);
    expect(page).toContain(`<marker id="lv-arrow"`);
    expect(page).toContain(`<circle class="body"`);
    expect(page).toContain("depende de");
  });

  it("reads in English, its graph and its feed included, when the console is in English", async () => {
    const s = await storeWithMembers();
    await cancelledWithChange(s);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const page = await (await get(h, "/console/deed/en-vivo", `${cookie}; consola_idioma=en`)).text();
    const words = page.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]*>/g, "\n");
    for (const english of ["Deed live", "claims", "attempts refused", "Most recent", "Change asked"]) expect(words).toContain(english);
    for (const spanish of ["Deed en vivo", "Afirmaciones", "Intentos rechazados", "Intentó", "Verificó", "Vivo", "Cerrado", "Versión", "Se actualiza", "más reciente", "Pedido", "Buscar"]) expect(words).not.toContain(spanish);
    for (const [row, english] of [
      ["Verificó el estado del pedido", "Checked the order's state"],
      ["Intentó marcar listo", "Tried to mark ready"],
      ["no está respaldado por los registros", "not backed by the records"],
    ] as const) expect(toEnglish(`<li>${row}</li>`)).toContain(english);
  });

  it("shows the order's code as its own page does", async () => {
    const s = await storeWithMembers();
    const { code } = await confirmedOrder(s);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const page = await (await get(h, "/console/deed/en-vivo", cookie)).text();
    expect(page).toContain(`Pedido ${code}`);
  });

  it("never shows another store's order: not by following, and a 404 when picked", async () => {
    const mine = await storeWithMembers();
    const theirs = await storeWithMembers();
    const { orderId } = await cancelledWithChange(theirs);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, mine, "staff");
    const page = await (await get(h, "/console/deed/en-vivo", cookie)).text();
    expect(page).not.toContain(orderId);
    expect(page).toContain("Todavía no hay pedidos");
    expect((await get(h, `/console/deed/en-vivo?pedido=${encodeURIComponent(orderId)}`, cookie)).status).toBe(404);
  });
});

describe("Pedidos: the way into an order's history", () => {
  it("links 'Historial del pedido' on the planner's engine, as deployed", async () => {
    const s = await storeWithMembers();
    const { orderId } = await confirmedOrder(s);
    const engine = new PlannedDeedEngine({ db: env.DB, ledger: checkedEngine, store, setup: {} as never });
    const h = harness({ engine });
    const cookie = await login(h, s, "staff");
    const page = await (await get(h, `/console/preparacion/${encodeURIComponent(orderId)}`, cookie)).text();
    expect(page).toContain(`href="/console/pedidos/${encodeURIComponent(orderId)}">Historial del pedido</a>`);
  });
});

/** A placed order its customer confirmed: its id, its code as staff say it, and its reference. */
async function confirmedOrder(s: Store): Promise<{ orderId: string; code: string; ref: string }> {
  const v1 = await placeFirstOrder(s, ids.customer, T0);
  await save(await checkedEngine.onCustomerAction(s.context({ nowMs: T0 + 1_000 }), tap(v1.orderId, 1)));
  const confirm = await env.DB.prepare(`SELECT id FROM facts WHERE business_id = ? AND kind = 'order_confirm'`)
    .bind(s.businessId)
    .first<{ id: string }>();
  return { orderId: v1.orderId, code: (await orderCode(confirm!.id))!, ref: orderRef(v1.orderId) };
}

describe("/console/deed/buscar: a typed code or reference reaches the order's entry", () => {
  /** The form's own POST: the session's CSRF value, read from the page that carries the form. */
  const search = async (h: Harness, typed: string, cookie?: string) => {
    const csrf = cookie === undefined ? "" : (/name="csrf" value="([^"]+)"/.exec(await (await get(h, "/console/deed/buscar", cookie)).text())?.[1] ?? "");
    const ctx = createExecutionContext();
    const response = await h.worker.fetch(
      new IncomingRequest("https://worker.test/console/deed/buscar", {
        method: "POST",
        headers: { origin: "https://worker.test", ...(cookie === undefined ? {} : { cookie }) },
        body: new URLSearchParams({ csrf, codigo: typed }),
        redirect: "manual",
      }),
      h.env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  };
  const libroOf = (orderId: string) => `/console/deed/${encodeURIComponent(orderId)}/libro`;

  it("redirects the order code, with or without # and in any case, to the order's libro", async () => {
    const s = await storeWithMembers();
    const { orderId, code } = await confirmedOrder(s);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    for (const typed of [code, code.slice(1), code.toLowerCase(), code.slice(1).toLowerCase(), ` ${code} `]) {
      const response = await search(h, typed, cookie);
      expect(response.status, typed).toBe(303);
      expect(response.headers.get("location"), typed).toBe(libroOf(orderId));
    }
  });

  it("redirects the reference, bare or after `Ref. `, to the order's libro", async () => {
    const s = await storeWithMembers();
    const { orderId, ref } = await confirmedOrder(s);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    for (const typed of [ref, `Ref. ${ref}`]) {
      const response = await search(h, typed, cookie);
      expect(response.status, typed).toBe(303);
      expect(response.headers.get("location"), typed).toBe(libroOf(orderId));
    }
  });

  it("answers 404 with the console shell for an unknown code, a made-up reference and an empty field", async () => {
    const s = await storeWithMembers();
    const { code } = await confirmedOrder(s);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const unknown = code === "#ZZZZZ" ? "#00000" : "#ZZZZZ";
    for (const typed of [unknown, "00000000", "", "#"]) {
      const response = await search(h, typed, cookie);
      expect(response.status, typed).toBe(404);
      const body = await response.text();
      expect(body, typed).toContain("No encontré un pedido con ese código en esta tienda.");
      expect(body, typed).toContain('<nav');
    }
  });

  it("answers 404 for another store's order, even when its code or reference is typed", async () => {
    const mine = await storeWithMembers();
    const theirs = await newStore();
    await confirmedOrder(mine);
    const foreign = await confirmedOrder(theirs);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, mine, "staff");
    expect((await search(h, foreign.code, cookie)).status).toBe(404);
    expect((await search(h, foreign.ref, cookie)).status).toBe(404);
  });

  it("gives the same answer to a request without a login as the feed does", async () => {
    const s = await storeWithMembers();
    const { code } = await confirmedOrder(s);
    const h = harness({ engine: checkedEngine });
    const sibling = await get(h, "/console/deed/verificaciones");
    const found = await search(h, code);
    expect(found.status).toBe(sibling.status);
    expect(found.headers.get("location")).toBeNull();
  });

  it("still finds the order by its earlier code after a second confirm moved the code on", async () => {
    const s = await storeWithMembers();
    const { orderId, code } = await confirmedOrder(s);
    const row = await env.DB.prepare(`SELECT * FROM facts WHERE business_id = ? AND kind = 'order_confirm'`)
      .bind(s.businessId)
      .first<Record<string, unknown>>();
    const later = { ...row!, id: crypto.randomUUID(), operation_key: `later:${orderId}`, recorded_at_ms: Number(row!.recorded_at_ms) + 1 };
    const columns = Object.keys(later);
    await env.DB.prepare(`INSERT INTO facts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .bind(...Object.values(later))
      .run();
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    for (const typed of [code, (await orderCode(later.id))!]) {
      expect((await search(h, typed, cookie)).headers.get("location"), typed).toBe(libroOf(orderId));
    }
  });

  describe("the WhatsApp ID of a sent message", () => {
    async function sent(businessId: string, id: string, claims: readonly Claim[] | null): Promise<string> {
      const account = await env.DB.prepare(`SELECT id FROM channel_accounts WHERE business_id = ?`).bind(businessId).first<{ id: string }>();
      const wamid = `wamid.${id}`;
      await env.DB.prepare(
        `INSERT INTO outbound_messages (id, business_id, channel_account_id, recipient_hash, seq, kind, body_text, dedupe_key, status,
           expires_at_ms, created_at_ms, updated_at_ms, sent_at_ms, claims_json, provider_message_id)
         VALUES (?, ?, ?, 'hash-synthetic', (SELECT COALESCE(MAX(seq), 0) + 1 FROM outbound_messages), 'reply', 'Tu pedido está confirmado.',
           ?, 'sent', ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, businessId, account!.id, `dedupe:${id}`, T0 + 3_600_000, T0, T0, T0, claims === null ? null : JSON.stringify(claims.map((claim) => ({ anyOf: [claim] }))), wamid)
        .run();
      return wamid;
    }
    const about = (orderId: string): Claim => ({ type: "order_state", orderId, version: 1, state: "confirmado" });

    it("reaches the entry of the order the message is about, and only in this store", async () => {
      const s = await storeWithMembers();
      const { orderId } = await confirmedOrder(s);
      const wamid = await sent(s.businessId, crypto.randomUUID(), [about(orderId)]);
      const h = harness({ engine: checkedEngine });
      const cookie = await login(h, s, "staff");
      expect((await search(h, wamid, cookie)).headers.get("location")).toBe(libroOf(orderId));
      const other = await storeWithMembers();
      expect((await search(h, wamid, await login(h, other, "staff"))).status).toBe(404);
    });

    it("finds nothing for a message whose claims were blocked, or one never sent", async () => {
      const s = await storeWithMembers();
      const { orderId } = await confirmedOrder(s);
      const blockedId = crypto.randomUUID();
      const blocked = await sent(s.businessId, blockedId, [about(orderId)]);
      await env.DB.prepare(`UPDATE outbound_messages SET claims_blocked_at_ms = ? WHERE id = ?`).bind(T0, blockedId).run();
      const h = harness({ engine: checkedEngine });
      const cookie = await login(h, s, "staff");
      expect((await search(h, blocked, cookie)).status).toBe(404);
      expect((await search(h, "wamid.never-sent", cookie)).status).toBe(404);
    });

    it("finds nothing for a message about no order, about two, or that was never sent", async () => {
      const s = await storeWithMembers();
      const { orderId } = await confirmedOrder(s);
      const none = await sent(s.businessId, crypto.randomUUID(), null);
      const two = await sent(s.businessId, crypto.randomUUID(), [about(orderId), about("order-elsewhere")]);
      const h = harness({ engine: checkedEngine });
      const cookie = await login(h, s, "staff");
      for (const typed of [none, two, "wamid.unknown"]) expect((await search(h, typed, cookie)).status, typed).toBe(404);
    });
  });

  it("links from the feed to a search page that doesn't reload while someone types", async () => {
    const s = await storeWithMembers();
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const feed = await (await get(h, "/console/deed/verificaciones", cookie)).text();
    expect(feed).toContain(`href="/console/deed/buscar"`);
    expect(feed).not.toContain(`name="codigo"`);
    const page = await get(h, "/console/deed/buscar", cookie);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain(`name="codigo"`);
    expect(body).not.toContain("http-equiv");
    expect(body).not.toContain("No encontré");
  });

  it("keeps the search field on the page that found nothing", async () => {
    const s = await storeWithMembers();
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const body = await (await search(h, "#00000", cookie)).text();
    expect(body).toContain("No encontré un pedido con ese código");
    expect(body).toContain(`name="codigo"`);
    expect(body).not.toContain("http-equiv");
  });
});

describe("/console/deed/verificaciones: every check, newest first, for the store only", () => {
  it("shows the refused mark_ready as a ✗ with its reason, and counts one refusal", async () => {
    const s = await storeWithMembers();
    const { orderId } = await cancelledWithChange(s);
    const member: MemberContext = { businessId: s.businessId, memberId: ids.staff, role: "staff", canApproveFiado: false, nowMs: T0 + 4_000 };
    const refused = await staffTap(member, "mark_ready", orderId, 1);
    expect(refused.outcome).toMatchObject({ type: "rejected", reason: "invalid_state" });

    const other = await newStore();
    const foreign = await placeFirstOrder(other, ids.customer, T0);
    await staffTap({ ...member, businessId: other.businessId }, "mark_ready", foreign.orderId, 1);

    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const body = await (await get(h, "/console/deed/verificaciones", cookie)).text();
    expect(body).toContain('id="contadores">Intentos rechazados 1<');
    expect(body).toContain('id="afirmaciones">Afirmaciones verificadas 0, confirmadas 0<');
    expect(body).toContain("✗");
    expect(body).toContain("Intentó marcar listo");
    expect(body).toContain("el pedido ya estaba cancelado");
    expect(body).not.toContain(foreign.orderId);
    expect(body).toContain(`href="/console/deed/${encodeURIComponent(orderId)}"`);
  });

  it("lists each refusal reason in Spanish, never the raw code", async () => {
    const s = await storeWithMembers();
    const { orderId } = await cancelledWithChange(s);
    const member: MemberContext = { businessId: s.businessId, memberId: ids.staff, role: "staff", canApproveFiado: false, nowMs: T0 + 4_000 };
    await staffTap(member, "mark_ready", orderId, 1);
    await staffTap(member, "mark_delivered", orderId, 1);
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const body = await (await get(h, "/console/deed/verificaciones", cookie)).text();
    expect(body).toContain('<li>el estado no lo permite: 2</li>');
    expect(body).not.toContain("invalid_state");
  });

  it("refreshes the feed, and only the feed, to its own path", async () => {
    const s = await storeWithMembers();
    const h = harness({ engine: checkedEngine });
    const cookie = await login(h, s, "staff");
    const feed = await (await get(h, "/console/deed/verificaciones", cookie)).text();
    expect(feed).toContain(`<meta http-equiv="refresh" content="3;url=/console/deed/verificaciones">`);
  });
});
