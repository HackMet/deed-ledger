/**
 * The Deed (K20): each order's facts as a graph, and the feed of every verification the engine made.
 * Read-only, for any member of the store; the ledger only, scoped to the store (another store's order
 * is a 404). The graph is server-rendered inline SVG, with no script: a fact's panel opens with `:target`.
 * The feed refreshes every few seconds; the order page does not, so an open panel stays open. `?t=<ms>` replays
 * the order as it stood at that time. En vivo puts both on one refreshing screen: the graph of the order with the
 * newest activity (or the one picked with `?pedido=`) above the newest checks.
 */
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import {
  type DeedFact,
  type DeedGraph,
  type DeedNode,
  type DeedRefusal,
  type DeedStatus,
  blockingPath,
  deedGraph,
  visibleAt,
} from "../../../domain/deed-graph";
import { type FactForView, nodeViews } from "../../../domain/deed-node-view";
import { D1DeedReads, type DeedCheckView, type RecentOrder } from "../../../infrastructure/d1/deed-checks";
import { D1OrderLookup } from "../../../infrastructure/d1/order-lookup";
import { D1OrderTrail, type TrailEntry } from "../../../infrastructure/d1/order-trail";
import type { ConsoleEnv } from "./auth";
import { EVIDENCE_LABELS, KIND_LABELS, formatTime } from "./pedidos";
import { LIVE_STYLE, liveGraph } from "./deed-live-view";
import { csrfField, shell, simplePage } from "./layout";

const VERIFICATIONS = "/console/deed/verificaciones";
const SEARCH = "/console/deed/buscar";
export const LIVE_PATH = "/console/deed/en-vivo";
const LIVE_ORDERS = 6;
const LIVE_FEED = 30;
const REFRESH_SECONDS = 3;

const SHORT_KIND: Record<TrailEntry["kind"], string> = {
  order_version: "Versión",
  order_confirm: "Confirmado",
  order_cancel: "Cancelado",
  order_status: "Estado",
  change_request: "Cambio pedido",
  change_review: "Cambio revisado",
};

const STATUS_WORDS: Record<DeedStatus, string> = { live: "Vivo", closed: "Cerrado", blocked: "Bloqueado", pending: "Pendiente" };
const CLOSURE_LABELS = { cancelled: "cancelado", superseded: "reemplazado" } as const;
const REASON_LABELS: Record<string, string> = {
  duplicate: "ya se hizo antes",
  stale_version: "versión vieja",
  not_allowed: "no te toca",
  not_found: "no existe",
  not_backed: "no está respaldado por los registros",
};
const CLAIM_LABELS: Record<string, string> = {
  order_state: "el estado del pedido",
  order_total: "el total del pedido",
  unit_price: "un precio",
  availability: "la disponibilidad",
  payment_confirmed: "un pago",
  balance: "un saldo",
  store_hours: "el horario",
  other: "otro dato",
};
const STAFF_LABELS: Record<string, string> = {
  start_preparing: "empezar a preparar",
  mark_line: "marcar un producto",
  mark_ready: "marcar listo",
  dispatch: "despachar",
  mark_delivered: "marcar entregado",
};

/** Layout in pixels: a node is a circle with its words beside it, a layer is a row, a column is a slot in it. */
const NODE_W = 180;
const NODE_H = 44;
const RADIUS = 18;
const GAP_X = 200;
const GAP_Y = 84;
const PAD = 24;

const GLYPHS: Record<DeedStatus, string> = { live: "✓", closed: "✕", blocked: "–", pending: "…" };

const toDeedFact = (entry: TrailEntry): DeedFact => ({
  id: entry.factId,
  kind: entry.kind,
  recordedAtMs: entry.recordedAtMs,
  dependsOn: entry.dependsOn,
  closure: entry.closedBy === null ? null : { closedByFactId: entry.closedBy.factId, reason: entry.closedBy.reason, atMs: entry.closedBy.atMs },
});

