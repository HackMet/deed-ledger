/**
 * A demo store's past few days: customers who wrote in, orders in every state, an invoice received
 * and one waiting, so a visitor sees the whole console before placing an order of their own.
 *
 * Every message goes through the same intake, processor, order handler and engine as a WhatsApp
 * message, and every staff step through the console's own action runner, so the ledger, the Deed's
 * checks and the replies are the product's. Only the reading is scripted: each customer message
 * has a fixed reading instead of a Muse Spark call, so seeding costs nothing and can't drift.
 *
 * Nothing in it is real: names, phones, places and prices are made up. The seeded customers' phones
 * are synthetic demo phones, which the demo's channel never sends to, and none is the visitor's.
 */
import type { Engine, LineMatch, MemberContext } from "./engine";
import type { BurstRead, BurstReader, BurstReaderInput } from "./order-handler";
import type { ReceiptService } from "./receipts";
import type { ButtonsShown, Clock, ConversationRef, Deps, InboundMessageEvent, Tenant } from "./ports";
import type { ConsoleAction } from "../domain/contract/actions";
import type { ItemLine, Observation } from "../domain/contract/observation";
import { acceptEvents } from "./intake";
import { processConversation } from "./processor";
import { dispatchOutbox } from "./dispatch";
import { runConsoleAction } from "./console-actions";
import { staffKey } from "./engine/order-engine";
import { describeError } from "./errors";
import { SETTLE_MS } from "../domain/processing";
import { productNameKey } from "../domain/store-setup";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** How far back the store's setup is dated: before the oldest seeded order. */
export const DEMO_HISTORY_SPAN_MS = 4 * DAY_MS;

/** One order line as the customer wrote it, and the store's product it names. */
interface ScriptLine {
  readonly words: string;
  readonly quantity: string;
  readonly product: string;
}

type Fulfillment = { readonly mode: "pickup" } | { readonly mode: "delivery"; readonly place: string };

type StaffStep = "start_preparing" | "mark_ready" | "dispatch" | "mark_delivered";

/** One customer's order, from the first message to where the script leaves it. */
interface ScriptOrder {
  readonly customer: string;
  /** How long before the store opened the customer wrote. */
  readonly agoMs: number;
  readonly text: string;
  readonly lines: readonly ScriptLine[];
  readonly fulfillment: Fulfillment;
  /** Added before confirming: a new version, and the old Confirmar tapped first (a stale_version refusal). */
  readonly addBeforeConfirm?: { readonly text: string; readonly lines: readonly ScriptLine[] };
  /** "cancel": the customer taps Cancelar on the readback. "confirm_twice": Confirmar tapped twice (a duplicate). */
  readonly answer: "confirm" | "confirm_twice" | "cancel";
  /** After confirming, the customer asks for more: a change request left for the owner. */
  readonly changeAfterConfirm?: { readonly text: string; readonly lines: readonly ScriptLine[] };
  readonly staff: readonly StaffStep[];
}

const line = (words: string, quantity: string, product: string): ScriptLine => ({ words, quantity, product });

