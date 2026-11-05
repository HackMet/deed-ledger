import { describe, expect, it } from "vitest";
import { deedGraph } from "../src/domain/deed-graph";
import type { DeedNodeView } from "../src/domain/deed-node-view";
import { liveGraph } from "../src/interfaces/http/console/deed-live-view";
import { toEnglish } from "../src/interfaces/http/console/language";

const view = (over: Partial<DeedNodeView> & { factId: string }): DeedNodeView => ({
  state: "hecho",
  title: "Pedido · 2 lb azúcar",
  agentId: "agent-v1",
  confirmedBy: "cliente",
  recordedAtMs: 1_000,
  evidenceKinds: ["inbound_message"],
  ...over,
});

const render = (views: DeedNodeView[], facts: Parameters<typeof deedGraph>[0] = []) => String(liveGraph(views, deedGraph(facts, []), "/console/deed/o1"));

/** The node of one fact: from its link to the link's end. */
const nodeOf = (page: string, id: string) => new RegExp(`<a href="/console/deed/o1#f-${id}"[\\s\\S]*?</a>`).exec(page)![0];
const extract = (node: string) => /<circle[^>]*\/>.*?<text class="word"[^>]*>[^<]*<\/text>/s.exec(node)![0].replace(/\s+/g, " ");

describe("liveGraph: each state says its word", () => {
  it("EN DUDA is amber and pulses", () => {
    const node = nodeOf(render([view({ factId: "a", state: "en_duda" })]), "a");
    expect(node).toContain(`class="lv-duda"`);
    expect(extract(node)).toMatchInlineSnapshot(`"<circle class="body" cx="110" cy="130" r="30"/><text class="word" x="110" y="133">EN DUDA</text>"`);
  });
  it("HECHO is green", () => {
    const node = nodeOf(render([view({ factId: "a" })]), "a");
    expect(node).toContain(`class="lv-hecho"`);
    expect(extract(node)).toMatchInlineSnapshot(`"<circle class="body" cx="110" cy="130" r="30"/><text class="word" x="110" y="133">HECHO</text>"`);
  });
  it("CERRADO has a green border and no fill", () => {
    const node = nodeOf(render([view({ factId: "a", state: "cerrado" })]), "a");
    expect(node).toContain(`class="lv-cerrado"`);
    expect(extract(node)).toMatchInlineSnapshot(`"<circle class="body" cx="110" cy="130" r="30"/><text class="word" x="110" y="133">CERRADO</text>"`);
  });
  it("BLOQUEADO is gray, dotted, with a lock", () => {
    const node = nodeOf(render([view({ factId: "a", state: "bloqueado" })]), "a");
    expect(node).toContain(`class="lv-bloqueado"`);
    expect(node).toContain(`class="lock"`);
    expect(node).toContain(">BLOQUEADO<");
  });
});

describe("liveGraph: legs and lines", () => {
  it("draws no agent leg when the record names no agent", () => {
    const page = render([view({ factId: "a", agentId: null })]);
    expect(page).not.toContain("Afirmó el agente");
    expect(page).not.toContain("leg-up");
    expect(render([view({ factId: "a" })])).toContain("Afirmó el agente");
  });

  it("draws a dotted amber leg and 'esperando confirmación' when nobody confirmed", () => {
    const page = render([view({ factId: "a", state: "en_duda", confirmedBy: null })]);
    expect(page).toContain(`class="leg-wait"`);
    expect(page).toContain("esperando confirmación");
    expect(page).not.toContain("Lo confirmó");
  });

  it("names who confirmed", () => {
    for (const [by, words] of [["tienda", "Lo confirmó: tienda"], ["cliente", "Lo confirmó: cliente"], ["whatsapp", "Lo confirmó: WhatsApp (entregado)"]] as const) {
      expect(render([view({ factId: "a", confirmedBy: by })])).toContain(words);
    }
  });

  it("labels what depends on what, and what replaces what, in neutral colours", () => {
    const page = render(
      [view({ factId: "a", recordedAtMs: 1 }), view({ factId: "b", recordedAtMs: 2, state: "cerrado" })],
      [
        { id: "a", kind: "order_version", recordedAtMs: 1, dependsOn: [], closure: { closedByFactId: "b", reason: "superseded" } },
        { id: "b", kind: "change_request", recordedAtMs: 2, dependsOn: ["a"], closure: null },
      ],
    );
    expect(page).toContain("depende de");
    expect(page).toContain("reemplaza a");
    expect(page).toContain(`class="e-closes"`);
  });

  it("draws no red on a node, a long title is cut with its full text in the title element, and it ends with a legend", () => {
    const long = "Pedido · 12 lb de azúcar morena y 3 bolsas de arroz";
    const page = render([view({ factId: "a", title: long }), view({ factId: "b", state: "bloqueado" }), view({ factId: "c", state: "cerrado" })]);
    expect(page.toLowerCase()).not.toMatch(/#ff6b6b|#ef4444|#dc2626|#c62828|\bred\b/);
    expect(page).toContain(`<title>${long}</title>`);
    expect(page).toContain("Pedido · 12 lb de azúcar morena …".slice(0, 29));
    expect(page).toContain(`class="live-legend"`);
    expect(page).toContain(`id="grafo"`);
    expect(page).toContain(`#f-a`);
  });
});

describe("liveGraph in English", () => {
  it("leaves no Spanish word from this view", () => {
    const page = render(
      [
        view({ factId: "a", recordedAtMs: 1, title: "Cambio aprobado" }),
        view({ factId: "b", recordedAtMs: 2, state: "en_duda", confirmedBy: null, title: "Cambio → 3 lb" }),
        view({ factId: "c", recordedAtMs: 3, state: "bloqueado", confirmedBy: "tienda", title: "Cancelado por la tienda" }),
        view({ factId: "d", recordedAtMs: 4, state: "cerrado", confirmedBy: "whatsapp", title: "Pedido" }),
      ],
      [
        { id: "a", kind: "order_version", recordedAtMs: 1, dependsOn: [], closure: { closedByFactId: "b", reason: "superseded" } },
        { id: "b", kind: "change_request", recordedAtMs: 2, dependsOn: ["a"], closure: null },
      ],
    );
    const words = toEnglish(page).replace(/<style[\s\S]*?<\/style>|<[^>]*>/g, "\n");
    for (const english of ["DONE", "IN DOUBT", "CLOSED", "BLOCKED", "Agent claimed", "awaiting confirmation", "depends on", "replaces", "Confirmed by: store", "Confirmed by: WhatsApp (delivered)", "Change → 3 lb", "Cancelled by the store"]) {
      expect(words).toContain(english);
    }
    for (const spanish of ["HECHO", "EN DUDA", "CERRADO", "BLOQUEADO", "Afirmó", "Lo confirmó", "esperando", "depende", "reemplaza", "Cambio", "Cancelado"]) expect(words).not.toContain(spanish);
  });

  it("translates the one-line summary", () => {
    expect(toEnglish("<p>11 afirmaciones · 9 confirmadas · 2 sin respaldo · 4 intentos rechazados</p>")).toContain("11 claims · 9 confirmed · 2 unbacked · 4 attempts refused");
  });
});