/** The replay slider is hidden until it is fixed; `?t=` still answers, a link can still carry it. */
const REPLAY_SLIDER = false;

/** The replay's time, from `?t=`: a whole number of milliseconds, or null for the live order. */
const replayTime = (raw: string | undefined): number | null => (raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : null);

export function deedScreen(app: Hono<ConsoleEnv>) {
  // Before `/deed/:orderId`, so the feed's and the search's names are never read as an order id.
  // A POST, so what is typed never sits in a URL or a log: a WhatsApp ID embeds the phone number. The GET is only the form.
  app.get("/deed/buscar", async (c) => searchPage(c, false));
  app.post("/deed/buscar", async (c) => {
    const typed = (await c.req.parseBody())["codigo"];
    const found = typeof typed === "string" ? await new D1OrderLookup(c.env.DB).find({ businessId: c.get("member").businessId }, typed) : null;
    if (found !== null) return c.redirect(`/console/deed/${encodeURIComponent(found)}/libro`, 303);
    return searchPage(c, true);
  });

  app.get("/deed/verificaciones", async (c) => {
    const tenant = { businessId: c.get("member").businessId };
    const reads = new D1DeedReads(c.env.DB);
    const [counters, rows] = await Promise.all([reads.counters(tenant), reads.feed(tenant, 100)]);
    return c.html(
      await shell(c, {
        title: "Cómo se armó",
        subtitle: "Verificaciones",
        back: "/console/preparacion",
        path: VERIFICATIONS,
        tab: LIVE_PATH,
        refreshSeconds: REFRESH_SECONDS,
        style: STYLE,
        body: html`<p class="meta"><a href="${SEARCH}">Buscar pedido por código</a></p>
<p class="counters" id="contadores">Intentos rechazados ${counters.attempts}</p>
${counters.refusedByReason.size === 0 ? "" : html`<ul class="reasons">${[...counters.refusedByReason].map(([reason, n]) => html`<li>${reasonLabel(reason, null)}: ${n}</li>`)}</ul>`}
<p class="counters" id="afirmaciones">Afirmaciones verificadas ${counters.claims}, pasaron ${counters.claimsPassed}</p>
${rows.length === 0 ? html`<p class="empty">Todavía no hay verificaciones.</p>` : html`<ol class="feed">${rows.map(feedRow)}</ol>`}`,
      }),
    );
  });

  app.get("/deed/en-vivo", async (c) => {
    const tenant = { businessId: c.get("member").businessId };
    const reads = new D1DeedReads(c.env.DB);
    const picked = c.req.query("pedido");
    const [counters, rows, recent] = await Promise.all([reads.counters(tenant), reads.feed(tenant, LIVE_FEED), reads.recentOrders(tenant, LIVE_ORDERS)]);
    const orderId = picked ?? recent[0]?.orderId ?? null;
    const trail = orderId === null ? null : await new D1OrderTrail(c.env.DB).trail(tenant, orderId);
    // Another store's order, or one that doesn't exist: the same answer as its own page.
    if (picked !== undefined && trail === null) return c.html(simplePage("Deed en vivo", html`<p class="empty">Ese pedido no está en la lista.</p>`), 404);
    const facts = trail === null ? [] : trail.facts.map(toDeedFact);
    const forView: FactForView[] = trail === null ? [] : trail.facts.map((entry) => ({
      factId: entry.factId,
      kind: entry.kind,
      recordedAtMs: entry.recordedAtMs,
      agentId: entry.agentId,
      evidence: entry.evidence,
      detail: entry.detail,
      closedByReason: entry.closedBy?.reason ?? null,
    }));
    const refusals = orderId === null || trail === null ? [] : await reads.refusalsOf(tenant, orderId);
    const graph = deedGraph(facts, refusals);
    const views = nodeViews(forView, new Map(graph.nodes.map((node) => [node.id, node.status] as const)));
    const orderPage = orderId === null ? "" : `/console/deed/${encodeURIComponent(orderId)}`;
    return c.html(
      await shell(c, {
        title: "Deed en vivo",
        subtitle: `Se actualiza cada ${REFRESH_SECONDS} segundos`,
        path: picked === undefined ? LIVE_PATH : `${LIVE_PATH}?pedido=${encodeURIComponent(picked)}`,
        tab: LIVE_PATH,
        refreshSeconds: REFRESH_SECONDS,
        style: STYLE,
        body: html`<section class="hero"><p class="live-badge"><span class="dot"></span>LIVE</p>
<p class="summary">${counters.claims} afirmaciones · ${counters.claimsPassed} confirmadas · ${counters.claims - counters.claimsPassed} sin respaldo · ${counters.attempts} intentos rechazados</p></section>
<p class="meta"><a href="${VERIFICATIONS}">Todas las verificaciones</a> · <a href="${SEARCH}">Buscar pedido por código</a></p>
${recent.length === 0 ? "" : html`<nav class="picks" aria-label="Pedido que se muestra"><a href="${LIVE_PATH}"${picked === undefined ? html` aria-current="true"` : ""}>El más reciente</a>${recent.map((order) => pickLink(order, picked))}</nav>`}
<div class="vivo"><section class="vivo-grafo">${trail === null
  ? html`<p class="empty">Todavía no hay pedidos. Cuando entre uno, su grafo aparece acá.</p>`
  : html`<h2 class="section">Pedido ${trail.code ?? "sin confirmar"}</h2>
${liveGraph(views, graph, orderPage)}
<p class="meta"><a href="${orderPage}">Ver el detalle</a> · <a href="${orderPage}/libro">Ver libro</a></p>`}</section>
<section class="vivo-feed"><h2 class="section">Verificaciones</h2>
${rows.length === 0 ? html`<p class="empty">Todavía no hay verificaciones.</p>` : html`<ol class="feed">${rows.map(liveFeedRow)}</ol>`}</section></div>
${KEEP_SCROLL}`,
      }),
    );
  });

  app.get("/deed/:orderId", async (c) => {
    const orderId = c.req.param("orderId");
    const tenant = { businessId: c.get("member").businessId };
    const trail = await new D1OrderTrail(c.env.DB).trail(tenant, orderId);
    if (trail === null) return c.html(simplePage("Cómo se armó", html`<p class="empty">Ese pedido no está en la lista.</p>`), 404);
    const at = replayTime(c.req.query("t"));
    const everything = trail.facts.map(toDeedFact);
    const refusals = await new D1DeedReads(c.env.DB).refusalsOf(tenant, orderId);
    // The replay shows what was recorded by its time: facts, closures and refusals alike.
    const facts = at === null ? everything : visibleAt(everything, at);
    const shownRefusals: DeedRefusal[] = at === null ? refusals : refusals.filter((refusal) => refusal.atMs <= at);
    const graph = deedGraph(facts, shownRefusals);
    const focus = c.req.query("foco");
    const onPath = new Set(focus === undefined ? [] : (blockingPath(graph, focus, facts)?.path ?? []));
    const shownEntries = trail.facts.filter((entry) => facts.some((fact) => fact.id === entry.factId));
    const times = [...trail.facts.map((entry) => entry.recordedAtMs), ...refusals.map((refusal) => refusal.atMs)];
    return c.html(
      await shell(c, {
        title: `Pedido ${trail.code ?? "—"}`,
        subtitle: at === null ? "Cómo se armó" : `Cómo se armó · como estaba a las ${formatTime(at)}`,
        back: `/console/pedidos/${encodeURIComponent(orderId)}`,
        path: `/console/deed/${encodeURIComponent(orderId)}`,
        tab: LIVE_PATH,
        // No refresh here: a reload drops the fact panel that is open (`#f-…`) and the `?foco=` path.
        style: STYLE,
        body: html`${REPLAY_SLIDER ? replayForm(times, at) : ""}
<p class="meta"><a href="/console/deed/${encodeURIComponent(orderId)}/libro">Ver libro</a> · <a href="/console/deed/verificaciones">Todas las verificaciones</a></p>
${graphSvg(graph, onPath)}
<p class="hint">Tocá un hecho para ver su detalle.</p>
${shownEntries.map((entry) => panelOf(entry, graph, facts, `/console/deed/${encodeURIComponent(orderId)}/libro`))}`,
      }),
    );
  });
}