/** Newest first, the order they are seeded in: today's show up first. Product names are the demo catalog's (demo-store.ts). */
export const DEMO_HISTORY: readonly ScriptOrder[] = [
  {
    customer: "Ana",
    agoMs: 30 * MINUTE_MS,
    text: "2 paquetes de tortillas y 3 consomés, me lo traen al Barrio El Centro, frente a la pulpería",
    lines: [line("2 paquetes de tortillas", "2", "Tortillas (paquete de 10)"), line("3 consomés", "3", "Consomé de pollo (cubito)")],
    fulfillment: { mode: "delivery", place: "Barrio El Centro, frente a la pulpería" },
    answer: "confirm",
    staff: ["start_preparing", "mark_ready", "dispatch"],
  },
  {
    customer: "Mario",
    agoMs: 40 * MINUTE_MS,
    text: "Una Coca de 2 litros y 2 sardinas, lo recojo",
    lines: [line("una Coca de 2 litros", "1", "Coca-Cola 2 L"), line("2 sardinas", "2", "Sardina en lata")],
    fulfillment: { mode: "pickup" },
    addBeforeConfirm: { text: "Y una salsa de tomate", lines: [line("una salsa de tomate", "1", "Salsa de tomate")] },
    answer: "confirm",
    staff: ["mark_ready"],
  },
  {
    customer: "Yesenia",
    agoMs: 50 * MINUTE_MS,
    text: "Una mantequilla crema y una libra de queso seco, lo recojo",
    lines: [line("una mantequilla crema", "1", "Mantequilla crema 1 lb"), line("una libra de queso seco", "1", "Queso seco 1 lb")],
    fulfillment: { mode: "pickup" },
    answer: "confirm",
    staff: ["start_preparing"],
  },
  {
    customer: "Kevin",
    agoMs: 65 * MINUTE_MS,
    text: "2 Maseca y 1 libra de azúcar, lo recojo",
    lines: [line("2 Maseca", "2", "Maseca 1 kg"), line("1 libra de azúcar", "1", "Azúcar 1 lb")],
    fulfillment: { mode: "pickup" },
    answer: "confirm_twice",
    staff: [],
  },
  {
    customer: "Rosa",
    agoMs: 80 * MINUTE_MS,
    text: "Un café molido y un pan de molde, lo recojo",
    lines: [line("un café molido", "1", "Café molido 200 g"), line("un pan de molde", "1", "Pan de molde")],
    fulfillment: { mode: "pickup" },
    answer: "confirm",
    changeAfterConfirm: { text: "Agregame 4 pan dulce porfa", lines: [line("4 pan dulce", "4", "Pan dulce (unidad)")] },
    staff: [],
  },
  {
    customer: "Lupita",
    agoMs: DAY_MS + 3 * HOUR_MS,
    text: "3 Coca-Cola de 600 y una bolsa de hielo, lo recojo",
    lines: [line("3 Coca-Cola de 600", "3", "Coca-Cola 600 ml"), line("una bolsa de hielo", "1", "Bolsa de hielo")],
    fulfillment: { mode: "pickup" },
    answer: "confirm",
    staff: ["mark_ready", "mark_delivered"],
  },
  {
    customer: "José",
    agoMs: DAY_MS + 6 * HOUR_MS,
    text: "Un papel higiénico y un detergente, lo recojo",
    lines: [line("un papel higiénico", "1", "Papel higiénico (4 rollos)"), line("un detergente", "1", "Detergente 500 g")],
    fulfillment: { mode: "pickup" },
    answer: "cancel",
    staff: [],
  },
  {
    customer: "Carlos",
    agoMs: 2 * DAY_MS + 5 * HOUR_MS,
    text: "Un cartón de huevos y 2 leches, me lo traen a la colonia San José, casa azul",
    lines: [line("un cartón de huevos", "1", "Cartón de huevos (30)"), line("2 leches", "2", "Leche entera 1 L")],
    fulfillment: { mode: "delivery", place: "colonia San José, casa azul" },
    answer: "confirm",
    staff: ["start_preparing", "mark_ready", "dispatch", "mark_delivered"],
  },
  {
    customer: "Marta",
    agoMs: 3 * DAY_MS + 2 * HOUR_MS,
    text: "Buenas, 2 libras de arroz, 1 de frijoles y un aceite Clover. Paso a traerlo",
    lines: [line("2 libras de arroz", "2", "Arroz 1 lb"), line("1 de frijoles", "1", "Frijoles rojos 1 lb"), line("un aceite Clover", "1", "Aceite Clover 1 L")],
    fulfillment: { mode: "pickup" },
    answer: "confirm",
    staff: ["start_preparing", "mark_ready", "mark_delivered"],
  },
];

/** A clock the seed moves by hand, so each step is dated when it happened. */
export class SeedClock implements Clock {
  constructor(private at: number) {}
  now(): number {
    return this.at;
  }
  set(atMs: number): void {
    this.at = atMs;
  }
  advance(ms: number): void {
    this.at += ms;
  }
}

