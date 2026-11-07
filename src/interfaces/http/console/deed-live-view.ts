/**
 * The En vivo graph (K20): one order's facts left to right, oldest to newest. Each fact is a circle that says
 * its state in a word; above it, who claimed it (only when the record names an agent); below it, who confirmed
 * it, or that nobody has yet. Lines between circles say what depends on what, and what replaces what. Pure
 * server-rendered SVG. Nothing on a node is red: red belongs to refused attempts in the feed.
 */
import { html } from "hono/html";
import type { DeedGraph } from "../../../domain/deed-graph";
import type { Confirmer, DeedNodeView, NodeState } from "../../../domain/deed-node-view";
import { formatTime } from "./pedidos";

const GAP = 230;
const PAD_X = 110;
const CY = 130;
const R = 30;
const HEIGHT = 250;
const TITLE_MAX = 30;

const STATE_WORDS: Record<NodeState, string> = { en_duda: "EN DUDA", hecho: "HECHO", cerrado: "CERRADO", bloqueado: "BLOQUEADO" };
const STATE_CLASS: Record<NodeState, string> = { en_duda: "lv-duda", hecho: "lv-hecho", cerrado: "lv-cerrado", bloqueado: "lv-bloqueado" };
const CONFIRMED: Record<Confirmer, string> = { tienda: "Lo confirmó: tienda", cliente: "Lo confirmó: cliente", whatsapp: "Lo confirmó: WhatsApp (entregado)" };

/** What backs a fact, in plain words: the ledger's evidence kinds stay in the code. */
const EVIDENCE_WORDS: Record<string, string> = {
  inbound_message: "mensaje del cliente",
  media_asset: "foto",
  member: "toque del personal",
  confirmation: "confirmación",
};

const short = (text: string) => (text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text);

export const LIVE_STYLE = `
.livegraph{display:block;max-width:none}
.livegraph text{font-family:system-ui,sans-serif}
.livegraph .lv-duda circle.body{fill:#F5A524;stroke:#F5A524;animation:lvpulse 1.8s ease-in-out infinite}
.livegraph .lv-hecho circle.body{fill:#22C55E;stroke:#22C55E}
.livegraph .lv-cerrado circle.body{fill:none;stroke:#22C55E;stroke-width:2.5}
.livegraph .lv-bloqueado circle.body{fill:none;stroke:#4B5563;stroke-width:2.5;stroke-dasharray:2 4;stroke-linecap:round}
@keyframes lvpulse{50%{opacity:.55}}
@media (prefers-reduced-motion:reduce){.livegraph .lv-duda circle.body{animation:none}}
.live-box{direction:rtl}.livegraph{direction:ltr}
@media (min-width:1024px){.livegraph{max-width:100%;height:auto;margin:0 auto}}
.livegraph .word{font-size:9px;font-weight:800;text-anchor:middle}
.livegraph .lv-duda .word,.livegraph .lv-hecho .word{fill:#0b1a14}
.livegraph .lv-cerrado .word{fill:#86efac}.livegraph .lv-bloqueado .word{fill:#9CA3AF}
.livegraph .lock{fill:none;stroke:#9CA3AF;stroke-width:1.6}.livegraph .lock-body{fill:#9CA3AF}
.livegraph .title{font-size:12px;font-weight:700;fill:#f2f7f3;text-anchor:middle}
.livegraph .who{font-size:11px;fill:#e5efe8;text-anchor:middle}
.livegraph .agent{font-size:9px;fill:#93c5fd;text-anchor:middle;font-family:ui-monospace,monospace}
.livegraph .agent-label{font-size:11px;fill:#60A5FA;text-anchor:middle;font-weight:600}
.livegraph .leg-up{stroke:#60A5FA;stroke-width:2}
.livegraph .leg-down{stroke:#fff;stroke-width:2}
.livegraph .leg-wait{stroke:#F5A524;stroke-width:2;stroke-dasharray:2 4;stroke-linecap:round}
.livegraph .wait{fill:#F5A524}
.livegraph .e-depends{stroke:#9dbdab;stroke-width:1.2}
.livegraph .e-closes{fill:none;stroke:#cbd5e1;stroke-width:1.5;stroke-dasharray:3 4}
.livegraph .e-label{font-size:10px;fill:#a9bdb1;text-anchor:middle}
.livegraph a:hover circle.body,.livegraph a:focus circle.body{stroke-width:4}
.live-legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 16px;margin:0 14px;padding:0;font-size:13px;color:var(--mute)}
.live-legend li::before{content:"";display:inline-block;width:14px;height:14px;margin-right:6px;border-radius:50%;border:2.5px solid;vertical-align:-3px;box-sizing:border-box}
.live-legend .lv-duda::before{background:#F5A524;border-color:#F5A524}
.live-legend .lv-hecho::before{background:#22C55E;border-color:#22C55E}
.live-legend .lv-cerrado::before{border-color:#22C55E}
.live-legend .lv-bloqueado::before{border-color:#4B5563;border-style:dotted}
`;