/** One order to follow on En vivo. Unconfirmed orders have no code yet, so they say so. */
function pickLink(order: RecentOrder, picked: string | undefined) {
  return html`<a href="${LIVE_PATH}?pedido=${encodeURIComponent(order.orderId)}"${picked === order.orderId ? html` aria-current="true"` : ""}>${order.code ?? "Sin confirmar"}</a>`;
}

/** The refresh reloads the page: this puts the reader back where they were, or the feed could never be read. */
const KEEP_SCROLL = html`<script>try{const k="deed-en-vivo";const y=sessionStorage.getItem(k);if(y!==null)scrollTo(0,Number(y));addEventListener("pagehide",()=>sessionStorage.setItem(k,String(scrollY)))}catch{}</script>`;


/** The search form, and a 404 when a search found nothing. What was typed is never shown back. No refresh: a reload would empty the field while someone types. */
async function searchPage(c: Context<ConsoleEnv>, notFound: boolean) {
  return c.html(
    await shell(c, {
      title: "Deed",
      subtitle: "Buscar",
      back: VERIFICATIONS,
      path: SEARCH,
      tab: LIVE_PATH,
      style: STYLE,
      body: html`${notFound ? html`<p class="empty">No encontré un pedido con ese código en esta tienda.</p>` : ""}
<form method="post" action="${SEARCH}" class="buscar">${csrfField(c.get("csrf"))}
<label>Buscar pedido por código <input type="text" name="codigo" autocomplete="off" autocapitalize="characters" required></label>
<button type="submit">Buscar</button>
</form>`,
    }),
    notFound ? 404 : 200,
  );
}

