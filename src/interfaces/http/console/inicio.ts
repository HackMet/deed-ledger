/**
 * Inicio: what needs attention today, read only. The counts come from the same reads the other
 * screens use: the preparation list (Pedidos) and the owner's open Pendientes. A number that can't
 * be read isn't shown, never as 0 (absent means unknown). Nothing here writes.
 * "Probar como cliente" sits here too, the first thing seen, once the store has a WhatsApp number.
 *
 * There is no "sold today" card: no read sums a day's confirmed sales from the records yet.
 *
 * A new demo store's history is written in the background for its first minute or so: until it is,
 * the page says so and reloads itself every few seconds, instead of showing an empty day.
 */
import type { Hono } from "hono";
import { html } from "hono/html";
import { formatLempiras } from "../../../domain/contract/numbers";
import { isDemoBusiness } from "../../../domain/demo";
import type { OrderView, PreparationCard } from "../../../domain/contract/outcomes";
import { type ConsoleEnv, memberContext } from "./auth";
import { INICIO_PATH, PENDIENTES_PATH, readPendientes, shell } from "./layout";
import { chipFor, fulfillmentLine, orderPath } from "./preparacion";
import { TRY_STYLE, tryCard } from "./try-number";

const PEDIDOS_PATH = "/console/preparacion";
/** Honduras is UTC-6 all year. */
const STORE_OFFSET_MS = -6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PACKING = new Set<OrderView["state"]>(["confirmado", "preparando"]);
/** How often the page reloads while a demo store's history is still loading. */
export const HISTORY_REFRESH_S = 4;
export const HISTORY_LOADING = "Estamos cargando unos días de pedidos de ejemplo. Esta página se actualiza sola.";
const HISTORY_ARRIVING = "Los pedidos de ejemplo van llegando.";

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** "miércoles, 4 de noviembre", in the store's own day. */
export function storeDate(nowMs: number): string {
  const local = new Date(nowMs + STORE_OFFSET_MS);
  return `${WEEKDAYS[local.getUTCDay()]}, ${local.getUTCDate()} de ${MONTHS[local.getUTCMonth()]}`;
}

/** "Buenos días, Johan." by the store's clock; without a name, the greeting alone. */
export function greeting(nowMs: number, displayName: string | null): string {
  const hour = new Date(nowMs + STORE_OFFSET_MS).getUTCHours();
  const hello = hour < 12 ? "Buenos días" : hour < 18 ? "Buenas tardes" : "Buenas noches";
  const first = displayName?.trim().split(/\s+/u)[0] ?? "";
  return first === "" ? `${hello}.` : `${hello}, ${first}.`;
}

const storeDay = (ms: number) => Math.floor((ms + STORE_OFFSET_MS) / DAY_MS);

export function inicioScreen(app: Hono<ConsoleEnv>) {
  app.get("/inicio", async (c) => {
    const member = c.get("member");
    const context = memberContext(c);
    const engine = c.get("runtime").engine;
    const isOwner = member.role === "owner";
    const history = c.get("runtime").demoHistory;
    const [cards, open, numbers, loading] = await Promise.all([
      engine === null ? Promise.resolve(null) : engine.preparationList(context),
      isOwner ? readPendientes(c) : Promise.resolve(null),
      c.get("runtime").deps.tenancy.displayNumbersOf({ businessId: member.businessId }),
      history === null || !isDemoBusiness(member.businessId) ? Promise.resolve(false) : history.loading(member.businessId).catch(() => false),
    ]);
    c.header("Cache-Control", "no-store");
    return c.html(
      shell(c, {
        title: "Inicio",
        heading: greeting(context.nowMs, member.displayName),
        kicker: storeDate(context.nowMs),
        subtitle: "Esto es lo que necesita tu tienda hoy.",
        path: INICIO_PATH,
        ...(loading ? { notice: HISTORY_LOADING, refreshSeconds: HISTORY_REFRESH_S } : {}),
        style: STYLE + TRY_STYLE,
        body: html`<p class="lead-action"><a class="button gold" href="/console/anotar">Anotar algo</a></p>
${tryCard(numbers)}<section class="stats" aria-label="Hoy">${stats(cards, isOwner ? open : null)}</section>
${cards === null ? html`<p class="empty">La lista de pedidos no está lista todavía.</p>` : todayList(cards, context.nowMs, loading)}`,
      }),
    );
  });
}

