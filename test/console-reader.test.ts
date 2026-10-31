/**
 * The console reader as the engine's tests call it: exported function, no HTTP, real D1 spend cap
 * and R2, a provider answering with recorded responses. No test touches the network.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  consoleMediaPrefix,
  type ConsoleInput,
  type ConsoleReaderDeps,
  MAX_PHOTO_BYTES,
  MAX_TEXT_CHARS,
  readConsoleInput,
} from "../src/application/console-reader";
import { SYSTEM_PROMPT } from "../src/application/perception/prompt";
import { BurstReader } from "../src/application/perception/reader";
import type { MediaBytes, MediaStore, StoredMedia, Tenant } from "../src/application/ports";
import { buildBurstReader } from "../src/composition";
import { R2MediaStore } from "../src/infrastructure/r2-media-store";
import { D1SpendLedger } from "../src/infrastructure/d1/spend-repository";
import { MuseSparkProvider } from "../src/integrations/meta/spark";
import {
  consoleWithCustomerKind,
  FIADO_TEXT,
  fiadoByText,
  PEDIDO_NOT_AN_ORDER_TEXT,
  PEDIDO_TEXT,
  pedidoAMano,
  pedidoNotAnOrder,
  SALE_TEXT,
  saleByText,
  setupCardPhoto,
} from "./fixtures/model/console";
import { catalog, type Recorded } from "./fixtures/model/recorded";
import { FakeClock, RecordingLogger } from "./helpers/fakes";
import { seedStore } from "./helpers/seed";

const FAKE_KEY = "test-model-key-not-real";

/** Starts like a JPEG; not a real image. */
const jpegBytes = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]).buffer;
const oggBytes = () => new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0]).buffer;

function completion(recorded: Recorded): Response {
  return Response.json({
    model: "muse-spark-1.3",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(recorded.response) } }],
    usage: recorded.usage,
  });
}

interface SentBody {
  messages: { role: string; content: unknown }[];
  response_format: { json_schema: { schema: unknown } };
}

/** What the engine's tests would build: the composition's reader with a recorded fetch, real R2. */
function setup(recorded: Recorded | null, options: { cap?: number } = {}) {
  const requests: SentBody[] = [];
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    requests.push(JSON.parse(String(init.body)) as SentBody);
    if (recorded === null) throw new Error("no model call expected");
    return completion(recorded);
  };
  const log = new RecordingLogger();
  const clock = new FakeClock(Date.UTC(2026, 9, 31, 18, 0, 0));
  const reader =
    options.cap === undefined
      ? buildBurstReader({ ...env, MODEL_API_KEY: FAKE_KEY } as Env, { clock, log }, { fetch })
      : new BurstReader({
          provider: new MuseSparkProvider({ apiKey: FAKE_KEY, fetch }),
          spend: new D1SpendLedger(env.DB),
          clock,
          log,
          dailyCapMicroUsd: options.cap,
        });
  const deps: ConsoleReaderDeps = { reader, mediaStore: new R2MediaStore(env.MEDIA), log, catalog: async () => catalog };
  return { deps, requests, log };
}

let storeA: string;
let storeB: string;
beforeAll(async () => {
  storeA = (await seedStore({ members: [] })).businessId;
  storeB = (await seedStore({ members: [] })).businessId;
});

const member = () => ({ businessId: storeA, userId: "member-a" });

async function objectsUnder(businessId: string): Promise<string[]> {
  return (await env.MEDIA.list({ prefix: `stores/${businessId}/` })).objects.map((object) => object.key);
}