/**
 * Perception, scripted: each message the seed sends has its reading here, keyed by its text. The
 * products come from the store's own catalog by name, as code matches them. A message with no
 * reading is a seed bug and fails loudly.
 */
export class ScriptedOrderReader implements BurstReader {
  private readonly readings = new Map<string, (message: number, text: string) => { observations: Observation[]; matches: LineMatch[] }>();
  private products = new Map<string, string>();

  setCatalog(rows: readonly { readonly id: string; readonly name: string }[]): void {
    this.products = new Map(rows.map((row) => [productNameKey(row.name), row.id]));
  }

  order(text: string, lines: readonly ScriptLine[], fulfillment: Fulfillment | null): void {
    this.readings.set(text, (message, body) => {
      const items = lines.map((l) => this.item(l, message, body));
      const observations: Observation[] = [{ kind: "customer_order", lines: items, issues: [] }];
      if (fulfillment !== null) {
        observations.push({
          kind: "fulfillment",
          mode: fulfillment.mode,
          pin: null,
          placeText: fulfillment.mode === "delivery" ? fulfillment.place : null,
          sameAsBefore: false,
          issues: [],
        });
      }
      return { observations, matches: lines.map((l, n) => ({ observation: -1, line: n, productId: this.productId(l.product), how: "exact_name" as const })) };
    });
  }

  change(text: string, lines: readonly ScriptLine[]): void {
    this.readings.set(text, (message, body) => ({
      observations: [{ kind: "order_change", edits: lines.map((l) => ({ op: "add" as const, line: this.item(l, message, body) })), issues: [] }],
      matches: lines.map((l, n) => ({ observation: -1, line: n, productId: this.productId(l.product), how: "exact_name" as const })),
    }));
  }

  name(text: string): void {
    this.readings.set(text, (message, body) => ({
      observations: [{ kind: "customer_name", name: text, evidence: { source: "text", message, start: 0, end: body.length }, issues: [] }],
      matches: [],
    }));
  }

  async read({ messages }: BurstReaderInput): Promise<BurstRead> {
    const observations: Observation[] = [];
    const matches: LineMatch[] = [];
    messages.forEach((message, index) => {
      const text = message.textBody ?? "";
      const reading = this.readings.get(text);
      if (reading === undefined) throw new Error("demo history: a message with no scripted reading");
      const read = reading(index, text);
      const base = observations.length;
      observations.push(...read.observations);
      // Each script's matches name its first observation (the order or the change).
      matches.push(...read.matches.map((match) => ({ ...match, observation: base })));
    });
    return { reading: { observations, calls: [] }, matches, pendingQuestion: null };
  }

  private item(l: ScriptLine, message: number, body: string): ItemLine {
    const start = Math.max(0, body.indexOf(l.words));
    return {
      text: l.words,
      name: l.words,
      quantity: l.quantity,
      unit: null,
      restrictedCategory: false,
      evidence: { source: "text", message, start, end: start + l.words.length },
    };
  }

  private productId(name: string): string {
    const id = this.products.get(productNameKey(name));
    if (id === undefined) throw new Error("demo history: a scripted product the catalog doesn't have");
    return id;
  }
}

export interface DemoHistoryDeps {
  /** The runtime's deps, built on `clock`, a doorbell that rings nothing, and `reader` behind the order handler. */
  readonly deps: Deps;
  readonly clock: SeedClock;
  readonly reader: ScriptedOrderReader;
  readonly engine: Engine;
  readonly receipts: ReceiptService;
  readonly buttonsShown: ButtonsShown;
  readonly catalog: (tenant: Tenant) => Promise<readonly { readonly id: string; readonly name: string }[]>;
  /** A synthetic demo phone per seeded customer. */
  readonly newPhone: () => string;
  /** Supplier invoices to seed, as image bytes the receipt reader has recordings for: approved first, then left to review. */
  readonly invoices: { readonly approved: Uint8Array | null; readonly pending: Uint8Array | null };
}