function node(view: DeedNodeView, x: number, panels: string) {
  const word = STATE_WORDS[view.state];
  const locked = view.state === "bloqueado";
  const tip = `${view.title} · ${view.evidenceKinds.length === 0 ? "sin respaldo" : view.evidenceKinds.map((kind) => EVIDENCE_WORDS[kind] ?? "otro respaldo").join(", ")} · ${formatTime(view.recordedAtMs)}`;
  const wordY = locked ? CY + 13 : CY + 3;
  const adjust = word.length > 7 ? html` textLength="50" lengthAdjust="spacingAndGlyphs"` : "";
  return html`<a href="${panels}#f-${view.factId}" class="${STATE_CLASS[view.state]}"><title>${tip}</title>
${view.agentId === null ? "" : html`<line class="leg-up" x1="${x}" y1="${CY - R}" x2="${x}" y2="${CY - R - 26}"/><text class="agent-label" x="${x}" y="${CY - R - 46}">Afirmó el agente</text><text class="agent" x="${x}" y="${CY - R - 33}">${view.agentId}</text>`}
${view.confirmedBy === null ? html`<line class="leg-wait" x1="${x}" y1="${CY + R}" x2="${x}" y2="${CY + R + 28}"/><text class="who wait" x="${x}" y="${CY + R + 43}">esperando confirmación</text>` : html`<line class="leg-down" x1="${x}" y1="${CY + R}" x2="${x}" y2="${CY + R + 28}"/><text class="who" x="${x}" y="${CY + R + 43}">${CONFIRMED[view.confirmedBy]}</text>`}
<circle class="body" cx="${x}" cy="${CY}" r="${R}"/>${locked ? html`<rect class="lock-body" x="${x - 5}" y="${CY - 8}" width="10" height="8" rx="1.5"/><path class="lock" d="M${x - 3} ${CY - 8}v-3a3 3 0 0 1 6 0v3"/>` : ""}<text class="word" x="${x}" y="${wordY}"${adjust}>${word}</text>
<text class="title" x="${x}" y="${CY + R + 66}">${short(view.title)}<title>${view.title}</title></text></a>`;
}

/** `panels`: the page holding the fact panels (the order's page), so each node opens its own. */
export function liveGraph(views: readonly DeedNodeView[], graph: DeedGraph, panels: string) {
  if (views.length === 0) return html`<p class="empty">Este pedido no tiene hechos todavía.</p>`;
  const ordered = [...views].sort((a, b) => a.recordedAtMs - b.recordedAtMs || a.factId.localeCompare(b.factId));
  const xOf = new Map(ordered.map((view, i) => [view.factId, PAD_X + i * GAP] as const));
  const width = PAD_X * 2 + (ordered.length - 1) * GAP;
  const edges = graph.edges.filter((edge) => edge.type !== "refused" && xOf.has(edge.from) && xOf.has(edge.to));
  return html`<div class="graph-box live-box"><svg id="grafo" class="livegraph" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="Hechos del pedido y cómo se apoyan">
<defs><marker id="lv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#9dbdab"/></marker></defs>
${edges.map((edge) => {
  const a = xOf.get(edge.from)!;
  const b = xOf.get(edge.to)!;
  const dir = b >= a ? 1 : -1;
  const x1 = a + dir * (R + 3);
  const x2 = b - dir * (R + 3);
  const mid = Math.round((a + b) / 2);
  if (edge.type === "closes") {
    return html`<path class="e-closes" d="M${x1} ${CY - 8} Q${mid} ${CY - 62} ${x2} ${CY - 8}"/><text class="e-label" x="${mid}" y="${CY - 36}">reemplaza a</text>`;
  }
  return html`<line class="e-depends" x1="${x1}" y1="${CY}" x2="${x2}" y2="${CY}" marker-start="url(#lv-arrow)"/><text class="e-label" x="${mid}" y="${CY + 16}">depende de</text>`;
})}
${ordered.map((view) => node(view, xOf.get(view.factId)!, panels))}
</svg></div>
<ul class="live-legend" aria-label="Estados">${(Object.keys(STATE_WORDS) as NodeState[]).map((state) => html`<li class="${STATE_CLASS[state]}">${STATE_WORDS[state]}</li>`)}</ul>`;
}