describe("readConsoleInput: console kinds", () => {
  it("reads a sale typed in the console, with the console prompt and schema", async () => {
    const { deps, requests, log } = setup(saleByText);
    const outcome = await readConsoleInput(deps, member(), { purpose: "report", inputs: [{ type: "text", text: SALE_TEXT }] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.purpose).toBe("report");
    expect(outcome.media).toEqual([]);
    expect(outcome.reading.observations).toEqual([
      {
        kind: "sale_report",
        lines: [
          {
            text: "tres refrescos",
            name: "refresco",
            quantity: "3",
            unit: null,
            restrictedCategory: false,
            unitPrice: 2000,
            evidence: { source: "text", message: 0, start: SALE_TEXT.indexOf("tres refrescos"), end: SALE_TEXT.indexOf("tres refrescos") + 14 },
          },
        ],
        issues: [],
      },
    ]);
    expect(outcome.reading.calls).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages[0]!.content).toBe(SYSTEM_PROMPT.console);
    expect(JSON.stringify(requests[0]!.response_format.json_schema.schema)).toContain('"sale_report"');
    expect(JSON.stringify(requests[0]!.response_format.json_schema.schema)).not.toContain('"customer_order"');
    // Logs carry the store and counts, never the note.
    expect(log.lines.join("\n")).not.toContain("refresco");
    expect(log.fields("console_reader.read")).toEqual([{ level: "info", event: "console_reader.read", businessId: storeA, count: 1, outcome: "report" }]);
  });

  it("reads a fiado typed in the console and matches its line to the catalog by code", async () => {
    const { deps } = setup(fiadoByText);
    const outcome = await readConsoleInput(deps, member(), { purpose: "report", inputs: [{ type: "text", text: FIADO_TEXT }] });
    if (!outcome.ok) throw new Error(outcome.reason);
    const [fiado] = outcome.reading.observations;
    expect(fiado).toMatchObject({ kind: "fiado_report", customer: "Doña Marta", lines: [{ name: "arroz", quantity: "2", unit: "libra", unitPrice: null }] });
    expect(outcome.matches).toEqual([{ observation: 0, line: 0, productId: "product-arroz-1lb", how: "exact_name" }]);
  });

  it("reads a setup card from a photo and stores the photo under the store's console prefix", async () => {
    const { deps, requests } = setup(setupCardPhoto);
    const bytes = jpegBytes();
    // The browser's claimed type is ignored: the bytes say JPEG.
    const outcome = await readConsoleInput(deps, member(), { purpose: "report", inputs: [{ type: "photo", bytes, contentType: "application/octet-stream" }] });
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.reading.observations).toEqual([
      { kind: "setup_card", name: "Aceite Mazola 1 L", unit: "botella", count: "12", price: 6500, barcode: null, issues: [] },
    ]);
    expect(outcome.media).toHaveLength(1);
    const stored = outcome.media[0]!;
    expect(stored.key).toBe(`${consoleMediaPrefix(storeA)}/${stored.sha256}`);
    expect(stored.key.startsWith(`stores/${storeA}/console/`)).toBe(true);
    const object = await env.MEDIA.get(stored.key);
    expect(object?.httpMetadata?.contentType).toBe("image/jpeg");
    expect(JSON.stringify(requests[0]!.messages[1]!.content)).toContain("data:image/jpeg;base64,");
  });

  it("refuses a console response that holds a customer kind", async () => {
    const { deps } = setup(consoleWithCustomerKind);
    const outcome = await readConsoleInput(deps, member(), { purpose: "report", inputs: [{ type: "text", text: SALE_TEXT }] });
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_output" });
  });
});

describe("readConsoleInput: Pedido a mano", () => {
  it("reads an order taken by hand like a customer's first message, with the order prompt", async () => {
    const { deps, requests } = setup(pedidoAMano);
    const outcome = await readConsoleInput(deps, member(), { purpose: "order", inputs: [{ type: "text", text: PEDIDO_TEXT }] });
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.purpose).toBe("order");
    expect(outcome.reading.observations.map((o) => o.kind)).toEqual(["customer_order", "fulfillment"]);
    expect(outcome.reading.observations[0]).toMatchObject({ lines: [{ name: "arroz", quantity: "3" }, { name: "aceite Mazola", quantity: "1" }] });
    expect(outcome.reading.observations[1]).toMatchObject({ mode: "pickup" });
    expect(outcome.matches).toEqual([{ observation: 0, line: 0, productId: "product-arroz-1lb", how: "exact_name" }]);
    expect(outcome.labelMatches).toEqual([{ observation: 0, line: 1, label: "P3", productId: "product-mazola-1l" }]);
    expect(requests[0]!.messages[0]!.content).toBe(SYSTEM_PROMPT.customer);
    // No open order and no pending question: a hand-taken order is always new.
    expect(JSON.stringify(requests[0]!.messages[1]!.content)).toContain("PEDIDO ABIERTO:\\nninguno");
  });

  it("keeps only order kinds: a cancel or a stop typed as a Pedido a mano reads as other, the warning kept", async () => {
    const { deps } = setup(pedidoNotAnOrder);
    const outcome = await readConsoleInput(deps, member(), { purpose: "order", inputs: [{ type: "text", text: PEDIDO_NOT_AN_ORDER_TEXT }] });
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.reading.observations).toEqual([
      { kind: "other", issues: [] },
      {
        kind: "other",
        issues: [
          {
            code: "embedded_instructions",
            line: null,
            evidence: { source: "text", message: 0, start: PEDIDO_NOT_AN_ORDER_TEXT.indexOf("IGNORA"), end: PEDIDO_NOT_AN_ORDER_TEXT.indexOf("IGNORA") + 18 },
          },
        ],
      },
    ]);
  });
});

