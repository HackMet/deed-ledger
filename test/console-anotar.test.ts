/**
 * The Anotar screen: the console reader behind login, CSRF, the cross-site check and size limits,
 * with the store taken only from the session. Recorded model responses; no network.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_PHOTO_BYTES } from "../src/application/console-reader";
import { BurstReader } from "../src/application/perception/reader";
import { D1SpendLedger } from "../src/infrastructure/d1/spend-repository";
import { MuseSparkProvider } from "../src/integrations/meta/spark";
import { MAX_ANOTAR_BODY_BYTES } from "../src/interfaces/http/console/anotar";
import { pedidoAMano, PEDIDO_TEXT, SALE_TEXT, saleByText, setupCardPhoto } from "./fixtures/model/console";
import type { Recorded } from "./fixtures/model/recorded";
import { csrfFor, login, send, storeWithStaff } from "./helpers/console";
import { FakeClock, RecordingLogger } from "./helpers/fakes";
import { type Harness, harness } from "./helpers/harness";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const jpeg = (size = 16) => {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};

/** A harness whose reader answers with the queued recorded responses and counts its calls. */
function anotarHarness() {
  const queue: Recorded[] = [];
  let calls = 0;
  const fetch = async (): Promise<Response> => {
    calls++;
    const next = queue.shift();
    if (next === undefined) throw new Error("no model call expected");
    return Response.json({
      model: "muse-spark-1.3",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(next.response) } }],
      usage: next.usage,
    });
  };
  const clock = new FakeClock(Date.UTC(2026, 9, 31, 18, 0, 0));
  const reader = new BurstReader({
    provider: new MuseSparkProvider({ apiKey: "test-model-key-not-real", fetch }),
    spend: new D1SpendLedger(env.DB),
    clock,
    log: new RecordingLogger(),
    dailyCapMicroUsd: 1_000_000_000,
  });
  const withReader = harness({ clock, burstReader: reader });
  return { h: withReader, answer: (r: Recorded) => queue.push(r), calls: () => calls };
}