/** The replay: a range over the order's times, sent as a GET form to `?t=`. Empty when nothing is recorded. */
function replayForm(times: readonly number[], at: number | null) {
  if (times.length === 0) return "";
  const first = Math.min(...times);
  const last = Math.max(...times);
  return html`<form method="get" class="replay">
<label>Ver como estaba <input type="range" name="t" min="${first}" max="${last}" step="1000" value="${at ?? last}"></label>
<button type="submit">Ver</button>${at === null ? "" : html` · <a href="?">Ahora</a>`}
</form>`;
}

/** The graph as inline SVG, at its own size: circles coloured by status, arrows from each fact to what rests on it, every node a link to its panel; refusals below. `panels` is the page holding the panels, when it isn't this one. */
function graphSvg(graph: DeedGraph, onPath: ReadonlySet<string>, panels = "") {
  if (graph.nodes.length === 0 && graph.refusals.length === 0) return html`<p class="empty">Este pedido no tiene hechos todavía.</p>`;
  const columns = Math.max(0, ...graph.nodes.map((node) => node.column + 1), ...graph.refusals.map((refusal) => refusal.column + 1));
  const rows = graph.layers + (graph.refusals.length > 0 ? 1 : 0);
  const width = PAD * 2 + Math.max(0, columns - 1) * GAP_X + NODE_W;
  const height = PAD * 2 + Math.max(0, rows - 1) * GAP_Y + NODE_H;
  const at = new Map<string, { x: number; y: number }>();
  for (const node of graph.nodes) at.set(node.id, { x: PAD + node.column * GAP_X, y: PAD + node.layer * GAP_Y });
  for (const refusal of graph.refusals) at.set(refusal.id, { x: PAD + refusal.column * GAP_X, y: PAD + graph.layers * GAP_Y });
  const centre = (id: string) => {
    const spot = at.get(id)!;
    return { x: spot.x + RADIUS, y: spot.y + NODE_H / 2 };
  };
  const drawn = graph.edges.filter((edge) => at.has(edge.from) && at.has(edge.to));
  const newest = panels === "" ? null : graph.nodes.reduce<DeedNode | null>((latest, node) => (latest === null || node.recordedAtMs >= latest.recordedAtMs ? node : latest), null);
  return html`<div class="graph-box"><svg id="grafo" class="graph" width="${width}" height="${height}" style="max-width:${Math.round(width * 1.35)}px" viewBox="0 0 ${width} ${height}" role="img" aria-label="Hechos del pedido y cómo se apoyan">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#9dbdab"/></marker><marker id="arrow-closes" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#ff6b6b"/></marker></defs>
${drawn.map((edge) => {
  const [from, to] = betweenCircles(centre(edge.from), centre(edge.to));
  // A closure bows to one side: a change that supersedes the one it rests on shares both circles with a dependency line.
  if (edge.type === "closes") return html`<path class="closes" d="${arcBetween(from, to)}"/>`;
  const path = edge.type === "depends" && onPath.has(edge.from) && onPath.has(edge.to) ? " path" : "";
  return html`<line class="${edge.type}${path}" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/>`;
})}
${graph.nodes.map((node) => nodeSvg(node, at.get(node.id)!, onPath.has(node.id), panels, node.id === newest?.id))}
${graph.refusals.map((refusal) => refusalSvg(refusal, at.get(refusal.id)!, panels))}
</svg></div>`;
}