export interface DemoStoreRefs {
  readonly businessId: string;
  readonly phoneNumberId: string;
  readonly owner: MemberContext;
}

/**
 * The queue message for one piece of a demo store's history. Seeding a whole store in one request
 * takes far more D1 queries than one Worker invocation may make, so each piece is its own message
 * on the demo-seed queue, which delivers one per batch: each piece runs in an invocation of its own,
 * apart from the doorbells, and the queue runs several at once. Item n (0 to DEMO_HISTORY.length - 1)
 * is the n-th order, the last item the invoices. The pieces don't depend on each other: each is its
 * own customer on its own conversation. Only the store's ID travels; everything else is read back
 * from the store, and only a live demo store is seeded.
 */
export interface DemoHistoryMessage {
  readonly v: 1;
  readonly kind: "demo_history";
  readonly businessId: string;
  readonly item: number;
}

export const DEMO_HISTORY_ITEMS = DEMO_HISTORY.length + 1;

/** Where the pieces are queued: the demo-seed queue in production. */
export interface DemoHistoryQueue {
  sendBatch(messages: readonly { readonly body: DemoHistoryMessage; readonly delaySeconds?: number }[]): Promise<void>;
}

/**
 * `schedule` queues every piece of a new store's history at once; `run` seeds one from the queue;
 * `later` puts a piece back on the demo-seed queue for a moment, as a fresh message; `loading` says
 * whether a demo store's history is still being written, for the console to say so.
 */
export interface DemoHistoryRunner {
  schedule(businessId: string): Promise<void>;
  run(message: DemoHistoryMessage): Promise<void>;
  later(message: DemoHistoryMessage): Promise<void>;
  loading(businessId: string): Promise<boolean>;
}

/** How long after a demo store opens its history may still be loading; after it, the console stops waiting. */
export const DEMO_HISTORY_WAIT_MS = 3 * MINUTE_MS;

/** The provider message ID of the n-th message the seed sends for an item: fixed, so a redelivered piece is a duplicate. */
export function seedMessageId(item: number, n: number): string {
  return `demo.seed.${item}.${n}`;
}

/** How many messages the seed sends for an order, as seedOrder sends them. */
export function seedMessageCount(order: ScriptOrder): number {
  const added = order.addBeforeConfirm === undefined ? 0 : 2;
  if (order.answer === "cancel") return 2 + added;
  return 3 + added + (order.answer === "confirm_twice" ? 1 : 0) + (order.changeAfterConfirm === undefined ? 0 : 1);
}

const STEP_STATE: Record<StaffStep, string> = {
  start_preparing: "preparando",
  mark_ready: "listo",
  dispatch: "en_camino",
  mark_delivered: "entregado",
};

/** The state the script leaves an order in. */
export function seedFinalState(order: ScriptOrder): string {
  if (order.answer === "cancel") return "cancelado";
  const last = order.staff[order.staff.length - 1];
  return last === undefined ? "confirmado" : STEP_STATE[last];
}

/** What the store holds of its history: each seeded order's first message ID, its last, and the order's state. */
export interface SeedProgress {
  /** Every seed message ID the store received. */
  readonly messageIds: ReadonlySet<string>;
  /** The state of the order each item's first message started, by item; absent: no order yet. */
  readonly stateByItem: ReadonlyMap<number, string>;
  /** Supplier invoices drafted. */
  readonly invoices: number;
}

/**
 * Whether the history is written: every order has its last message and the state the script leaves
 * it in, and the invoices are there. A piece that failed never completes, so callers stop waiting
 * after DEMO_HISTORY_WAIT_MS.
 */
export function historyComplete(progress: SeedProgress, invoices: number): boolean {
  if (progress.invoices < invoices) return false;
  return DEMO_HISTORY.every(
    (order, item) =>
      progress.messageIds.has(seedMessageId(item, seedMessageCount(order) - 1)) && progress.stateByItem.get(item) === seedFinalState(order),
  );
}

