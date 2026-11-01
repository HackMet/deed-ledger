/**
 * A new customer's first message (#30, reworked Oct 31): one bubble with a greeting, the real
 * reply, and ALTO with the privacy notice; a bare "hola" gets the welcome with Horario and
 * Hablar con buttons, whose taps are routed by code. Readings are recorded (synthetic).
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { gatedHandler } from "../src/application/customer-gate";
import type { JobHandler, ModelProvider, ModelRequest } from "../src/application/ports";
import type { StoreHours } from "../src/domain/contract/outcomes";
import {
  handoffLine,
  INTRO_BUTTON_IDS,
  introButtons,
  introduceReply,
  introduction,
  stopConfirmed,
} from "../src/domain/customer-controls";
import { greetingLine, WHAT_TO_ORDER } from "../src/domain/replies";
import { MemoryEngine, type PretendProduct } from "../src/infrastructure/memory/memory-engine";
import { type Harness, harness, rows, testEnv } from "./helpers/harness";
import { newPhone, seedStore, type SeededStore } from "./helpers/seed";
import { buttonReply, textMessage, wamid, webhook } from "./helpers/whatsapp";

const BASE_URL = "https://tienda.test";
const STORE = "Punto de prueba";
const VOICE = { storeName: STORE, ownerName: "Johan", privacyUrl: `${BASE_URL}/privacidad` };
const HOURS: StoreHours = [{ days: [1, 2, 3, 4, 5, 6], opens: "07:00", closes: "19:00" }];
const HOURS_TEXT = "Abrimos de lunes a sábado de 7 a. m. a 7 p. m.";
const CATALOG: PretendProduct[] = [
  { productId: "p-arroz", names: ["Arroz 1 lb", "Arroz"], aliases: [], barcode: null, price: 1800, availability: "hay" },
];

const WELCOME = [
  "¡Buenas! 👋 Soy el asistente de *Punto de prueba* 🛒",
  "Te tomo el pedido y te aviso cuando esté listo. ¿Qué te mando?",
  "_Si no querés recibir mensajes, escribí ALTO. Tus datos: https://tienda.test/privacidad_",
].join("\n");

class RecordedProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  readonly requests: ModelRequest[] = [];
  constructor(private readonly readings: unknown[]) {}
  async complete(request: ModelRequest) {
    this.requests.push(request);
    const json = this.readings.shift();
    if (json === undefined) throw new Error("no recorded reading left");
    return { ok: true, json, latencyMs: 10, inputTokens: 1, outputTokens: 1 } as const;
  }
}

const GREETING = { observations: [{ kind: "other", issues: [] }] };
const ASK_RICE = { observations: [{ kind: "question", topic: "availability", products: ["arroz"], issues: [] }] };

async function storeWithOwner(): Promise<SeededStore> {
  const store = await seedStore({ name: STORE, members: [{ phone: newPhone(), role: "owner" }] });
  await env.DB.prepare(`UPDATE users SET display_name = 'Johan Pérez' WHERE id = ?`).bind(store.members[0]!.userId).run();
  return store;
}

async function trip(readings: unknown[], options: { privacy?: boolean; owner?: boolean; jobHandler?: (h: Harness) => JobHandler } = {}) {
  const store = options.owner === false ? await seedStore({ name: STORE, members: [] }) : await storeWithOwner();
  const phone = newPhone();
  const provider = new RecordedProvider(readings);
  let handler: JobHandler | undefined;
  const h = harness({
    engine: new MemoryEngine(() => [], { catalog: CATALOG, storeHours: HOURS }),
    modelProvider: provider,
    env: testEnv((options.privacy === false ? {} : { PUBLIC_BASE_URL: BASE_URL }) as unknown as Partial<Env>),
    ...(options.jobHandler === undefined ? {} : { jobHandler: { handle: (input) => handler!.handle(input) } }),
  });
  if (options.jobHandler !== undefined) handler = options.jobHandler(h);
  const post = async (message: unknown) => {
    await h.post(webhook(store.phoneNumberId, { messages: [message] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
  };
  const at = () => {
    h.clock.advance(1_000);
    return { from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000) };
  };
  return {
    h,
    store,
    provider,
    say: (body: string) => post(textMessage({ ...at(), body })),
    tap: (replyId: string, title: string) => post(buttonReply({ ...at(), replyId, title })),
    sent: () => h.channel.sent.filter((message) => message.toPhone === phone),
  };
}

describe("the first-contact copy", () => {
  it("greets, asks what to send, and ends with ALTO and the privacy notice", () => {
    expect(introduction(VOICE)).toBe(WELCOME);
    for (const old of ["asistente automático", "ni una persona", "quiero hablar con", "escribí:"]) {
      expect(introduction(VOICE)).not.toContain(old);
    }
    expect(introButtons(VOICE)).toEqual([
      { id: INTRO_BUTTON_IDS.hours, title: "🕘 Horario" },
      { id: INTRO_BUTTON_IDS.handoff, title: "🙋 Hablar con Johan" },
    ]);
  });

  it("leaves the privacy link out when there is none, and falls back for the owner's name", () => {
    const bare = { storeName: "X", ownerName: null, privacyUrl: null };
    expect(introduction(bare).split("\n").at(-1)).toBe("_Si no querés recibir mensajes, escribí ALTO._");
    const titles = [bare, { ...bare, ownerName: "Maximiliano" }].map((voice) => introButtons(voice)[1]!.title);
    for (const title of titles) {
      expect(title).toBe("✋ Hablar con alguien");
      expect(title.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("a new customer's first reply", () => {
  it("is one bubble: greeting, the real answer with its claims, then ALTO", async () => {
    const t = await trip([ASK_RICE]);
    await t.say("¿Hay arroz?");
    expect(t.sent().map((message) => message.body)).toEqual([introduceReply(VOICE, "Arroz: sí hay.")]);
    // The answer's claim went with it, and still held when dispatch checked it again.
    const [row] = await rows<{ claims_json: string | null; claims_blocked_at_ms: number | null }>(
      `SELECT claims_json, claims_blocked_at_ms FROM outbound_messages WHERE business_id = ?`,
      t.store.businessId,
    );
    expect(row!.claims_json).toContain("p-arroz");
    expect(row!.claims_blocked_at_ms).toBeNull();
  });

  it("keeps the real reply's buttons, claims and burst flag", async () => {
    const claims = [{ anyOf: [{ type: "store_hours" as const, hours: HOURS }] }];
    const buttons = [{ id: "confirm:o-1:v1", title: "Confirmar" }];
    const t = await trip([], {
      jobHandler: (h) =>
        gatedHandler(
          { controls: h.deps.customerControls, jobs: h.deps.jobs, pendientes: h.deps.pendientes, clock: h.clock, log: h.log, privacyUrl: VOICE.privacyUrl },
          { handle: async () => ({ replies: [{ body: "Te anoto 2 libras de arroz.", ttlMs: 3_600_000, closesBurst: true, claims, buttons }] }) },
        ),
    });
    await t.say("2 libras de arroz");
    expect(t.sent()).toEqual([expect.objectContaining({ body: introduceReply(VOICE, "Te anoto 2 libras de arroz."), buttons })]);
  });

  it("is the welcome on its own when the job has nothing else to say", async () => {
    const t = await trip([], {
      jobHandler: (h) =>
        gatedHandler(
          { controls: h.deps.customerControls, jobs: h.deps.jobs, pendientes: h.deps.pendientes, clock: h.clock, log: h.log, privacyUrl: VOICE.privacyUrl },
          { handle: async () => ({ replies: [] }) },
        ),
    });
    await t.say("👍");
    await t.say("👍");
    expect(t.sent()).toEqual([expect.objectContaining({ body: WELCOME, buttons: introButtons(VOICE) })]);
  });

  it("is a bare hola's welcome, with Horario and Hablar con, once", async () => {
    const t = await trip([GREETING, GREETING]);
    await t.say("Hola");
    expect(t.sent()).toEqual([expect.objectContaining({ body: WELCOME, buttons: introButtons(VOICE) })]);
    // Introduced once: later, a greeting gets "¡Buenas! 👋" and the same question, without buttons.
    await t.say("hola?");
    expect(t.sent().at(-1)!.body).toBe(`${greetingLine(null)}\n${WHAT_TO_ORDER}`);
    expect(t.sent().at(-1)!.buttons).toBeUndefined();
  });

  it("leaves the privacy link out when PUBLIC_BASE_URL isn't set, and says alguien without an owner", async () => {
    const t = await trip([GREETING], { privacy: false, owner: false });
    await t.say("Hola");
    const [first] = t.sent();
    expect(first!.body.split("\n").at(-1)).toBe("_Si no querés recibir mensajes, escribí ALTO._");
    expect(first!.buttons![1]!.title).toBe("✋ Hablar con alguien");
  });

  it("starts with the greeting when the first message is ALTO, in the same bubble", async () => {
    const t = await trip([]);
    await t.say("ALTO");
    expect(t.sent().map((message) => message.body)).toEqual([
      ["¡Buenas! 👋 Soy el asistente de *Punto de prueba* 🛒", stopConfirmed(VOICE), `_Tus datos: ${BASE_URL}/privacidad_`].join("\n"),
    ]);
  });

  it("starts with the greeting when the first message asks for Johan, and keeps ALTO", async () => {
    const t = await trip([]);
    await t.say("quiero hablar con Johan");
    expect(t.sent().map((message) => message.body)).toEqual([introduceReply(VOICE, handoffLine(VOICE))]);
  });
});

describe("the welcome's buttons, tapped", () => {
  it("Horario answers the store hours by code, with no model call", async () => {
    const t = await trip([GREETING]);
    await t.say("Hola");
    await t.tap(INTRO_BUTTON_IDS.hours, "🕘 Horario");
    expect(t.sent().at(-1)!.body).toBe(HOURS_TEXT);
    // Neither the greeting nor the tap is read by the model.
    expect(t.provider.requests).toHaveLength(0);
  });

  it("Hablar con Johan hands off to the store, by the button's ID", async () => {
    const t = await trip([GREETING]);
    await t.say("Hola");
    await t.tap(INTRO_BUTTON_IDS.handoff, "🙋 Hablar con Johan");
    expect(t.sent().at(-1)!.body).toBe(handoffLine(VOICE));
    expect(t.h.log.fields("pendiente_raised").filter((line) => line.businessId === t.store.businessId)).toHaveLength(1);
    expect(t.provider.requests).toHaveLength(0);
  });
});
