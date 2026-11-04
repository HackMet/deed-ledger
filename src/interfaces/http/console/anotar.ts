/**
 * Anotar: a member types what happened or takes a photo, and sees what the reader understood
 * (a sale, a fiado, a new product, or a Pedido a mano). Nothing is saved from here except the
 * photo, in the store's own R2 prefix: confirming a reading is the engine's (contract gap (i)).
 *
 * Owner and staff may both read: reading changes nothing, and the engine's actions keep their own
 * role checks. The store is the session's; no form field names one. Voice notes wait for #27.
 */
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { html } from "hono/html";
import {
  type ConsoleInput,
  type ConsolePurpose,
  type ConsoleReadOutcome,
  MAX_PHOTO_BYTES,
  MAX_TEXT_CHARS,
  readConsoleInput,
} from "../../../application/console-reader";
import { describeError } from "../../../application/errors";
import { formatLempiras } from "../../../domain/contract/numbers";
import type { Observation, ObservationIssue, PricedLine, ItemLine } from "../../../domain/contract/observation";
import { type ConsoleEnv, INVOICE_UPLOAD_PATH } from "./auth";
import { csrfField, shell } from "./layout";

const PATH = "/console/anotar";
/** Honest about what the screen does today: it reads and shows, it doesn't save. */
const SUBTITLE = "Te muestro lo que entendí. Todavía no se guarda nada.";
/** A supplier's invoice goes to its own upload and review (Facturas), owner only. */
const INVOICE_PATH = INVOICE_UPLOAD_PATH;

/** A photo, a note and the form's own fields; anything bigger is refused before it's parsed. */
export const MAX_ANOTAR_BODY_BYTES = MAX_PHOTO_BYTES + 64 * 1024;

type Refusal = Extract<ConsoleReadOutcome, { ok: false }>["reason"];

const REFUSALS: Record<Refusal, { readonly status: 400 | 413 | 429 | 503; readonly text: string }> = {
  empty: { status: 400, text: "Escribí algo o tomá una foto, y lo leo." },
  too_many: { status: 400, text: "Mandame una foto y un texto a la vez, nada más." },
  too_large: { status: 413, text: "Eso está muy pesado para leerlo de una vez. La foto puede pesar hasta 5 MB y el texto unas 2,000 letras." },
  unsupported_photo: { status: 400, text: "No pude abrir esa foto. Probá tomándola otra vez desde aquí." },
  voice_not_ready: { status: 400, text: "Las notas de voz aquí vienen pronto. Por ahora escribilo o tomale foto." },
  spend_cap: { status: 429, text: "Por hoy ya se leyó todo lo que alcanza. Mañana se puede otra vez." },
  rejected: { status: 503, text: "No pude leerlo ahorita. Probá otra vez en un rato." },
  unavailable: { status: 503, text: "No pude leerlo ahorita. Probá otra vez en un rato." },
  invalid_output: { status: 503, text: "No pude leerlo ahorita. Probá otra vez en un rato." },
};

/** Mounted in `index.ts` before the CSRF check, which reads the whole body. */
export const anotarBodyLimit = bodyLimit({
  maxSize: MAX_ANOTAR_BODY_BYTES,
  onError: (raw) => {
    const c = raw as unknown as Context<ConsoleEnv>;
    const notice = REFUSALS.too_large;
    c.get("runtime").deps.log.info("console_reader.refused", { businessId: c.get("member").businessId, reason: "too_large" });
    return c.html(page(c, notice.text, "report"), notice.status);
  },
});

