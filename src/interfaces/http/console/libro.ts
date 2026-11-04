/**
 * The order's three-lane view (K20c): AGENTE dijo | LIBRO empareja | MUNDO registró. Read-only, for any member
 * of the store; another store's order is a 404. The drawing is server-side inline SVG in the reference's palette,
 * with no script: each row is a link to its detail below, opened with `:target`. The pairing is decided by
 * src/domain/deed-libro.ts; this file only draws it. Details carry IDs, codes and times, never message text.
 */
import type { Hono } from "hono";
import { html } from "hono/html";
import { type LibroCell, type LibroRow, PAIR_WORDS, type PairState, libroRows } from "../../../domain/deed-libro";
import { D1LibroReads } from "../../../infrastructure/d1/libro-reads";
import { D1OrderTrail } from "../../../infrastructure/d1/order-trail";
import type { ConsoleEnv } from "./auth";
import { shell, simplePage } from "./layout";
import { formatTime } from "./pedidos";

const VIEW_W = 360;
const COL_W = 108;
const COL_X = [6, 126, 246] as const;
const HEADER_H = 34;
const ROW_H = 58;
const MAX_CHARS = 16;
const MAX_LINES = 3;

const LANE_TITLES = ["AGENTE dijo", "LIBRO empareja", "MUNDO registró"] as const;

const STATE_COLOUR_CLASS: Record<PairState, string> = {
  emparejado: "s-emparejado",
  sin_pareja: "s-sin_pareja",
  en_duda: "s-en_duda",
  bloqueado: "s-bloqueado",
};

/** Greedy word wrap into at most three lines of sixteen characters; the last line ends with "…" when cut. */
function wrap(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (next.length <= MAX_CHARS || line === "") line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    lines[MAX_LINES - 1] = `${lines[MAX_LINES - 1]!.slice(0, MAX_CHARS - 1)}…`;
  }
  return lines;
}

/** The class a cell's box is drawn with: claims in the agent's blue, witnesses in teal, the book's own in ink. */
function boxClass(lane: number, cell: LibroCell, state: PairState | null): string {
  if (cell.kind === "gate") return "gate";
  if (lane === 0) return "c-claim";
  if (lane === 2) return "c-witness";
  return cell.kind === "balance" || cell.kind === "missing" ? (state === null ? "c-book" : STATE_COLOUR_CLASS[state]) : "c-book";
}

function cellSvg(cell: LibroCell, lane: number, state: PairState | null, y: number) {
  const x = COL_X[lane]!;
  const lines = wrap(cell.text);
  return html`<rect class="box ${boxClass(lane, cell, state)}" x="${x}" y="${y + 4}" width="${COL_W}" height="${ROW_H - 8}" rx="6"/>${lines.map(
    (line, i) => html`<text class="cell" x="${x + COL_W / 2}" y="${y + 19 + i * 13}" text-anchor="middle">${line}</text>`,
  )}`;
}

/** One row: its cells in their lanes, and the pair's bar behind them, in the pair's colour. */
function rowSvg(row: LibroRow, index: number) {
  const y = HEADER_H + index * ROW_H;
  const cells: Array<[number, LibroCell | null]> = [
    [0, row.agent],
    [1, row.book],
    [2, row.world],
  ];
  const present = cells.filter((entry): entry is [number, LibroCell] => entry[1] !== null);
  const first = present[0]?.[0];
  const last = present.at(-1)?.[0];
  const bar =
    row.state === null || first === undefined || last === undefined || first === last
      ? ""
      : html`<line class="bar ${STATE_COLOUR_CLASS[row.state]}" x1="${COL_X[first]! + COL_W}" y1="${y + ROW_H / 2}" x2="${COL_X[last]!}" y2="${y + ROW_H / 2}"/>`;
  return html`<a href="#d-${row.id}" aria-label="${row.state === null ? "Sin par" : PAIR_WORDS[row.state]}">${bar}${present.map(([lane, cell]) => cellSvg(cell, lane, row.state, y))}</a>`;
}

/** The detail under the drawing: each cell in full, its IDs and codes, its time, and the link to what decided it. */
function panelOf(row: LibroRow, rows: readonly LibroRow[]) {
  const lanes: Array<[string, LibroCell | null]> = [
    [LANE_TITLES[0], row.agent],
    [LANE_TITLES[1], row.book],
    [LANE_TITLES[2], row.world],
  ];
  const decidedBy = (cell: LibroCell) => {
    if (cell.kind !== "gate" || cell.factId === null) return null;
    return rows.find((other) => [other.agent, other.book, other.world].some((c) => c !== null && c.kind !== "gate" && c.factId === cell.factId)) ?? null;
  };
  return html`<section id="d-${row.id}" class="panel ${row.state ?? "sin-par"}">
<h2>${row.state === null ? "Sin par" : PAIR_WORDS[row.state]}</h2>
${lanes.map(([title, cell]) =>
  cell === null
    ? ""
    : html`<p class="lane-line"><strong>${title}:</strong> ${cell.text}</p>
<dl>${cell.atMs === null ? "" : html`<dt>Hora</dt><dd>${formatTime(cell.atMs)}</dd>`}${cell.details.map((d) => html`<dt>${d.term}</dt><dd><code>${d.value}</code></dd>`)}</dl>
${cell.kind === "gate" && cell.factId !== null ? html`<p>Decidido por ${decidedBy(cell) === null ? html`<code>${cell.factId}</code>` : html`<a href="#d-${decidedBy(cell)!.id}">ver el hecho</a>`}</p>` : ""}`,
)}
<p><a href="#libro">Volver al libro</a></p>
</section>`;
}