/** The two ends of an edge, moved out to the circles' rims, so an arrowhead lands beside the circle and not under it. */
function betweenCircles(from: { x: number; y: number }, to: { x: number; y: number }): [{ x: number; y: number }, { x: number; y: number }] {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  const gap = RADIUS + 3;
  return [
    { x: Math.round(from.x + ux * gap), y: Math.round(from.y + uy * gap) },
    { x: Math.round(to.x - ux * gap), y: Math.round(to.y - uy * gap) },
  ];
}

/** A quadratic curve from one point to another, its control point 40px off the middle of the chord. */
function arcBetween(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const cx = Math.round((from.x + to.x) / 2 - ((to.y - from.y) / length) * 40);
  const cy = Math.round((from.y + to.y) / 2 + ((to.x - from.x) / length) * 40);
  return `M${from.x} ${from.y} Q${cx} ${cy} ${to.x} ${to.y}`;
}

function nodeSvg(node: DeedNode, spot: { x: number; y: number }, onPath: boolean, panels: string, newest: boolean) {
  const cls = `node ${node.status}${onPath ? " path" : ""}`;
  const cx = spot.x + RADIUS;
  const cy = spot.y + NODE_H / 2;
  const textX = spot.x + RADIUS * 2 + 10;
  const shape =
    node.kind === "order_cancel"
      ? html`<polygon class="${cls}" points="${cx - RADIUS},${cy} ${cx - RADIUS / 2},${cy - RADIUS} ${cx + RADIUS / 2},${cy - RADIUS} ${cx + RADIUS},${cy} ${cx + RADIUS / 2},${cy + RADIUS} ${cx - RADIUS / 2},${cy + RADIUS}"/>`
      : html`<circle class="${cls}" cx="${cx}" cy="${cy}" r="${RADIUS}"/>`;
  return html`<a href="${panels}#f-${node.id}">${newest ? html`<circle class="halo" cx="${cx}" cy="${cy}" r="${RADIUS + 5}"/>` : ""}${shape}<text class="glyph" x="${cx}" y="${cy + 5}" text-anchor="middle">${GLYPHS[node.status]}</text><text class="label" x="${textX}" y="${cy - 3}">${SHORT_KIND[node.kind as TrailEntry["kind"]] ?? node.kind}</text><text class="status" x="${textX}" y="${cy + 13}">${STATUS_WORDS[node.status]} · ${formatTime(node.recordedAtMs)}</text></a>`;
}