export function demoHistoryMessage(businessId: string, item: number): DemoHistoryMessage {
  return { v: 1, kind: "demo_history", businessId, item };
}

export function parseDemoHistoryMessage(body: unknown): DemoHistoryMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const { v, kind, businessId, item } = body as Record<string, unknown>;
  if (v !== 1 || kind !== "demo_history" || typeof businessId !== "string" || businessId === "") return null;
  if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item >= DEMO_HISTORY_ITEMS) return null;
  return { v, kind, businessId, item };
}

/**
 * Seeds one piece of the history. A piece that fails is logged and left out: the store still opens
 * with the rest. Its message IDs are fixed per piece, so a message delivered twice seeds once: the
 * second delivery's first message is a duplicate intake drops, and the piece stops there.
 */
export async function seedDemoHistoryItem(h: DemoHistoryDeps, store: DemoStoreRefs, item: number): Promise<boolean> {
  const tenant: Tenant = { businessId: store.businessId };
  const openedAtMs = store.owner.nowMs;
  try {
    if (item === DEMO_HISTORY.length) {
      await seedInvoices(h, store, openedAtMs);
      return true;
    }
    const order = DEMO_HISTORY[item];
    if (order === undefined) return false;
    h.reader.setCatalog(await h.catalog(tenant));
    h.reader.order(order.text, order.lines, order.fulfillment);
    if (order.addBeforeConfirm !== undefined) h.reader.order(order.addBeforeConfirm.text, order.addBeforeConfirm.lines, null);
    if (order.changeAfterConfirm !== undefined) h.reader.change(order.changeAfterConfirm.text, order.changeAfterConfirm.lines);
    h.reader.name(order.customer);
    h.clock.set(openedAtMs - order.agoMs);
    await seedOrder(h, store, order, item);
    return true;
  } catch (error) {
    h.deps.log.warn("demo_history_failed", { businessId: store.businessId, reason: `item ${item}: ${describeError(error)}` });
    return false;
  } finally {
    h.clock.set(openedAtMs);
  }
}

async function seedInvoices(h: DemoHistoryDeps, store: DemoStoreRefs, openedAtMs: number): Promise<void> {
  const at = (agoMs: number): MemberContext => ({ ...store.owner, nowMs: openedAtMs - agoMs });
  try {
    if (h.invoices.approved !== null) {
      const owner = at(3 * DAY_MS + 6 * HOUR_MS);
      const drafted = await h.receipts.upload(owner, { bytes: copy(h.invoices.approved) }, { seeded: true });
      if (drafted.type === "drafted") await h.receipts.approve({ ...owner, nowMs: owner.nowMs + 20 * MINUTE_MS }, drafted.draftId, 1);
    }
    if (h.invoices.pending !== null) await h.receipts.upload(at(2 * HOUR_MS), { bytes: copy(h.invoices.pending) }, { seeded: true });
  } catch (error) {
    h.deps.log.warn("demo_history_failed", { businessId: store.businessId, reason: `invoices: ${describeError(error)}` });
  }
}

async function seedOrder(h: DemoHistoryDeps, store: DemoStoreRefs, order: ScriptOrder, item: number): Promise<void> {
  const phone = h.newPhone();
  let sent = 0;
  const say = (message: Parameters<typeof sayOnce>[4]) => sayOnce(h, store, phone, seedMessageId(item, sent++), message);
  const conversation = await say({ text: order.text });
  if (order.addBeforeConfirm !== undefined) {
    const first = await readback(h, conversation);
    h.clock.advance(MINUTE_MS);
    await say({ text: order.addBeforeConfirm.text });
    // The customer taps the first readback's Confirmar after the order changed: refused as stale.
    h.clock.advance(MINUTE_MS);
    await say({ reply: first.confirm, title: "Confirmar" });
  }
  const shown = await readback(h, conversation);
  h.clock.advance(MINUTE_MS);
  if (order.answer === "cancel") {
    await say({ reply: shown.cancel, title: "Cancelar" });
    return;
  }
  await say({ reply: shown.confirm, title: "Confirmar" });
  // A first-time customer is asked their name before the order is confirmed.
  h.clock.advance(MINUTE_MS);
  await say({ text: order.customer });
  if (order.answer === "confirm_twice") {
    h.clock.advance(10_000);
    await say({ reply: shown.confirm, title: "Confirmar" });
  }

  for (const step of order.staff) {
    h.clock.advance(4 * MINUTE_MS);
    await staffStep(h, store, shown, step);
  }

  if (order.changeAfterConfirm !== undefined) {
    h.clock.advance(6 * MINUTE_MS);
    await say({ text: order.changeAfterConfirm.text });
  }
}

