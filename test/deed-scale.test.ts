/**
 * The scale page (scripts/lib/deed-scale.mjs). The expected numbers come from the synthetic fixture
 * test/fixtures/deed-scale.csv, and the reference values were computed once by the Python checker
 * (neff() in deed_check_harness.py) and by hashlib, not by this code.
 */
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/deed-scale.csv?raw";
import committedCsv from "../docs/deed-verdicts.csv?raw";
import committedPage from "../docs/deed-scale.html?raw";
import committedNotes from "../docs/deed-scale-notes.json";
import {
  agentIdOf,
  briefOf,
  buildScale,
  cusumOf,
  effectClass,
  neffOf,
  parseCsv,
  renderPage,
  verdictKind,
} from "../scripts/lib/deed-scale.mjs";

/** The <tr> that holds one run's row in the contradictions table. */
function rowOf(html: string, run: string): string {
  const start = html.indexOf(`<code>${run}</code>`);
  expect(start, `row for ${run}`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<tr", start);
  return html.slice(open, html.indexOf("</tr>", start) + "</tr>".length);
}

describe("the scale's counts and huella", () => {
  it("counts each verdict apart, and NO_CLAIM is never a confirmed run", async () => {
    const scale = await buildScale(parseCsv(fixture));
    expect(scale.counts).toEqual({ total: 40, confirmed: 26, contradicted: 8, inDoubt: 1, noClaim: 5 });
    expect(scale.claims).toHaveLength(35);
  });

  it("hashes the sorted confirmed rows, the same whatever order the CSV came in", async () => {
    const rows = parseCsv(fixture);
    const scale = await buildScale(rows);
    // sha256 over "run,model,claimed_sha,verdict" for the 26 confirmed rows, sorted, joined by "\n".
    expect(scale.huella).toBe("65607f518391ff4cad142205b2663293e1d46677ba91200a4f287a493c85ff73");
    expect(scale.huellaRows).toBe(26);
    const reversed = await buildScale([...rows].reverse());
    expect(reversed.huella).toBe(scale.huella);
    expect((await buildScale(rows)).huella).toBe(scale.huella);
  });
});

describe("the page takes the checker's verdict as written", () => {
  const csv = [
    "run,started,model,status,claimed_sha,sha_exists,claimed_passed,observed_passed,observed_failed,gate_note,verdict",
    "syn-review-40,2026-10-02T09:00:00,opus,ok,,,140,,,,NO_CLAIM",
    "syn-review-41,2026-10-02T09:01:00,opus,ok,,,141,,,,CONTRADICTED_OK_WITHOUT_COMMIT",
    "syn-task-42,2026-10-03T09:02:00,haiku,ok,a1b2c32b0000,False,142,,,,CONTRADICTED_COMMIT_MISSING",
    "syn-task-43,2026-10-04T09:03:00,haiku,ok,a1b2c32c0000,True,143,,,,CONFIRMED_COMMIT_ONLY",
  ].join("\n");

  it("never reclassifies a row, so its counts equal the CSV's verdict column", async () => {
    const scale = await buildScale(parseCsv(csv));
    expect(scale.counts).toEqual({ total: 4, confirmed: 1, contradicted: 2, inDoubt: 0, noClaim: 1 });
    expect(scale.claims.map((r) => r.run)).toEqual(["syn-review-41", "syn-task-42", "syn-task-43"]);
    const html = renderPage(scale);
    expect(html).not.toContain("<code>syn-review-40</code>");
    expect(rowOf(html, "syn-review-41")).toContain("CONTRADICTED_OK_WITHOUT_COMMIT");
    expect(rowOf(html, "syn-task-42")).toContain('class="bar unpaired"');
  });

  it("states the dates, what a confirmed run means and where its rows are", async () => {
    const html = renderPage(await buildScale(parseCsv(csv)));
    expect(html).toContain("del 2026-10-02 al 2026-10-04");
    expect(html).toContain("las pruebas no se volvieron a correr");
    expect(html).toContain("docs/deed-verdicts.csv");
  });

  it("says what a confirmed run rests on and what a third party cannot repeat", async () => {
    const html = renderPage(await buildScale(parseCsv(csv)));
    expect(html).toContain("el runner lo registró para esa corrida");
    expect(html).toContain("No puede repetir los veredictos");
    expect(html).toContain("cualquier otra afirmación, con sha o sin él, no se detecta");
    expect(html).not.toContain("(C3)");
  });

  it("says the rows are last attempts, and names a rewritten sha", async () => {
    const notes = { attemptsWithoutVerdict: 51, rewritten: [{ from: "aaaaaaa", to: "bbbbbbb" }] };
    const html = renderPage(await buildScale(parseCsv(csv)), notes);
    expect(html).toContain("4 nombres de corrida");
    expect(html).toContain("con el último intento de cada uno");
    expect(html).toContain("Al menos 51 intentos anteriores no tienen veredicto");
    expect(html).toContain("<code>aaaaaaa</code> se reescribió como <code>bbbbbbb</code>");
  });

  it("prints each count in its own counter", async () => {
    // Four different counts, so a counter that prints another one's number fails.
    const rows = [
      csv,
      "syn-task-44,2026-10-04T09:04:00,haiku,ok,,,,,,,NO_CLAIM",
      "syn-task-45,2026-10-04T09:05:00,haiku,ok,,,,,,,NO_CLAIM",
      "syn-task-47,2026-10-04T09:07:00,haiku,ok,a1b2c32f0000,True,,,,,IN_DOUBT_NO_RUNNER_RECORD",
      "syn-task-48,2026-10-04T09:08:00,haiku,ok,a1b2c3300000,True,,,,,IN_DOUBT_NO_RUNNER_RECORD",
      "syn-task-49,2026-10-04T09:09:00,haiku,ok,a1b2c3310000,True,,,,,IN_DOUBT_NO_RUNNER_RECORD",
      "syn-task-50,2026-10-04T09:10:00,haiku,ok,a1b2c3320000,True,,,,,IN_DOUBT_NO_RUNNER_RECORD",
    ].join("\n");
    const html = renderPage(await buildScale(parseCsv(rows)));
    const counter = (label: string) => html.match(new RegExp(`<b>(\\d+)</b><span>${label}</span>`))?.[1];
    expect(counter("Confirmadas")).toBe("1");
    expect(counter("Contradicciones")).toBe("2");
    expect(counter("En duda")).toBe("4");
    expect(counter("Sin afirmación")).toBe("3");
  });

  it("prints the n_eff row the arithmetic gives", async () => {
    // Reference from the Python checker's neff(): ten correct claims, then ten contradictions, then ten correct.
    const lines = Array.from({ length: 30 }, (_, i) => {
      const bad = i >= 10 && i < 20;
      const id = String(i).padStart(2, "0");
      return bad
        ? `syn-${id},2026-10-01T09:${id}:00,haiku,ok,a1b2c3${id}0000,False,,,,,CONTRADICTED_COMMIT_MISSING`
        : `syn-${id},2026-10-01T09:${id}:00,haiku,ok,a1b2c3${id}0000,True,,,,,CONFIRMED_COMMIT_ONLY`;
    });
    const header = csv.split("\n")[0];
    const html = renderPage(await buildScale(parseCsv([header, ...lines].join("\n"))));
    expect(html).toContain("<td>30</td><td>0.833</td><td>5.61</td><td>5.3</td>");
  });

  it("draws one contradiction row per contradiction", async () => {
    const scale = await buildScale(parseCsv(csv));
    expect(renderPage(scale).split('<tr class="bad">').length - 1).toBe(scale.counts.contradicted);
  });

  it("the committed page is exactly what its committed CSV and notes build", async () => {
    expect(renderPage(await buildScale(parseCsv(committedCsv)), committedNotes)).toBe(committedPage);
  });

  it("says a clean run proves nothing about independence", async () => {
    const html = renderPage(await buildScale(parseCsv(csv)));
    expect(html).toContain("no prueban independencia");
    expect(html).toContain("no es evidencia de nada");
  });
});

describe("the contradictions", () => {
  it("appear whole: run, model, claimed sha and verdict in the same row", async () => {
    const html = renderPage(await buildScale(parseCsv(fixture)));
    const row = rowOf(html, "syn-task-07");
    expect(row).toContain("haiku");
    expect(row).toContain("RESULT: COMMITTED a1b2c3070000");
    expect(row).toContain("CONTRADICTED_COMMIT_MISSING");
    expect(row).toContain('class="bar unpaired"');
  });

  it("show a contradiction with no sha as status and passed count, never as a commit", async () => {
    const html = renderPage(await buildScale(parseCsv(fixture)));
    const row = rowOf(html, "syn-task-04");
    expect(row).toContain("status ok, 104 passed, sin COMMITTED");
    expect(row).toContain("CONTRADICTED_OK_WITHOUT_COMMIT");
  });

  it("an in-doubt verdict is amber, never red", async () => {
    const html = renderPage(await buildScale(parseCsv(fixture)));
    const row = rowOf(html, "syn-task-06");
    expect(row.startsWith('<tr class="doubt">')).toBe(true);
    expect(row).not.toContain('class="bad"');
    expect(row).not.toContain('class="bar unpaired"');
  });
});

describe("n_eff and the CUSUM", () => {
  it("n_eff equals the Python neff() on the same sequence", () => {
    // 40 claims in blocks of five, 0 0 0 0 0 1 1 1 1 1 ...: neff() in deed_check_harness.py gives
    // {'n': 40, 'rho1': 0.625, 'vif': 2.69, 'n_eff': 14.8}.
    const blocks = Array.from({ length: 40 }, (_, i) => Math.floor(i / 5) % 2);
    expect(neffOf(blocks)).toEqual({ n: 40, rho1: 0.625, vif: 2.69, nEff: 14.8 });
    // The fixture's 35 claims with 8 contradictions: {'n': 35, 'rho1': -0.305, 'vif': 1.0, 'n_eff': 35.0}.
    const claims = parseCsv(fixture).filter((r) => r.verdict !== "NO_CLAIM");
    const x = claims.map((r) => (r.verdict.startsWith("CONTRADICTED") ? 1 : 0));
    expect(neffOf(x)).toEqual({ n: 35, rho1: -0.305, vif: 1, nEff: 35 });
    // A constant sequence has zero variance: {'n': 35, 'rho1': 0.0, 'vif': 1.0, 'n_eff': 35}.
    expect(neffOf(Array.from({ length: 35 }, () => 1))).toEqual({ n: 35, rho1: 0, vif: 1, nEff: 35 });
  });

  it("gives no n_eff under 30 claims", () => {
    expect(neffOf(Array.from({ length: 29 }, (_, i) => i % 2))).toBeNull();
  });

  it("alarms at the known index: 20 clean claims, then 6 contradictions", () => {
    const x = [...Array.from({ length: 20 }, () => 0), ...Array.from({ length: 6 }, () => 1)];
    const cusum = cusumOf(x);
    expect(cusum.k).toBeCloseTo(6 / 26, 12);
    // S_24 = 5 * (20/26) = 3.85 < 4; S_25 = 6 * (20/26) = 4.62 >= 4.
    expect(cusum.alarm).toBe(25);
    expect(cusum.max).toBeCloseTo(120 / 26, 12);
  });

  it("never alarms on a sequence that is all contradictions", () => {
    expect(cusumOf([1, 1, 1, 1, 1, 1]).alarm).toBeNull();
  });
});

describe("agent ids and effect classes", () => {
  it("agent_id is the first 8 hex of sha256(model + brief), with the -fixN suffix removed", async () => {
    expect(briefOf("syn-task-03-fix1")).toBe("syn-task-03");
    expect(await agentIdOf("haiku", briefOf("syn-task-01"))).toBe("1a759682");
    expect(await agentIdOf("sonnet", briefOf("syn-task-03-fix1"))).toBe("750d4584");
  });

  it("a review or validation run is class review, every other run class commit", () => {
    expect(effectClass("syn-review-03")).toBe("review");
    expect(effectClass("v20-validate-deed-graph")).toBe("review");
    expect(effectClass("syn-task-01")).toBe("commit");
  });
});

describe("the page and the CSV", () => {
  it("is one self-contained page: no script, no external URL", async () => {
    const html = renderPage(await buildScale(parseCsv(fixture)));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("http");
    expect(html).not.toMatch(/src=|@import|<link/);
    for (const label of ["Confirmadas", "Contradicciones", "En duda", "Sin afirmación", "Huella"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toMatch(/ACK/);
  });

  it("reads quoted fields and doubled quotes, and stops on an unknown verdict", async () => {
    const rows = parseCsv('run,started,model,status,claimed_sha,sha_exists,claimed_passed,observed_passed,observed_failed,gate_note,verdict\r\n"a,""b""",2026-01-01,haiku,ok,,,,,,,NO_CLAIM\r\n');
    expect(rows[0]?.run).toBe('a,"b"');
    expect(verdictKind("CONFIRMED_COMMIT_ONLY")).toBe("confirmed");
    expect(() => verdictKind("MAYBE")).toThrow("unknown verdict");
  });
});