async function post(
  h: Harness,
  form: Record<string, string | Blob>,
  init: { cookie?: string; origin?: string; filename?: string } = {},
) {
  const body = new FormData();
  for (const [key, value] of Object.entries(form)) {
    if (typeof value === "string") body.append(key, value);
    else body.append(key, value, init.filename ?? "foto.jpg");
  }
  const headers: Record<string, string> = { origin: init.origin ?? "https://worker.test" };
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  const request = new IncomingRequest("https://worker.test/console/anotar", { method: "POST", headers, body, redirect: "manual" });
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(request, h.env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function session(h: Harness, role: "owner" | "staff" = "staff") {
  const store = await storeWithStaff();
  const member = store.members[role === "owner" ? 0 : 1]!;
  const cookie = await login(h, store.businessId, member.userId);
  const csrf = await csrfFor(h, cookie, "/console/anotar");
  return { store, cookie, csrf };
}

async function objectsUnder(businessId: string): Promise<string[]> {
  return (await env.MEDIA.list({ prefix: `stores/${businessId}/` })).objects.map((object) => object.key);
}

describe("Anotar: who can read", () => {
  it("refuses without a session", async () => {
    const { h, calls } = anotarHarness();
    expect((await send(h, "/console/anotar")).status).toBe(401);
    expect((await post(h, { texto: SALE_TEXT })).status).toBe(401);
    expect(calls()).toBe(0);
  });

  for (const role of ["staff", "owner"] as const) {
    it(`lets ${role} read a sale and shows it without saving`, async () => {
      const { h, answer, calls } = anotarHarness();
      const { cookie, csrf } = await session(h, role);
      const form = await send(h, "/console/anotar", { cookie });
      expect(form.status).toBe(200);
      const formPage = await form.text();
      expect(formPage).toContain('enctype="multipart/form-data"');
      expect(formPage).toContain('<body data-layout="console">');

      answer(saleByText);
      const response = await post(h, { csrf, para: "tienda", texto: SALE_TEXT }, { cookie });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const page = await response.text();
      expect(page).toContain("<h3>Venta</h3>");
      expect(page).toContain("3 refresco a L 20 c/u");
      expect(page).toContain("Todavía no se guarda nada.");
      expect(calls()).toBe(1);
    });
  }

  it("reads a Pedido a mano as an order", async () => {
    const { h, answer } = anotarHarness();
    const { cookie, csrf } = await session(h);
    answer(pedidoAMano);
    const page = await (await post(h, { csrf, para: "pedido", texto: PEDIDO_TEXT }, { cookie })).text();
    expect(page).toContain("<h3>Pedido</h3>");
    expect(page).toContain("Lo pasa a traer");
  });
});

describe("Anotar: refused posts", () => {
  it("refuses a post without the CSRF value, before reading", async () => {
    const { h, calls } = anotarHarness();
    const { cookie } = await session(h);
    expect((await post(h, { texto: SALE_TEXT }, { cookie })).status).toBe(403);
    expect((await post(h, { csrf: "0".repeat(64), texto: SALE_TEXT }, { cookie })).status).toBe(403);
    expect(calls()).toBe(0);
  });

  it("refuses a post from another site", async () => {
    const { h, calls } = anotarHarness();
    const { cookie, csrf } = await session(h);
    expect((await post(h, { csrf, texto: SALE_TEXT }, { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(calls()).toBe(0);
  });

  it("refuses a photo over 5 MB without storing or reading it", async () => {
    const { h, calls } = anotarHarness();
    const { store, cookie, csrf } = await session(h);
    const response = await post(h, { csrf, foto: new Blob([jpeg(MAX_PHOTO_BYTES + 1)], { type: "image/jpeg" }) }, { cookie });
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("La foto puede pesar hasta 5 MB");
    expect(calls()).toBe(0);
    expect(await objectsUnder(store.businessId)).toEqual([]);
  });

  it("refuses an oversize body before the CSRF check reads it", async () => {
    const { h, calls } = anotarHarness();
    const { cookie } = await session(h);
    // No CSRF value: the size limit answers first (413, not 403).
    const response = await post(h, { foto: new Blob([jpeg(MAX_ANOTAR_BODY_BYTES + 1)], { type: "image/jpeg" }) }, { cookie });
    expect(response.status).toBe(413);
    expect(calls()).toBe(0);
  });

  it("answers recorded audio with not yet, without reading", async () => {
    const { h, calls } = anotarHarness();
    const { cookie, csrf } = await session(h);
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0]);
    const response = await post(h, { csrf, foto: new Blob([ogg], { type: "audio/ogg" }) }, { cookie, filename: "nota.ogg" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Las notas de voz aquí vienen pronto.");
    expect(calls()).toBe(0);
  });

  it("asks for something when the form is empty", async () => {
    const { h, calls } = anotarHarness();
    const { cookie, csrf } = await session(h);
    const response = await post(h, { csrf, texto: "" }, { cookie });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Escribí algo o tomá una foto, y lo leo.");
    expect(calls()).toBe(0);
  });
});

describe("Anotar: one store's session never reaches another store's media", () => {
  it("stores the photo under the session's store whatever the form names", async () => {
    const { h, answer } = anotarHarness();
    const mine = await session(h);
    const other = await storeWithStaff();
    answer(setupCardPhoto);
    const response = await post(
      h,
      {
        csrf: mine.csrf,
        businessId: other.businessId,
        business_id: other.businessId,
        tienda: other.businessId,
        prefix: `stores/${other.businessId}/console`,
        foto: new Blob([jpeg()], { type: "image/jpeg" }),
      },
      { cookie: mine.cookie, filename: `../../stores/${other.businessId}/x.jpg` },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Producto nuevo: Aceite Mazola 1 L");
    const keys = await objectsUnder(mine.store.businessId);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^stores/${mine.store.businessId}/console/[0-9a-f]{64}$`));
    expect(await objectsUnder(other.businessId)).toEqual([]);
  });
});

describe("Anotar: failures", () => {
  it("shows a try-later notice when storage or the ledger fails, never an error page", async () => {
    const failing = { read: async () => Promise.reject(new Error("ledger down")) } as unknown as BurstReader;
    const h = harness({ burstReader: failing });
    const { cookie, csrf } = await session(h);
    const response = await post(h, { csrf, texto: SALE_TEXT }, { cookie });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("No pude leerlo ahorita. Probá otra vez en un rato.");
    expect(h.log.fields("console_reader.failed")).toHaveLength(1);
    expect(h.log.lines.join("\n")).not.toContain("refrescos");
  });
});