export function anotarScreen(app: Hono<ConsoleEnv>) {
  app.get("/anotar", (c) => c.html(page(c, null, "report")));

  app.post("/anotar", async (c) => {
    const runtime = c.get("runtime");
    const form = await c.req.parseBody();
    const purpose: ConsolePurpose = form["para"] === "pedido" ? "order" : "report";
    const inputs: ConsoleInput[] = [];
    const photo = form["foto"];
    if (photo instanceof File && photo.size > 0) {
      if (photo.size > MAX_PHOTO_BYTES) return refusal(c, "too_large", purpose);
      inputs.push({ type: "photo", bytes: await photo.arrayBuffer(), contentType: photo.type });
    }
    const text = form["texto"];
    if (typeof text === "string") inputs.push({ type: "text", text });

    let outcome: ConsoleReadOutcome;
    try {
      outcome = await readConsoleInput(
        { reader: runtime.burstReader, mediaStore: runtime.deps.mediaStore, log: runtime.deps.log },
        c.get("member"),
        { purpose, inputs },
      );
    } catch (error) {
      // Storage or the spend ledger failed; nothing was read.
      runtime.deps.log.error("console_reader.failed", { businessId: c.get("member").businessId, reason: describeError(error) });
      return refusal(c, "unavailable", purpose);
    }
    if (!outcome.ok) return refusal(c, outcome.reason, purpose);
    c.header("Cache-Control", "no-store");
    return c.html(
      shell(c, {
        title: "Anotar",
        subtitle: SUBTITLE,
        path: PATH,
        style: STYLE,
        body: html`<section class="card"><h2>Esto entendí</h2>${outcome.reading.observations.map(observationView)}
<p class="hint">Todavía no se guarda nada.</p>
<p><a href="${PATH}">Anotar otra cosa</a></p></section>`,
      }),
    );
  });
}

function refusal(c: Context<ConsoleEnv>, reason: Refusal, purpose: ConsolePurpose) {
  const notice = REFUSALS[reason];
  return c.html(page(c, notice.text, purpose), notice.status);
}

function page(c: Context<ConsoleEnv>, notice: string | null, purpose: ConsolePurpose) {
  return shell(c, {
    title: "Anotar",
    subtitle: SUBTITLE,
    path: PATH,
    notice,
    style: STYLE,
    body: html`<form class="card" method="post" action="${PATH}" enctype="multipart/form-data">
${csrfField(c.get("csrf"))}
<p>Escribí lo que pasó o tomale foto. Te muestro lo que entendí.</p>
<fieldset><legend>¿Qué es?</legend>
<label><input type="radio" name="para" value="tienda"${purpose === "report" ? html` checked` : ""}> Venta, fiado o producto nuevo</label>
<label><input type="radio" name="para" value="pedido"${purpose === "order" ? html` checked` : ""}> Pedido a mano</label>
</fieldset>
${c.get("member").role === "owner" ? html`<a class="choice" href="${INVOICE_PATH}">Factura de proveedor<span class="go" aria-hidden="true">›</span></a>` : ""}
<label for="texto">Escribilo aquí</label>
<textarea id="texto" name="texto" rows="4" maxlength="${MAX_TEXT_CHARS}" placeholder="Vendí tres refrescos a veinte cada uno"></textarea>
<label for="foto">Foto (si querés)</label>
<input id="foto" type="file" name="foto" accept="image/jpeg,image/png,image/webp,image/gif" capture="environment">
<button class="primary">Leer</button>
</form>`,
  });
}

function observationView(observation: Observation) {
  return html`<div class="reading">${body(observation)}${observation.issues.length === 0 ? "" : html`<ul class="issues">${observation.issues.map((issue) => html`<li>${issueText(issue, observation)}</li>`)}</ul>`}</div>`;
}