/** A refused check: a dashed circle, linked to the fact that decided it when there is one. */
function refusalSvg(refusal: DeedRefusal, spot: { x: number; y: number }, panels: string) {
  const cx = spot.x + RADIUS;
  const cy = spot.y + NODE_H / 2;
  const textX = spot.x + RADIUS * 2 + 10;
  const mark = html`<circle class="refusal" cx="${cx}" cy="${cy}" r="${RADIUS}"/><text class="glyph refused" x="${cx}" y="${cy + 5}" text-anchor="middle">✕</text><text class="label" x="${textX}" y="${cy - 3}">Intento rechazado</text><text class="status" x="${textX}" y="${cy + 13}">${reasonLabel(refusal.reason, refusal.decidingFactId)}</text>`;
  return refusal.decidingFactId === null ? html`<g>${mark}</g>` : html`<a href="${panels}#f-${refusal.decidingFactId}">${mark}</a>`;
}

/** The panel of one fact, shown by `:target`: what it is, who and when, what it rests on, and why it is dead. */
function panelOf(entry: TrailEntry, graph: DeedGraph, facts: readonly DeedFact[], libro = "") {
  const status = graph.nodes.find((node) => node.id === entry.factId)?.status ?? "live";
  const fact = facts.find((candidate) => candidate.id === entry.factId);
  const closure = fact?.closure ?? null;
  const labelOf = (id: string) => KIND_LABELS[(facts.find((candidate) => candidate.id === id)?.kind ?? "") as TrailEntry["kind"]] ?? "hecho";
  const block = status === "blocked" ? blockingPath(graph, entry.factId, facts) : null;
  return html`<section id="f-${entry.factId}" class="panel ${status}">
<h2>${KIND_LABELS[entry.kind]} · ${STATUS_WORDS[status]}</h2>
<p class="meta">${entry.actor} · ${formatTime(entry.recordedAtMs)}${entry.courier === null ? "" : ` · ${entry.courier.name ?? "repartidor"}`}</p>
<p class="meta">Operación: <code>${entry.operationKey}</code></p>
${entry.evidence.length === 0 ? "" : html`<p>${entry.evidence.filter((e) => e.kind in EVIDENCE_LABELS).map((e) => html`<span class="chip">${EVIDENCE_LABELS[e.kind]} · ${e.refId.slice(0, 8)}</span>`)}</p>`}
${closure === null ? "" : html`<p class="closed">Cerrado por <a href="#f-${closure.closedByFactId}">${labelOf(closure.closedByFactId)}</a> (${CLOSURE_LABELS[closure.reason]})</p>`}
${block === null ? "" : html`<p class="blocked">Bloqueado por <a href="#f-${block.closedId}">${labelOf(block.closedId)}</a></p>
<p><a href="?foco=${entry.factId}#f-${entry.factId}">Ver el camino hasta el bloqueo</a></p>`}
<p><a href="#grafo">Volver al grafo</a>${libro === "" ? "" : html` · <a href="${libro}">Ver en el libro</a>`}</p>
</section>`;
}

/** One line of the feed: ✓ or ✗, what was checked or attempted, why it was refused, and the order's graph. */
function feedRow(row: DeedCheckView) {
  const passed = row.result === "pass";
  const what = row.source === "verify_claims" ? `Verificó ${CLAIM_LABELS[row.claimKind ?? "other"]}` : `Intentó ${actionLabel(row.operationKey)}`;
  const why = row.source === "verify_claims" ? REASON_LABELS.not_backed : reasonLabel(row.reasonCode ?? "", row.decidingFactId);
  return html`<li class="${passed ? "pass" : "fail"}"><span class="mark">${passed ? "✓" : "✗"}</span><span class="what">${what}</span>${passed ? "" : html`<span class="why">${why}</span>`}<time>${formatTime(row.atMs)}</time>${row.orderId === null ? "" : html`<a href="/console/deed/${encodeURIComponent(row.orderId)}">pedido</a>`}</li>`;
}