describe("readConsoleInput: refusals before any call or write", () => {
  const cases: Array<[string, ConsoleInput[], string]> = [
    ["nothing", [], "empty"],
    ["blank text", [{ type: "text", text: "   " }], "empty"],
    ["text over the cap", [{ type: "text", text: "a".repeat(MAX_TEXT_CHARS + 1) }], "too_large"],
    ["a photo over 5 MB", [{ type: "photo", bytes: new Uint8Array(MAX_PHOTO_BYTES + 1).fill(0xff).buffer, contentType: "image/jpeg" }], "too_large"],
    ["recorded audio", [{ type: "audio", bytes: oggBytes(), contentType: "audio/ogg" }], "voice_not_ready"],
    ["audio sent as a photo", [{ type: "photo", bytes: oggBytes(), contentType: "image/jpeg" }], "voice_not_ready"],
    ["a HEIC or unknown file", [{ type: "photo", bytes: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]).buffer, contentType: "image/heic" }], "unsupported_photo"],
    ["too many parts", [1, 2, 3, 4].map((n) => ({ type: "text" as const, text: `nota ${n}` })), "too_many"],
  ];
  for (const [name, inputs, reason] of cases) {
    it(`refuses ${name}`, async () => {
      const { deps, requests } = setup(null);
      const before = await objectsUnder(storeB);
      const outcome = await readConsoleInput(deps, { businessId: storeB }, { purpose: "report", inputs });
      expect(outcome).toEqual({ ok: false, reason, media: [] });
      expect(requests).toHaveLength(0);
      expect(await objectsUnder(storeB)).toEqual(before);
    });
  }

  it("stops at the store's daily spend cap without calling the model", async () => {
    const { deps, requests } = setup(saleByText, { cap: 1 });
    const outcome = await readConsoleInput(deps, member(), { purpose: "report", inputs: [{ type: "text", text: SALE_TEXT }] });
    expect(outcome).toMatchObject({ ok: false, reason: "spend_cap" });
    expect(requests).toHaveLength(0);
  });
});

describe("readConsoleInput: the store comes from the member only", () => {
  it("writes to the member's store prefix and reads with the member's store, nothing else", async () => {
    const seen: { tenant: Tenant; prefix: string }[] = [];
    const real = new R2MediaStore(env.MEDIA);
    const spy: MediaStore = {
      putImmutable(tenant: Tenant, prefix: string, media: MediaBytes): Promise<StoredMedia> {
        seen.push({ tenant, prefix });
        return real.putImmutable(tenant, prefix, media);
      },
    };
    const tenants: string[] = [];
    const { deps } = setup(setupCardPhoto);
    const reader: ConsoleReaderDeps["reader"] = {
      read: (tenant, request) => {
        tenants.push(tenant.businessId);
        return deps.reader.read(tenant, request);
      },
    };
    const outcome = await readConsoleInput({ ...deps, reader, mediaStore: spy }, member(), {
      purpose: "report",
      inputs: [{ type: "photo", bytes: jpegBytes(), contentType: "image/jpeg" }],
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([{ tenant: { businessId: storeA }, prefix: `stores/${storeA}/console` }]);
    expect(tenants).toEqual([storeA]);
  });

  it("the media store refuses a prefix outside the tenant's", async () => {
    await expect(new R2MediaStore(env.MEDIA).putImmutable({ businessId: storeA }, consoleMediaPrefix(storeB), { bytes: jpegBytes(), contentType: "image/jpeg" })).rejects.toThrow(
      "outside the store's prefix",
    );
  });
});