function body(observation: Observation) {
  switch (observation.kind) {
    case "sale_report":
      return html`<h3>Venta</h3>${lines(observation.lines)}`;
    case "fiado_report":
      return html`<h3>Fiado a ${observation.customer}</h3>${lines(observation.lines)}`;
    case "setup_card":
      return html`<h3>Producto nuevo: ${observation.name}</h3><ul>
<li>Unidad: ${observation.unit ?? "sin decir"}</li>
<li>Hay: ${observation.count ?? "sin contar"}</li>
<li>Precio: ${observation.price === null ? "sin precio" : formatLempiras(observation.price)}</li></ul>`;
    case "supplier_invoice":
      return html`<h3>Factura${observation.supplier === null ? "" : html` de ${observation.supplier}`}</h3>${lines(observation.lines)}
${observation.total === null ? "" : html`<p>Total impreso: ${formatLempiras(observation.total)}</p>`}`;
    case "customer_order":
      return html`<h3>Pedido</h3>${lines(observation.lines)}`;
    case "fulfillment":
      return html`<h3>Entrega</h3><p>${
        observation.mode === "pickup" ? "Lo pasa a traer" : observation.mode === "delivery" ? "A domicilio" : "Sin decir cómo"
      }${observation.placeText === null ? "" : html`: ${observation.placeText}`}</p>`;
    case "customer_name":
      return html`<h3>Nombre del cliente</h3><p>${observation.name}</p>`;
    default:
      return html`<p>Aquí no encontré nada para anotar.</p>`;
  }
}

function lines(items: readonly (ItemLine | PricedLine)[]) {
  if (items.length === 0) return html`<p>Sin productos.</p>`;
  return html`<ul>${items.map(
    (item) =>
      html`<li>${[item.quantity ?? "¿cuántos?", item.unit, item.name].filter((part) => part !== null).join(" ")}${
        "unitPrice" in item && item.unitPrice !== null ? html` a ${formatLempiras(item.unitPrice)} c/u` : ""
      }${item.restrictedCategory ? html` <span class="tag">solo en tienda</span>` : ""}</li>`,
  )}</ul>`;
}

const ISSUE_TEXT: Record<ObservationIssue["code"], string> = {
  illegible: "Algo no se lee bien",
  ambiguous_size: "No dice el tamaño",
  ambiguous_product: "No sé qué producto es",
  embedded_instructions: "Trae instrucciones para el sistema; no les hice caso",
};

function issueText(issue: ObservationIssue, observation: Observation): string {
  const named = issue.line === null || !("lines" in observation) ? undefined : observation.lines[issue.line]?.name;
  return named === undefined ? `${ISSUE_TEXT[issue.code]}.` : `${ISSUE_TEXT[issue.code]}: ${named}.`;
}

/** The form reads like the mock's capture card; the reading is a draft card with a mango edge. */
const STYLE = `
form.card>p:first-of-type{margin:2px 0 6px;font-size:21px;font-weight:800;line-height:1.25;letter-spacing:-.4px}
fieldset{display:grid;gap:8px;border:0;padding:0;margin:16px 0 4px}
legend{margin-bottom:8px;padding:0;font-size:15px}
fieldset label{display:flex;align-items:center;min-height:56px;margin:0;padding:10px 14px;border:1.5px solid var(--line);border-radius:14px;background:var(--paper);font-size:17px;font-weight:600}
fieldset label:has(input:checked){border-color:var(--ink);background:var(--soft)}
a.choice{display:flex;align-items:center;justify-content:space-between;min-height:56px;margin:8px 0 0;padding:10px 14px;border:1.5px dashed var(--btn-line);border-radius:14px;background:var(--paper);color:var(--ink);font-size:17px;font-weight:600;text-decoration:none}
a.choice .go{font-size:26px;line-height:1}
label{margin-top:18px}
textarea{min-height:120px;border-color:var(--field);border-radius:18px;background:var(--cream)}
textarea:focus{background:#fff;border-color:var(--ink)}
section.card{border:2px solid #d7a24b;background:#fffdf5}
.reading{border-top:1px solid var(--line);padding:12px 0}
.reading h3{margin:4px 0 6px;font-size:19px;font-weight:800}
.reading li{padding:5px 0;font-size:17px}
.issues li{margin:6px 0;padding:8px 12px;border-left:3px solid #d8bb72;border-radius:0 10px 10px 0;background:#f3efdf;color:#5b3f08;font-size:15px;font-weight:600}
.hint{color:var(--mute)}
.tag{display:inline-block;padding:1px 7px;border-radius:7px;background:#ffe6de;color:#8a3429;font-size:12px;font-weight:800}
`;