/** One customer message through intake and the processor, and its replies sent (to the demo channel). */
async function sayOnce(
  h: DemoHistoryDeps,
  store: DemoStoreRefs,
  phone: string,
  providerMessageId: string,
  message: { readonly text: string } | { readonly reply: string; readonly title: string },
): Promise<ConversationRef> {
  const nowMs = h.clock.now();
  const event: InboundMessageEvent = {
    type: "message",
    phoneNumberId: store.phoneNumberId,
    senderPhone: phone,
    providerMessageId,
    providerTimestampS: Math.floor(nowMs / 1000),
    contextMessageId: null,
    media: null,
    ...("text" in message
      ? { kind: "text" as const, textBody: message.text, replyId: null }
      : { kind: "interactive" as const, textBody: message.title, replyId: message.reply }),
  };
  const intake = await acceptEvents(h.deps, [event]);
  const conversation = intake.conversations[0];
  if (conversation === undefined) throw new Error("demo history: a message intake didn't take");
  // Past the settle window, as the queue would deliver it.
  h.clock.advance(SETTLE_MS + 1);
  const outcome = await processConversation(h.deps, conversation);
  if (outcome !== "processed") throw new Error(`demo history: processing ended ${outcome}`);
  await dispatchOutbox(h.deps, { limit: 10, conversation });
  return conversation;
}

/** The readback the customer was just sent, from its buttons, as a person reads them. */
async function readback(h: DemoHistoryDeps, conversation: ConversationRef): Promise<{ orderId: string; version: number; confirm: string; cancel: string }> {
  const buttons = await h.buttonsShown.lastButtons(conversation, h.clock.now() + 1);
  const confirm = buttons.find((button) => button.id.startsWith("confirm:"))?.id;
  const cancel = buttons.find((button) => button.id.startsWith("cancel:"))?.id;
  const ref = confirm === undefined ? null : /^confirm:(.+):v(\d+)$/.exec(confirm);
  if (confirm === undefined || cancel === undefined || ref == null) throw new Error("demo history: no readback to answer");
  return { orderId: ref[1]!, version: Number(ref[2]), confirm, cancel };
}

/** A staff tap on the console, run as the console runs it, on the version the customer confirmed. */
async function staffStep(h: DemoHistoryDeps, store: DemoStoreRefs, ref: { readonly orderId: string; readonly version: number }, step: StaffStep): Promise<void> {
  const member: MemberContext = { ...store.owner, nowMs: h.clock.now() };
  const order = { orderId: ref.orderId, version: ref.version };
  const action = (step === "dispatch" ? { type: step, courierMemberId: member.memberId, ...order } : { type: step, ...order }) as Extract<
    ConsoleAction,
    { type: StaffStep }
  >;
  const result = await runConsoleAction(h.deps, h.engine, member, {
    operationKey: staffKey(action),
    actor: { type: "member", memberId: member.memberId, role: member.role },
    action,
  });
  if (result.outcome.type !== "action_saved") throw new Error(`demo history: ${step} ended ${result.outcome.type}`);
  for (const conversation of result.dispatch) await dispatchOutbox(h.deps, { limit: 10, conversation });
}

function copy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