const legend = html`<ul class="legend">
<li><i class="s-emparejado"></i>${PAIR_WORDS.emparejado}</li>
<li><i class="s-sin_pareja"></i>${PAIR_WORDS.sin_pareja}</li>
<li><i class="s-en_duda"></i>${PAIR_WORDS.en_duda}</li>
<li><i class="s-bloqueado"></i>${PAIR_WORDS.bloqueado}</li>
</ul>
<p class="hint">Sin confirmación de entrega todavía es en duda, nunca rojo. Tocá una fila para ver su detalle.</p>`;

export function libroScreen(app: Hono<ConsoleEnv>) {
  app.get("/deed/:orderId/libro", async (c) => {
    const orderId = c.req.param("orderId");
    const tenant = { businessId: c.get("member").businessId };
    const input = await new D1LibroReads(c.env.DB).read(tenant, orderId);
    if (input === null) return c.html(simplePage("Libro", html`<p class="empty">Ese pedido no está en la lista.</p>`), 404);
    const trail = await new D1OrderTrail(c.env.DB).trail(tenant, orderId);
    const rows = libroRows(input);
    const height = HEADER_H + Math.max(rows.length, 1) * ROW_H + 6;
    const svg = html`<svg id="libro" class="libro" viewBox="0 0 ${VIEW_W} ${height}" role="img" aria-label="Lo que dijo el agente, lo que el libro empareja y lo que registró el mundo">
${LANE_TITLES.map((title, lane) => html`<text class="lane" x="${COL_X[lane]! + COL_W / 2}" y="20" text-anchor="middle">${title}</text>`)}
${rows.map((row, index) => rowSvg(row, index))}
</svg>`;
    return c.html(
      await shell(c, {
        title: `Libro ${trail?.code ?? "—"}`,
        subtitle: "Deed · lo que se dijo y lo que pasó",
        back: `/console/deed/${encodeURIComponent(orderId)}`,
        path: `/console/deed/${encodeURIComponent(orderId)}/libro`,
        tab: "/console/mas",
        style: STYLE,
        body: rows.length === 0
          ? html`<p class="empty">Todavía no hay nada que comparar en este pedido.</p>`
          : html`${legend}
${svg}
${rows.map((row) => panelOf(row, rows))}`,
      }),
    );
  });
}

const STYLE = `
.libro{--claim:#3A4BC8;--witness:#0E7C86;--ok:#1F8A4C;--doubt:#B7791F;--bad:#C2362F;--muted:#5B6578;--ink:#141C2E;
  display:block;width:100%;max-width:420px;height:auto;margin:8px 12px;background:#fff;border:1px solid var(--line);border-radius:10px}
.libro .lane{font:600 11px system-ui,sans-serif;fill:var(--muted)}
.libro .box{fill:#fff;stroke-width:1.6}
.libro .c-claim{stroke:var(--claim)}
.libro .c-witness{stroke:var(--witness)}
.libro .c-book{stroke:var(--ink)}
.libro .gate{fill:#fafafa;stroke:var(--muted);stroke-dasharray:4 3}
.libro .cell{font:500 11px system-ui,sans-serif;fill:var(--ink)}
.libro .bar{stroke-width:3}
.libro .s-emparejado{stroke:var(--ok)}
.libro .s-sin_pareja{stroke:var(--bad)}
.libro .s-en_duda{stroke:var(--doubt)}
.libro .s-bloqueado{stroke:var(--muted);stroke-dasharray:4 3}
.libro a:focus-visible .box{stroke-width:3}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 14px;margin:8px 12px;padding:0;font-size:13px}
.legend li{display:flex;align-items:center;gap:6px}
.legend i{display:inline-block;width:18px;height:4px;border-radius:2px;background:var(--line)}
.legend .s-emparejado{background:#1F8A4C}.legend .s-sin_pareja{background:#C2362F}
.legend .s-en_duda{background:#B7791F}.legend .s-bloqueado{background:#5B6578}
.hint{font-size:13px;color:var(--mute);margin:0 12px}
.panel{display:none;margin:8px 12px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.panel:target{display:block}
.panel h2{font-size:16px;margin:0 0 6px}
.panel dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:4px 0;font-size:13px}
.panel dt{color:var(--mute)}
.panel dd{margin:0;word-break:break-all}
.panel code{font-size:12px;word-break:break-all}
.panel.s-sin_pareja{border-color:#C2362F}.panel.s-en_duda{border-color:#B7791F}.panel.s-emparejado{border-color:#1F8A4C}
`;
