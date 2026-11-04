// The scale view of the harness runs (K20c-b): one static HTML page built from deed-verdicts.csv
// (deed_check_harness.py). Every number is fixed arithmetic over the CSV; no model writes or reads it (C3).
// The CLI is scripts/deed-scale.mjs.

export const PALETTE = { claim: "#3A4BC8", witness: "#0E7C86", ok: "#1F8A4C", doubt: "#B7791F", bad: "#C2362F" };
export const CUSUM_H = 4;
export const NEFF_MIN = 30;

const KINDS = [
  ["CONFIRMED", "confirmed"],
  ["CONTRADICTED", "contradicted"],
  ["IN_DOUBT", "in_doubt"],
  ["NO_CLAIM", "no_claim"],
];

/** The kind of a verdict string; an unknown verdict stops the page instead of landing in a count. */
export function verdictKind(verdict) {
  const hit = KINDS.find(([prefix]) => verdict.startsWith(prefix));
  if (!hit) throw new Error(`unknown verdict: ${verdict}`);
  return hit[1];
}

/** RFC 4180 subset: quoted fields with doubled quotes, CRLF or LF line ends. Returns one object per data row. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  return body.map((r) => Object.fromEntries(header.map((name, j) => [name, r[j] ?? ""])));
}

/** A fix run shares its brief with the first attempt: "k5-console-pedidos-fix1" -> "k5-console-pedidos". */
export function briefOf(run) {
  return run.replace(/-fix\d+$/, "");
}