/** The feed on En vivo: as `feedRow`, but a failed claim check is amber (not a refused attempt) and points to the order's graph. */
function liveFeedRow(row: DeedCheckView) {
  const failedClaim = row.source === "verify_claims" && row.result === "fail";
  if (!failedClaim) return feedRow(row);
  const link = row.orderId === null ? "" : html`<a href="${LIVE_PATH}?pedido=${encodeURIComponent(row.orderId)}#grafo">Ver en el grafo</a>`;
  return html`<li class="fail claim"><span class="mark">✗</span><span class="what">Verificó ${CLAIM_LABELS[row.claimKind ?? "other"]}</span><span class="why">${REASON_LABELS.not_backed}</span><time>${formatTime(row.atMs)}</time>${link}</li>`;
}

/** The reason in Spanish; a refused cancelled order names the cancel (`ancestro cancelado`). */
function reasonLabel(code: string, decidingFactId: string | null): string {
  if (code === "invalid_state") return decidingFactId === null ? "el estado no lo permite" : "ancestro cancelado";
  return REASON_LABELS[code] ?? "rechazado";
}

/** What an operation key names: the action, read from the key's shape (`staff:<order>:<version>:<action>`). */
function actionLabel(key: string | null): string {
  if (key === null) return "una acción";
  const parts = key.split(":");
  if (parts[0] === "staff") return STAFF_LABELS[parts[3] ?? ""] ?? "una acción de la tienda";
  switch (parts[0]) {
    case "confirm":
      return "confirmar el pedido";
    case "cancel":
      return "cancelar el pedido";
    case "remove":
      return "quitar un producto";
    case "burst":
      return "un mensaje del cliente";
    default:
      return "una acción";
  }
}