function stats(cards: readonly PreparationCard[] | null, open: number | null) {
  const toPack = cards?.filter((card) => PACKING.has(card.order.state)).length ?? null;
  const ready = cards?.filter((card) => card.order.state === "listo").length ?? null;
  return html`${toPack === null ? "" : stat("Por atender", toPack, "Pedidos por preparar", PEDIDOS_PATH, "dark")}${
    ready === null ? "" : stat("Para entregar", ready, "Ya están listos", PEDIDOS_PATH, "")
  }${open === null ? "" : stat("Por resolver", open, "Lo que solo vos decidís", PENDIENTES_PATH, "")}`;
}

function stat(label: string, value: number, note: string, href: string, tone: string) {
  return html`<a class="stat${tone === "" ? "" : ` ${tone}`}" href="${href}"><span class="label">${label}</span><strong>${String(value)}</strong><small>${note}</small></a>`;
}

/** The orders on the preparation list that were confirmed today, oldest first, as Pedidos lists them. */
function todayList(cards: readonly PreparationCard[], nowMs: number, loading: boolean) {
  const today = cards.filter((card) => storeDay(card.confirmedAtMs) === storeDay(nowMs));
  return html`<section class="card today"><div class="card-head"><h2>Los pedidos de hoy</h2><a class="link" href="${PEDIDOS_PATH}">Ver todos →</a></div>
${today.length === 0 ? html`<p class="empty">${loading ? HISTORY_ARRIVING : "Hoy todavía no hay pedidos."}</p>` : html`<ul>${today.map((card) => todayRow(card, nowMs))}</ul>`}</section>`;
}

function todayRow(card: PreparationCard, nowMs: number) {
  const { order } = card;
  const chip = chipFor(card, nowMs);
  return html`<li><a class="order-row" href="${orderPath(order.orderId)}"><span class="order-no">${order.code === undefined ? "—" : `#${order.code}`}</span>
<span class="order-main"><strong>${card.customerName ?? "Cliente sin nombre"}</strong><small>${fulfillmentLine(order)}</small></span>
<span class="order-end"><span class="${chip.tone === "" ? "chip" : `chip ${chip.tone}`}">${chip.label}</span><span class="amount">${
    order.total === null ? "falta precio" : formatLempiras(order.total)
  }</span></span></a></li>`;
}

const STYLE = `
.lead-action{margin:4px 20px 18px}.lead-action .button{width:100%;min-height:54px;font-size:17px}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 16px 20px}
.stat{display:flex;flex-direction:column;min-height:132px;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);text-decoration:none;box-shadow:var(--shadow)}
.stat .label{font-size:15px;color:var(--mute)}
.stat strong{display:block;margin:6px 0 2px;font-size:40px;font-weight:600;line-height:1.1;letter-spacing:-1px}
.stat small{margin-top:auto;font-size:13px;color:var(--mute)}
.stat:nth-child(3):last-child{grid-column:1/-1;min-height:0}
.stat.dark{background:var(--forest);border-color:var(--forest);color:#fff}
.stat.dark .label,.stat.dark small{color:#ced8c6}
.stat:hover{border-color:var(--btn-line)}
.today{padding:0;overflow:hidden}
.card-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:18px 18px 16px;border-bottom:1px solid var(--line)}
.card-head h2{margin:0;font-size:19px}
.link{display:inline-flex;align-items:center;min-height:48px;color:var(--orange);font-size:15px;font-weight:700;text-decoration:none}
.order-row{display:flex;align-items:center;gap:12px;min-height:76px;padding:14px 18px;border-bottom:1px solid var(--line);color:inherit;text-decoration:none}
.today li:last-child .order-row{border-bottom:0}
.order-row:hover{background:#f6f6ed}
.order-no{flex:none;min-width:48px;padding:9px 6px;border:1px solid var(--line);border-radius:8px;color:var(--mute);font-size:13px;text-align:center}
.order-main{flex:1;min-width:0}
.order-main strong{display:block;font-size:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.order-main small{display:block;margin-top:2px;font-size:14px;color:var(--mute)}
.order-end{flex:none;display:grid;gap:6px;justify-items:end;font-size:15px;font-weight:600}
.amount{font-variant-numeric:tabular-nums}
@media (min-width:1024px){
.lead-action{position:absolute;top:84px;right:44px;margin:0}.lead-action .button{width:auto;padding:0 24px}
main{position:relative}
.stats{grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:8px 0 26px}
.stat:nth-child(3):last-child{grid-column:auto;min-height:132px}
}
`;