/** Self-declared: a review or validation run is "review", every other run is "commit". */
export function effectClass(run) {
  return /review|validate/i.test(run) ? "review" : "commit";
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** First 8 hex of sha256(model + brief). Self-declared: the run name and model are all it knows. */
export async function agentIdOf(model, brief) {
  return (await sha256Hex(model + brief)).slice(0, 8);
}

function roundTo(value, digits) {
  return Number(value.toFixed(digits));
}

/**
 * The port of neff() in deed_check_harness.py: same arithmetic, same floor. Returns null under NEFF_MIN claims.
 * x is the 0/1 contradiction sequence in time order.
 */
export function neffOf(x) {
  const n = x.length;
  if (n < NEFF_MIN) return null;
  const m = x.reduce((a, b) => a + b, 0) / n;
  const variance = x.reduce((a, v) => a + (v - m) * (v - m), 0) / n;
  if (variance === 0) return { n, rho1: 0, vif: 1, nEff: n };
  let s = 0;
  let rho1 = 0;
  for (let h = 1; h < Math.floor(n / 2); h++) {
    let acc = 0;
    for (let i = 0; i < n - h; i++) acc += (x[i] - m) * (x[i + h] - m);
    const rho = acc / n / variance;
    if (h === 1) rho1 = rho;
    if (rho <= 0) break;
    s += (1 - h / n) * rho;
  }
  const vif = 1 + 2 * s;
  return { n, rho1: roundTo(rho1, 3), vif: roundTo(vif, 2), nEff: roundTo(n / vif, 1) };
}

/**
 * One-sided CUSUM over x: S_t = max(0, S_{t-1} + x_t - k), k = the mean of x, alarm at the first t with S_t >= h.
 * alarm is the 0-based index, or null.
 */
export function cusumOf(x, h = CUSUM_H) {
  if (x.length === 0) return { k: null, h, series: [], alarm: null, max: 0 };
  const k = x.reduce((a, b) => a + b, 0) / x.length;
  let s = 0;
  let alarm = null;
  const series = x.map((v, t) => {
    s = Math.max(0, s + v - k);
    if (alarm === null && s >= h) alarm = t;
    return s;
  });
  return { k, h, series, alarm, max: Math.max(...series) };
}

function toRow(csv) {
  const effect = effectClass(csv.run);
  // The checker's verdict is the only source: the page never reclassifies a row.
  const kind = verdictKind(csv.verdict);
  return {
    run: csv.run,
    started: csv.started,
    model: csv.model,
    status: csv.status,
    claimedSha: csv.claimed_sha,
    shaExists: csv.sha_exists === "True",
    claimedPassed: csv.claimed_passed === "" ? null : Number(csv.claimed_passed),
    verdict: csv.verdict,
    kind,
    brief: briefOf(csv.run),
    effect,
  };
}

/**
 * The whole scale, from parsed CSV rows. Rows are ordered by start time, as the checker writes them.
 * huella: sha256 (UTF-8) of the confirmed rows, each as "run,model,claimed_sha,verdict", sorted by code
 * unit and joined with "\n" (no final newline).
 */
export async function buildScale(csvRows) {
  const rows = csvRows.map(toRow).sort((a, b) => (a.started < b.started ? -1 : a.started > b.started ? 1 : 0));
  for (const row of rows) row.agent = await agentIdOf(row.model, row.brief);

  const count = (kind) => rows.filter((r) => r.kind === kind).length;
  const confirmedLines = rows
    .filter((r) => r.kind === "confirmed")
    .map((r) => `${r.run},${r.model},${r.claimedSha},${r.verdict}`)
    .sort();
  const huella = await sha256Hex(confirmedLines.join("\n"));

  // Claims are every run with a claim (NO_CLAIM is apart); x is 1 for a contradiction, as in the checker.
  const claims = rows.filter((r) => r.kind !== "no_claim");
  const x = claims.map((r) => (r.kind === "contradicted" ? 1 : 0));

  const groups = new Map();
  for (const row of rows) {
    const key = `${row.agent}|${row.effect}`;
    if (!groups.has(key)) {
      groups.set(key, { agent: row.agent, effect: row.effect, runs: 0, confirmed: 0, contradicted: 0, in_doubt: 0, no_claim: 0 });
    }
    const group = groups.get(key);
    group.runs += 1;
    group[row.kind] += 1;
  }

  return {
    rows,
    counts: {
      total: rows.length,
      confirmed: count("confirmed"),
      contradicted: count("contradicted"),
      inDoubt: count("in_doubt"),
      noClaim: count("no_claim"),
    },
    huella,
    huellaRows: confirmedLines.length,
    groups: [...groups.values()].sort((a, b) => (a.agent + a.effect < b.agent + b.effect ? -1 : 1)),
    claims,
    neff: neffOf(x),
    cusum: cusumOf(x),
  };
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function claimText(row) {
  const passed = row.claimedPassed === null ? "sin conteo" : `${row.claimedPassed} passed`;
  return row.claimedSha
    ? `RESULT: COMMITTED ${row.claimedSha}, ${passed}`
    : `status ${row.status || "vacío"}, ${passed}, sin COMMITTED`;
}

function witnessText(row) {
  if (!row.claimedSha) return "git: sin sha que buscar";
  return row.shaExists ? "git: el sha existe" : "git: el sha no existe";
}

function pairing(row) {
  return row.claimedSha && row.shaExists;
}

function contradictionRows(rows) {
  const shown = rows.filter((r) => r.kind === "contradicted" || r.kind === "in_doubt");
  if (shown.length === 0) return "<p class=\"note\">Ninguna.</p>";
  const lines = shown.map((r) => {
    const paired = pairing(r);
    const verdictClass = r.kind === "in_doubt" ? "doubt" : "bad";
    return `<tr class="${verdictClass}">
  <td><code>${esc(r.run)}</code><br><span class="note">${esc(r.model)} · ${esc(r.started)}</span></td>
  <td><span class="claim">${esc(claimText(r))}</span></td>
  <td><div class="bar ${paired ? "paired" : "unpaired"}"></div><span class="bar-label">${paired ? "emparejado" : "sin par"}</span></td>
  <td>${esc(witnessText(r))}</td>
  <td class="verdict"><code>${esc(r.verdict)}</code></td>
</tr>`;
  });
  return `<table>
<thead><tr><th>Corrida</th><th>AGENTE · afirmación</th><th>LIBRO · pareja</th><th>MUNDO · git</th><th>Veredicto</th></tr></thead>
<tbody>
${lines.join("\n")}
</tbody>
</table>`;
}

function groupRows(groups) {
  if (groups.length === 0) return "<p class=\"note\">Sin corridas.</p>";
  return `<table>
<thead><tr><th>agent_id</th><th>Clase de efecto</th><th>Corridas</th><th>Confirmadas</th><th>Contradicciones</th><th>En duda</th><th>Sin afirmación</th></tr></thead>
<tbody>
${groups
  .map(
    (g) => `<tr><td><code>${esc(g.agent)}</code></td><td>${esc(g.effect)}</td><td>${g.runs}</td><td>${g.confirmed}</td><td>${g.contradicted}</td><td>${g.in_doubt}</td><td>${g.no_claim}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table>`;
}

function cusumChart(series, h) {
  const width = 640;
  const height = 160;
  const top = Math.max(h, ...series, 0) * 1.1 || 1;
  const xAt = (t) => (series.length > 1 ? (t * width) / (series.length - 1) : 0);
  const yAt = (v) => height - (v / top) * height;
  const points = series.map((v, t) => `${xAt(t).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  const threshold = yAt(h).toFixed(1);
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="CUSUM S_t con alarma en h">
<line x1="0" x2="${width}" y1="${threshold}" y2="${threshold}" stroke="${PALETTE.bad}" stroke-dasharray="6 4"/>
<polyline fill="none" stroke="${PALETTE.claim}" stroke-width="2" points="${points}"/>
</svg>`;
}

function dependenceSection(scale) {
  const { neff, cusum, claims } = scale;
  const neffPart = neff
    ? `<table>
<thead><tr><th>n (afirmaciones)</th><th>ρ₁</th><th>VIF</th><th>n_eff</th></tr></thead>
<tbody><tr><td>${neff.n}</td><td>${neff.rho1}</td><td>${neff.vif}</td><td>${neff.nEff}</td></tr></tbody>
</table>`
    : `<p class="note">Hacen falta al menos ${NEFF_MIN} afirmaciones; hay ${claims.length}.</p>`;
  const alarmRun = cusum.alarm === null ? null : claims[cusum.alarm];
  const alarmPart =
    cusum.alarm === null
      ? "ninguna"
      : `en la afirmación nº ${cusum.alarm + 1} (<code>${esc(alarmRun.run)}</code>)`;
  return `<h2>Dependencia entre errores</h2>
${neffPart}
<p class="note">n_eff = n / VIF, con VIF = 1 + 2·Σ(1 − h/n)·ρₕ hasta el primer ρₕ no positivo o n/2. Misma aritmética que <code>neff()</code> de <code>deed_check_harness.py</code>. Es un solo agregado, no por (agent_id, clase). Con pocas contradicciones, o ninguna, estos números no prueban independencia.</p>
<h2>CUSUM de contradicciones</h2>
<p>S_t = max(0, S_{t−1} + x_t − k), con x_t = 1 si la afirmación es una contradicción, en orden de inicio. k = tasa global = <code>${cusum.k === null ? "—" : cusum.k.toFixed(4)}</code>. Alarma en h = <code>${cusum.h}</code> (S_t ≥ h).</p>
<p>Alarma: ${alarmPart}. S máximo: <code>${cusum.max.toFixed(3)}</code>.</p>
<p class="note">Con k = tasa global y pocos eventos, S_t no puede llegar a h: que no haya alarma no es evidencia de nada.</p>
${cusumChart(cusum.series, cusum.h)}`;
}

const STYLE = `
:root { --bg:#EDF0F5; --surface:#FFFFFF; --lane:#F4F6FA; --ink:#141C2E; --muted:#5B6578; --line:#D3D9E3;
  --claim:${PALETTE.claim}; --witness:${PALETTE.witness}; --ok:${PALETTE.ok}; --doubt:${PALETTE.doubt}; --bad:${PALETTE.bad}; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.45 system-ui, sans-serif; }
main { max-width:980px; margin:0 auto; padding:24px 16px 48px; }
h1 { font-size:24px; margin:0 0 8px; }
h2 { font-size:17px; margin:28px 0 8px; }
.lede, .note { color:var(--muted); }
.counters { display:flex; gap:12px; flex-wrap:wrap; margin:16px 0; }
.counter { background:var(--surface); border:1px solid var(--line); border-left:6px solid var(--muted); border-radius:6px; padding:10px 14px; min-width:150px; }
.counter b { display:block; font-size:28px; }
.counter span { color:var(--muted); }
.counter.ok { border-left-color:var(--ok); }
.counter.bad { border-left-color:var(--bad); }
.counter.doubt { border-left-color:var(--doubt); }
code { font-family:ui-monospace, monospace; font-size:13px; overflow-wrap:anywhere; }
table { width:100%; border-collapse:collapse; background:var(--surface); }
th, td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { background:var(--lane); font-size:13px; }
tr.bad td.verdict { color:var(--bad); font-weight:600; }
tr.doubt td.verdict { color:var(--doubt); font-weight:600; }
.claim { color:var(--claim); }
.bar { height:10px; border-radius:5px; margin-bottom:4px; min-width:40px; }
.bar.paired { background:var(--witness); }
.bar.unpaired { background:var(--bad); }
.bar-label { font-size:12px; color:var(--muted); }
.huella code { word-break:break-all; }
svg { width:100%; height:auto; background:var(--surface); border:1px solid var(--line); }
`;

/** The whole page as one self-contained HTML string: inline CSS and SVG, no script, no external URL. */
/** notes: what the CSV cannot say (docs/deed-scale-notes.json): earlier attempts with no verdict, rewritten shas. */
export function renderPage(scale, notes = {}) {
  const { counts, huella, huellaRows } = scale;
  const days = scale.rows.map((r) => r.started.slice(0, 10)).filter(Boolean).sort();
  const earlier = notes.attemptsWithoutVerdict
    ? ` Otros ${notes.attemptsWithoutVerdict} intentos anteriores se sobrescribieron y no tienen veredicto.`
    : "";
  const rewritten = (notes.rewritten ?? [])
    .map((r) => `<code>${esc(r.from)}</code> se reescribió como <code>${esc(r.to)}</code>, con el mismo contenido.`)
    .join(" ");
  const span = days.length ? `del ${days[0]} al ${days[days.length - 1]}` : "sin fechas";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Escala del libro Deed · corridas del harness</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Escala del libro Deed</h1>
<p class="lede">${counts.total} nombres de corrida del harness, ${span} (UTC), con el último intento de cada uno.${earlier} Cada afirmación del agente se compara con dos testigos: ¿existe el sha en git, y el runner lo registró para esa corrida?
Las confirmadas se cuentan y se resumen en una huella; las contradicciones se muestran completas. Las corridas sin afirmación no cuentan como confirmadas.</p>
<p class="note"><b>Confirmada</b> solo dice que el commit existe y que el runner lo registró para esa corrida: las pruebas no se volvieron a correr. <b>Contradicción</b>: el sha no existe, el commit no es de esa corrida, o dijo que hizo commit y no hizo ninguno. Un error en texto libre, sin sha, no se detecta. <b>Sin afirmación</b>: una revisión o validación (no se le pide commit), una corrida bloqueada, una que dijo que no hizo commit nuevo, o una sin sha legible.</p>
<p class="note"><b>Qué puede comprobar un tercero:</b> desde el CSV, los conteos y la huella, y buscar cada sha en el repo. No puede repetir los veredictos: se calcularon en el clon de los mantenedores, con un verificador y unas corridas que no se publican, y parte de los commits existe solo en ramas y copias locales. ${rewritten}</p>
<p class="note">Filas: <code>docs/deed-verdicts.csv</code>.</p>

<section class="counters">
  <div class="counter ok"><b>${counts.confirmed}</b><span>Confirmadas</span></div>
  <div class="counter bad"><b>${counts.contradicted}</b><span>Contradicciones</span></div>
  <div class="counter doubt"><b>${counts.inDoubt}</b><span>En duda</span></div>
  <div class="counter"><b>${counts.noClaim}</b><span>Sin afirmación</span></div>
</section>
<p class="huella"><b>Huella</b> <code>${huella}</code><br>
<span class="note">sha256 (UTF-8) sobre ${huellaRows} filas confirmadas, ordenadas; cada fila es <code>run,model,claimed_sha,verdict</code>, unidas con saltos de línea y sin salto final.</span></p>

<h2>Contradicciones y dudas, fila por fila</h2>
<p class="note">Cada fila muestra la afirmación entera. La barra es la pareja: turquesa si el sha de la afirmación existe en git, roja si no hay par.</p>
${contradictionRows(scale.rows)}

<h2>Agentes</h2>
<p class="note">Agrupado por (agent_id, clase de efecto). <code>agent_id</code> = primeros 8 hex de sha256(modelo + brief); brief = nombre de la corrida sin el sufijo <code>-fixN</code>. Clase = <code>review</code> si el nombre contiene review o validate, si no <code>commit</code>. Es autodeclarado: sale del nombre de la corrida y el testigo no lo verifica (límite de C11).</p>
${groupRows(scale.groups)}

${dependenceSection(scale)}

<p class="note">Veredictos fijos por aritmética, sin ningún modelo de por medio. Solo nombre de corrida, modelo, sha, veredicto y conteos; ningún texto de informe, prompt ni secreto.</p>
</main>
</body>
</html>
`;
}