const STYLE = `
main>p.meta{margin:14px 18px 0}
.counters{margin:12px 14px;padding:12px 16px;border-radius:14px;background:var(--soft);font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
.reasons{margin:0 14px 8px;padding-left:22px;font-size:15px;color:var(--mute)}
.feed{list-style:none;margin:12px 14px;padding:0;border:1px solid var(--line);border-radius:18px;background:var(--card);overflow:hidden}
.feed li{display:grid;grid-template-columns:24px 1fr auto;gap:2px 8px;padding:12px 14px;border-top:1px solid var(--line);font-size:15px}
.feed li:first-child{border-top:0}
.feed .mark{font-weight:700}.feed .pass .mark{color:#2e7d32}.feed .fail .mark{color:#c62828}
.feed .why{grid-column:2;font-size:13px;color:var(--mute)}
.feed .what{grid-column:2}
.feed time{grid-column:3;grid-row:2;font-size:12px;color:var(--mute);text-align:right;white-space:nowrap}
.feed a{grid-column:3;grid-row:1;font-size:13px;text-align:right}
.replay{margin:12px 14px;font-size:15px}
.replay input{width:100%;margin:6px 0}
.graph-box{margin:12px 14px;padding:14px 8px;border-radius:20px;background-color:#0f231b;background-image:radial-gradient(#2a4438 1px,transparent 1px);background-size:20px 20px;box-shadow:0 10px 30px #0f231b40;overflow-x:auto}
.graph{display:block;margin:0 auto;width:100%;height:auto}
.graph a{cursor:pointer}
.graph line{stroke:#6f9180;stroke-width:2;marker-end:url(#arrow)}
.graph path.closes{fill:none;stroke:#ff6b6b;stroke-width:2;stroke-dasharray:3 5;marker-end:url(#arrow-closes)}
.graph line.refused{stroke-dasharray:3 4;marker-end:none}
.graph line.depends.path{stroke:#67b7ff;stroke-width:3}
.graph .node{stroke:#0f231b;stroke-width:2}
.graph .node.live{fill:#3ddc84;filter:drop-shadow(0 0 7px #3ddc8499)}
.graph .node.closed{fill:#ff6b6b;filter:drop-shadow(0 0 7px #ff6b6b99)}
.graph .node.blocked{fill:#7d8a83}
.graph .node.pending{fill:#ffc145;filter:drop-shadow(0 0 7px #ffc14599)}
.graph .node.path{stroke:#67b7ff;stroke-width:3}
.graph .halo{fill:none;stroke:#3ddc84;stroke-width:2;animation:halo 2s ease-out infinite}
@keyframes halo{from{opacity:.8}to{opacity:0}}
@media (prefers-reduced-motion:reduce){.graph .halo{animation:none;opacity:.5}}
.graph .refusal{fill:#0f231b;stroke:#ff6b6b;stroke-width:1.5;stroke-dasharray:4 3}
.graph .glyph{font-size:15px;font-weight:800;fill:#0b1a14}.graph .glyph.refused{fill:#ff6b6b}
.graph .label{font-size:14px;font-weight:700;fill:#f2f7f3}
.graph .status{font-size:11.5px;fill:#a9bdb1}
.hero{margin:12px 14px;padding:14px 16px 16px;border-radius:20px;background:#0f231b;color:#f2f7f3}
.live-badge{display:inline-flex;align-items:center;gap:7px;margin:0 0 10px;font-size:12px;font-weight:800;letter-spacing:.16em;color:#ff8585}
.live-badge .dot{width:9px;height:9px;border-radius:50%;background:#ff6b6b;animation:blink 1.4s ease-in-out infinite}
@keyframes blink{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.live-badge .dot{animation:none}}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.tile{padding:10px 12px;border-radius:14px;background:#1a3329}
.tile strong{display:block;font-size:30px;line-height:1.1;font-variant-numeric:tabular-nums}
.tile span{display:block;margin-top:2px;font-size:13px;line-height:1.25;color:#b9cabf}
.tile.good strong{color:#3ddc84}.tile.bad strong{color:#ff6b6b}
.hero .summary{margin:0;font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
.feed .fail.claim{box-shadow:inset 3px 0 0 #F5A524;background:#fffaf0}
.feed .pass{box-shadow:inset 3px 0 0 #2e7d32}.feed .fail{box-shadow:inset 3px 0 0 #c62828;background:#fff5f5}
${LIVE_STYLE}
.hint{font-size:15px;color:var(--mute);margin:0 14px}
.vivo-feed .counters{margin-top:8px;margin-bottom:8px}
.picks{display:flex;flex-wrap:wrap;gap:8px;margin:12px 14px}
.picks a{min-height:44px;display:inline-flex;align-items:center;padding:0 14px;border:1px solid var(--line);border-radius:22px;background:var(--card);color:inherit;text-decoration:none;font-size:15px}
.picks a[aria-current]{background:var(--forest);border-color:var(--forest);color:#fff;font-weight:700}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 14px;padding:0;font-size:13px;color:var(--mute)}
.legend li::before{content:"";display:inline-block;width:12px;height:12px;margin-right:5px;border:1.5px solid;border-radius:3px;vertical-align:-1px}
.legend .live::before{background:#e8f5e9;border-color:#2e7d32}.legend .closed::before{background:#ffebee;border-color:#c62828}
.legend .blocked::before{background:#eee;border-color:#757575;border-style:dashed}.legend .pending::before{background:#fff8e1;border-color:#f9a825}
.panel{display:none;margin:12px 14px;padding:16px;border:1px solid var(--line);border-radius:18px;background:var(--card)}
.panel:target{display:block}
.panel h2{font-size:17px;margin:0 0 6px}
.panel .closed{color:#c62828}.panel .blocked{color:#616161}
.panel .chip{display:inline-block;margin:0 6px 6px 0;padding:2px 8px;border-radius:10px;background:#eee;font-size:13px}
.panel code{font-size:12px;word-break:break-all}
`;
