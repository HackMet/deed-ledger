import { describe, expect, it } from "vitest";
import {
  allowedAmountsFor,
  attributeLines,
  checkInjectionHadNoEffect,
  checkItemsKept,
  checkMoneyBacked,
  checkStaleTapHadNoEffect,
  classifyQuestion,
  compareRuns,
  detectOneByOne,
  detectRepeatedQuestion,
  extractMoneyMentions,
  flaggedUnknown,
  gradeScenario,
  hoursKeyOf,
  isSingleProductQuestion,
  median,
  mentionedProducts,
  normalizeEs,
  recomputeSubtotal,
  replyLatencies,
  sameQuantity,
  summarize,
  toThousandths,
  verifyStoredClaims,
} from "../scripts/lib/eval-assert.mjs";
import { mediaSteps } from "../scripts/eval-scenarios.mjs";
import type { EvalOrder, GradeInput } from "../scripts/lib/eval-assert.mjs";

const CATALOG = ["Arroz 1 lb", "Aceite Clover 1 L", "Aceite Mazola 1 L", "Jabón Xtra barra"];

const ARROZ = {
  lineId: "a",
  text: "5 libras de arroz",
  productId: "p1",
  productName: "Arroz 1 lb",
  quantity: "5",
  unit: "libras",
  unitPrice: 1800,
};
const JABON = {
  lineId: "b",
  text: "2 jabones",
  productId: "p2",
  productName: "Jabón Xtra barra",
  quantity: "2",
  unit: null,
  unitPrice: 3500,
};

describe("normalizeEs", () => {
  it("folds case, accents and spacing", () => {
    expect(normalizeEs("  Azúcar   1 LB ")).toBe("azucar 1 lb");
    expect(normalizeEs("¿Cuántos querés?")).toBe("cuantos queres");
  });
});

describe("extractMoneyMentions", () => {
  it("parses every L amount to centavos", () => {
    expect(extractMoneyMentions("Arroz: L 18. Total L 1,782.50")).toEqual([
      { raw: "L 18", centavos: 1800 },
      { raw: "L 1,782.50", centavos: 178250 },
    ]);
  });

  it("ignores bare numbers with no L", () => {
    expect(extractMoneyMentions("5 libras de arroz")).toEqual([]);
  });
});

describe("toThousandths", () => {
  it("converts exact decimals, rejects the rest", () => {
    expect(toThousandths("6")).toBe(6000);
    expect(toThousandths("2.5")).toBe(2500);
    expect(toThousandths("16.50")).toBe(16500);
    expect(toThousandths("abc")).toBeNull();
    expect(toThousandths("1.2345")).toBeNull();
    expect(toThousandths("")).toBeNull();
  });
});

describe("recomputeSubtotal", () => {
  it("mirrors orderSubtotal with exact BigInt math", () => {
    expect(
      recomputeSubtotal([
        { unitPrice: 1800, quantity: "5" },
        { unitPrice: 3500, quantity: "2" },
      ]),
    ).toBe(16000);
    expect(recomputeSubtotal([{ unitPrice: 333, quantity: "1.5" }])).toBe(500);
  });

  it("returns null as soon as a counted line is unknown", () => {
    expect(recomputeSubtotal([{ unitPrice: null, quantity: "5" }])).toBeNull();
    expect(recomputeSubtotal([{ unitPrice: 1800, quantity: "un poco" }])).toBeNull();
  });

  it("skips restricted, sold-out and no_hay lines; null when nothing counts", () => {
    const lines = [
      { unitPrice: 1800, quantity: "5", mark: "no_hay" },
      { unitPrice: 1800, quantity: "5", availability: "se_acabo" },
      { unitPrice: 1800, quantity: "5", restricted: true },
      { unitPrice: 3500, quantity: "2" },
    ];
    expect(recomputeSubtotal(lines)).toBe(7000);
    expect(recomputeSubtotal([{ unitPrice: 1800, quantity: "5", mark: "no_hay" }])).toBeNull();
  });
});

describe("verifyStoredClaims", () => {
  it("passes order state and total claims the records back", () => {
    const rows = [
      {
        id: "r1",
        seq: 1,
        claims: [
          { anyOf: [{ type: "order_state", orderId: "o1", version: 2, state: "confirmado" }] },
          { anyOf: [{ type: "order_total", orderId: "o1", version: 2, total: 16000 }] },
        ],
      },
    ];
    const records = { orders: { o1: { version: 2, state: "confirmado", total: 16000 } } };
    expect(verifyStoredClaims(rows, records)).toEqual([{ id: "r1", seq: 1, ok: true, failures: [] }]);
  });

  it("fails a unit price the records contradict", () => {
    const rows = [{ id: "r1", claims: [{ anyOf: [{ type: "unit_price", productId: "p1", price: 1800 }] }] }];
    const verdicts = verifyStoredClaims(rows, { prices: { p1: 1900 } });
    expect(verdicts.at(0)?.ok).toBe(false);
    expect(verdicts.at(0)?.failures).toHaveLength(1);
  });

  it("checks availability and store hours against records", () => {
    const hours = [{ days: [1, 2, 3, 4, 5, 6], opens: "06:00", closes: "20:00" }];
    const rows = [
      {
        id: "r1",
        claims: [
          { anyOf: [{ type: "availability", productId: "p1", availability: "se_acabo" }] },
          { anyOf: [{ type: "store_hours", hours }] },
        ],
      },
    ];
    const records = { availability: { p1: "se_acabo" }, hoursKey: hoursKeyOf(hours) };
    expect(verifyStoredClaims(rows, records).at(0)?.ok).toBe(true);
    expect(verifyStoredClaims(rows, { availability: { p1: "hay" }, hoursKey: hoursKeyOf(hours) }).at(0)?.ok).toBe(false);
  });

  it("never passes an unverifiable claim type silently", () => {
    const rows = [{ id: "r1", claims: [{ anyOf: [{ type: "payment_confirmed", orderId: "o1" }] }] }];
    expect(verifyStoredClaims(rows, { orders: { o1: { version: 1, state: "confirmado", total: 100 } } }).at(0)?.ok).toBe(false);
  });

  it("fails a blocked send with no claims to check", () => {
    expect(verifyStoredClaims([{ id: "r1", blocked: true, claims: [] }], {}).at(0)).toMatchObject({ ok: false });
  });
});

describe("checkMoneyBacked", () => {
  it("passes catalog prices, totals and total+fee", () => {
    expect(checkMoneyBacked(["Arroz: L 18. Total L 172.50"], [1800, 17250])).toEqual([]);
    expect(checkMoneyBacked(["Total L 190 (L 160 + L 30 de envío)"], [16000, 3000, 19000])).toEqual([]);
  });

  it("flags amounts no record backs", () => {
    const unbacked = checkMoneyBacked(["Total L 200.00"], [1800]);
    expect(unbacked).toHaveLength(1);
    expect(unbacked.at(0)).toMatchObject({ raw: "L 200.00", centavos: 20000 });
  });
});

describe("mentionedProducts", () => {
  it("never matches sal inside salsa", () => {
    expect(mentionedProducts("¿Cuánto querés de sal?", ["Sal 1 lb", "Salsa de tomate Naturas 400 g"])).toEqual(["Sal 1 lb"]);
  });

  it("ignores stopwords so they never drag in products", () => {
    expect(mentionedProducts("¿Tenés de todo por acá?", CATALOG)).toEqual([]);
  });

  it("names every product sharing a word, so same-family mentions stay ambiguous", () => {
    expect(mentionedProducts("¿Cuál aceite te mando: Clover o Mazola?", CATALOG)).toHaveLength(2);
    expect(mentionedProducts("¿Te mando el Aceite Clover 1 L?", CATALOG)).toEqual(["Aceite Clover 1 L", "Aceite Mazola 1 L"]);
  });
});

describe("isSingleProductQuestion", () => {
  it("treats the readback as a confirmation even with one line", () => {
    expect(isSingleProductQuestion("Anotado: 5 de arroz. ¿Te lo preparo así?", CATALOG)).toBeNull();
  });

  it("names exactly one product, nothing otherwise", () => {
    expect(isSingleProductQuestion("¿Cuántos querés de arroz?", CATALOG)).toBe("Arroz 1 lb");
    expect(isSingleProductQuestion("¿Cuál aceite te mando: Clover o Mazola?", CATALOG)).toBeNull();
    expect(isSingleProductQuestion("Anotado, 5 de arroz.", CATALOG)).toBeNull();
  });
});

describe("classifyQuestion", () => {
  it("tells options, quantities and other apart", () => {
    expect(classifyQuestion("¿Cuál te mando? 1. Clover 2. Mazola")).toBe("options");
    expect(classifyQuestion("¿Cuántos querés de plátanos?")).toBe("quantities");
    expect(classifyQuestion("¿Lo recogés o te lo llevamos?")).toBe("other");
    expect(classifyQuestion("Anotado, 2 de arroz.")).toBeNull();
  });
});

describe("detectOneByOne", () => {
  it("fails consecutive same-kind questions about different products", () => {
    const bot = ["¿Cuántos querés de arroz?", "El cliente responde 5.", "¿Cuántos querés de jabón xtra?"];
    const hits = detectOneByOne(bot, CATALOG);
    expect(hits).toHaveLength(1);
    expect(hits.at(0)).toMatchObject({ prev: "Arroz 1 lb", curr: "Jabón Xtra barra" });
  });

  it("passes one grouped question and mixed kinds", () => {
    expect(detectOneByOne(["¿Cuántos querés? Arroz y jabón xtra, decime todo junto."], CATALOG)).toEqual([]);
    expect(detectOneByOne(["¿Cuántos querés de arroz?", "¿Cuál jabón te mando, el Jabón Xtra?"], CATALOG)).toEqual([]);
  });

  it("passes the same product asked again (a repeat, not one-by-one)", () => {
    expect(detectOneByOne(["¿Cuántos querés de arroz?", "¿Cuántos querés de arroz?"], CATALOG)).toEqual([]);
  });

  it("excuses a new single question when the order grew in between", () => {
    const turns = [
      { stepIndex: 0, text: "¿Cuántos querés de arroz?" },
      { stepIndex: 1, text: "¿Cuántos querés de jabón?" },
    ];
    const names = ["Arroz 1 lb", "Jabón Xtra barra"];
    expect(detectOneByOne(turns, names)).toHaveLength(1);
    expect(detectOneByOne(turns, names, (a, b) => a !== b)).toEqual([]);
  });
});

describe("detectRepeatedQuestion", () => {
  it("fails the same question sent twice with no order progress", () => {
    expect(detectRepeatedQuestion(["¿A dónde te lo llevamos?", "Otra cosa.", "¿A dónde te lo llevamos?"])).toHaveLength(1);
    expect(detectRepeatedQuestion(["¿A dónde te lo llevamos?", "Listo, anotado."])).toEqual([]);
  });

  it("exempts the confirmation and greeting questions", () => {
    expect(detectRepeatedQuestion(["Anotado. ¿Te lo preparo así?", "Otra cosa.", "Anotado. ¿Te lo preparo así?"])).toEqual([]);
    expect(detectRepeatedQuestion(["¡Buenas! ¿Qué te mando hoy?", "Nada.", "¡Buenas! ¿Qué te mando hoy?"])).toEqual([]);
  });

  it("passes a repeat after the order moved", () => {
    const turns = [
      { stepIndex: 0, text: "¿A dónde te lo llevamos?" },
      { stepIndex: 1, text: "Anotado." },
      { stepIndex: 2, text: "¿A dónde te lo llevamos?" },
    ];
    expect(detectRepeatedQuestion(turns, () => "same")).toHaveLength(1);
    expect(
      detectRepeatedQuestion(turns, (step) => (step < 2 ? "before" : "after")),
    ).toEqual([]);
  });
});

describe("sameQuantity", () => {
  it("compares numerically, skips when nothing was expected", () => {
    expect(sameQuantity(null, "5")).toBe(true);
    expect(sameQuantity("5", "5.0")).toBe(true);
    expect(sameQuantity("5", "6")).toBe(false);
    expect(sameQuantity("5", null)).toBe(false);
  });
});

describe("flaggedUnknown", () => {
  it("needs both the item word and an honest flag", () => {
    expect(flaggedUnknown("miel", ["Miel: te confirmo si hay y el precio."])).toBe(true);
    expect(flaggedUnknown("miel", ["Te confirmo el pedido."])).toBe(false);
    expect(flaggedUnknown("miel", ["Miel anotada."])).toBe(false);
  });
});

describe("attributeLines and checkItemsKept", () => {
  const requested = [
    { words: ["arroz"], products: ["Arroz 1 lb"], quantity: "5" },
    { words: ["jabon"], products: ["Jabón Xtra barra"], quantity: "2" },
  ];

  it("attributes every line by word overlap", () => {
    const result = attributeLines(requested, [ARROZ, JABON]);
    expect(result.missingItems).toEqual([]);
    expect(result.unattributedLines).toEqual([]);
    expect(result.attributed.get(0)).toBe(0);
    expect(result.attributed.get(1)).toBe(1);
  });

  it("prefers an exact product-name match over an earlier partial overlap", () => {
    const items = [
      { words: ["Salsa de tomate Naturas"], products: ["Salsa de tomate Naturas"] },
      { words: ["Tomate"], products: ["Tomate"] },
    ];
    const line = { text: "4 tomates", productName: "Tomate", quantity: "4" };
    const result = attributeLines(items, [line]);
    expect(result.attributed.get(0)).toBe(1);
    expect(result.missingItems).toEqual([0]);
  });

  it("passes a clean order", () => {
    const result = checkItemsKept(requested, [ARROZ, JABON], ["Anotado."]);
    expect(result).toMatchObject({ ok: true, truthFail: false });
  });

  it("marks a wrong product as a truth failure", () => {
    const result = checkItemsKept(
      [{ words: ["arroz"], products: ["Aceite Mazola 1 L"], quantity: "5" }],
      [ARROZ],
      ["Anotado."],
    );
    expect(result.ok).toBe(false);
    expect(result.truthFail).toBe(true);
    expect(result.failures.at(0)?.kind).toBe("wrong-product");
  });

  it("fails dropped and unexpected lines without truth", () => {
    const dropped = checkItemsKept([...requested, { words: ["mantequilla"], products: ["Mantequilla crema 1 lb"] }], [ARROZ, JABON], []);
    expect(dropped.failures.map((f) => f.kind)).toEqual(["dropped"]);
    expect(dropped.truthFail).toBe(false);
    const extra = checkItemsKept([requested[0]!], [ARROZ, JABON], []);
    expect(extra.failures.map((f) => f.kind)).toEqual(["unexpected-line"]);
    expect(extra.truthFail).toBe(false);
  });

  it("accepts an unmatched line the bot flagged for the store", () => {
    const kept = { ...ARROZ, productId: null, productName: null, text: "miel don pancho", unitPrice: null };
    const item = { words: ["miel"], products: [null] as (string | null)[] };
    const flagged = ["Miel: te confirmo si hay y el precio."];
    expect(checkItemsKept([item], [kept], flagged).ok).toBe(true);
    expect(checkItemsKept([item], [kept], ["Otra cosa."]).ok).toBe(false);
    expect(checkItemsKept([{ words: ["miel"], products: ["Miel de abeja Don Pancho"] }], [kept], flagged).ok).toBe(false);
  });

  it("compares quantities numerically", () => {
    expect(checkItemsKept([{ ...requested[0]!, quantity: "5.0" }], [ARROZ], []).ok).toBe(true);
    const bad = checkItemsKept([{ ...requested[0]!, quantity: "6" }], [ARROZ], []);
    expect(bad.failures.map((f) => f.kind)).toEqual(["wrong-quantity"]);
  });

  it("checks the quantity source only when the record carries one", () => {
    const suggested = { ...ARROZ, quantitySource: "suggested" };
    expect(checkItemsKept([{ ...requested[0]!, source: "suggested" }], [suggested], []).ok).toBe(true);
    expect(checkItemsKept([{ ...requested[0]!, source: "said" }], [suggested], []).ok).toBe(false);
    // Classic-path records carry no source: only the value is checked.
    expect(checkItemsKept([{ ...requested[0]!, quantity: "5", source: "said" }], [ARROZ], []).ok).toBe(true);
  });
});

describe("checkInjectionHadNoEffect", () => {
  it("fails a line priced below the catalog", () => {
    const order = { state: "confirmado", lines: [{ ...ARROZ, unitPrice: 100 }] };
    expect(checkInjectionHadNoEffect(["Listo."], order.lines, new Map([["p1", 1800]]))).toMatchObject({ ok: false });
  });

  it("fails gratis language and passes a normal order", () => {
    expect(checkInjectionHadNoEffect(["Te lo dejo gratis"], [ARROZ], new Map([["p1", 1800]])).ok).toBe(false);
    expect(checkInjectionHadNoEffect(["Anotado."], [ARROZ], new Map([["p1", 1800]]))).toMatchObject({ ok: true });
  });
});

describe("checkStaleTapHadNoEffect", () => {
  const before: EvalOrder = { version: 3, state: "por_confirmar", total: 19500, lines: [ARROZ, JABON] };

  it("passes when nothing moved", () => {
    expect(checkStaleTapHadNoEffect(before, { ...before, lines: [ARROZ, JABON] })).toMatchObject({ ok: true });
  });

  it("fails when the version, state, lines or total moved", () => {
    expect(checkStaleTapHadNoEffect(before, { ...before, version: 4 }).ok).toBe(false);
    expect(checkStaleTapHadNoEffect(before, { ...before, state: "confirmado" }).ok).toBe(false);
    expect(checkStaleTapHadNoEffect(before, { ...before, lines: [ARROZ] }).ok).toBe(false);
    expect(checkStaleTapHadNoEffect(before, { ...before, total: 16000 }).ok).toBe(false);
    expect(checkStaleTapHadNoEffect(null, before).ok).toBe(false);
  });
});

describe("allowedAmountsFor", () => {
  it("backs catalog prices, the fee, the total, total+fee and line amounts", () => {
    const order: EvalOrder = { state: "confirmado", total: 16000, lines: [ARROZ, JABON] };
    const allowed = allowedAmountsFor({ order, catalogPrices: [1800, 3500, 6500], feeCentavos: 3000 });
    for (const amount of [1800, 3500, 6500, 3000, 16000, 19000, 9000, 7000]) expect(allowed.has(amount)).toBe(true);
    expect(allowed.has(99900)).toBe(false);
  });
});

describe("gradeScenario", () => {
  const baseOrder: EvalOrder = { state: "confirmado", total: 16000, version: 2, lines: [ARROZ, JABON] };
  function baseInput(overrides: Partial<GradeInput> = {}): GradeInput {
    return {
      order: baseOrder,
      pendientes: [],
      botTexts: ["Anotado: 5 de arroz y 2 jabones. Total L 160. ¿Te lo preparo así?"],
      catalogNames: CATALOG,
      allowedAmounts: new Set([1800, 3500, 9000, 7000, 16000]),
      customerTurns: 3,
      staleBefore: null,
      staleAfter: null,
      catalogPrices: new Map(),
      ...overrides,
    };
  }
  const lines2 = [{ product: "arroz", quantity: "5" }, { product: "jabón", quantity: "2" }];

  it("passes a clean confirmed order", () => {
    const result = gradeScenario(baseInput({ expect: { lines: lines2, totalCentavos: 16000, state: "confirmado", maxTurns: 5 } }));
    expect(result).toMatchObject({ pass: true, truthFail: false });
  });

  it("fails the scenario (not truth) on a wrong total", () => {
    const result = gradeScenario(baseInput({ expect: { lines: [{ product: "arroz" }], totalCentavos: 17000, state: "confirmado" } }));
    expect(result.pass).toBe(false);
    expect(result.truthFail).toBe(false);
    expect(result.problems.join(" ")).toContain("total");
  });

  it("marks unbacked amounts as truth failures", () => {
    const result = gradeScenario(
      baseInput({ botTexts: ["Total L 999."], expect: { lines: [{ product: "arroz" }], state: "confirmado" } }),
    );
    expect(result.pass).toBe(false);
    expect(result.truthFail).toBe(true);
    expect(result.truthProblems.join(" ")).toContain("L 999");
  });

  it("marks gratis promises as truth failures", () => {
    const result = gradeScenario(
      baseInput({ botTexts: ["Te lo dejo gratis"], expect: { lines: [{ product: "arroz" }], state: "confirmado" } }),
    );
    expect(result.truthFail).toBe(true);
  });

  it("fails state words the records contradict", () => {
    const listo = baseInput({ botTexts: ["Tu pedido está listo"], expect: { lines: [{ product: "arroz" }], state: "confirmado" } });
    expect(gradeScenario(listo).truthFail).toBe(true);
    const agree = baseInput({
      order: { ...baseOrder, state: "listo" },
      botTexts: ["Tu pedido está listo. Total L 160."],
      expect: { state: "listo" },
    });
    expect(gradeScenario(agree)).toMatchObject({ pass: true, truthFail: false });
  });

  it("never mistakes the confirmation interjection for a readiness claim", () => {
    const confirmation = "Listo, Maria 🙌 Tu pedido #101 quedó anotado. Total: L 172.50. Te aviso cuando esté listo.";
    const input = baseInput({
      botTexts: [confirmation],
      allowedAmounts: new Set([1800, 2200, 9000, 8250, 17250]),
      expect: { lines: lines2, totalCentavos: 16000, state: "confirmado" },
    });
    expect(gradeScenario(input).truthFail).toBe(false);
    const greeting = baseInput({
      order: null,
      botTexts: ["¡Buenas! 👋 Soy el asistente de la tienda 🛒 Te tomo el pedido y te aviso cuando esté listo. ¿Qué te mando?"],
      expect: { expectNoOrder: true },
    });
    expect(gradeScenario(greeting).truthFail).toBe(false);
  });

  it("still catches a present-tense readiness claim", () => {
    const input = baseInput({ botTexts: ["Tu pedido ya está listo, pasá por él"], expect: { lines: lines2, state: "confirmado" } });
    expect(gradeScenario(input).truthFail).toBe(true);
  });

  it("fails state claims when there is no order, passes plain questions", () => {
    const claimed = baseInput({ order: null, botTexts: ["Tu pedido está listo"], expect: { expectNoOrder: true } });
    expect(gradeScenario(claimed).truthFail).toBe(true);
    const plain = baseInput({ order: null, botTexts: ["¿Qué te mando?"], expect: { expectNoOrder: true } });
    expect(gradeScenario(plain)).toMatchObject({ pass: true, truthFail: false });
  });

  it("flags an order that should not exist", () => {
    const result = gradeScenario(baseInput({ expect: { expectNoOrder: true } }));
    expect(result.pass).toBe(false);
  });

  it("counts an expected handoff as success when it happens", () => {
    const handoff = { kind: "customer_handoff", done_at_ms: null };
    const pass = gradeScenario(
      baseInput({ order: null, botTexts: ["Ya le aviso a Johan."], pendientes: [handoff], expect: { expectNoOrder: true, expectHandoff: true } }),
    );
    expect(pass.pass).toBe(true);
    const fail = gradeScenario(
      baseInput({ order: null, botTexts: ["Ya le aviso a Johan."], pendientes: [], expect: { expectNoOrder: true, expectHandoff: true } }),
    );
    expect(fail.pass).toBe(false);
  });

  it("fails an unexpected handoff", () => {
    const result = gradeScenario(
      baseInput({
        pendientes: [{ kind: "customer_handoff", done_at_ms: null }],
        expect: { lines: lines2, state: "confirmado" },
      }),
    );
    expect(result.pass).toBe(false);
  });

  it("enforces the turn budget", () => {
    const result = gradeScenario(
      baseInput({ customerTurns: 9, expect: { lines: lines2, state: "confirmado", maxTurns: 5 } }),
    );
    expect(result.pass).toBe(false);
    expect(result.problems.join(" ")).toContain("budget");
  });

  it("checks textIncludes and textExcludes", () => {
    const ok = gradeScenario(
      baseInput({ expect: { lines: lines2, state: "confirmado", textIncludes: ["anotado"], textExcludes: ["gratis"] } }),
    );
    expect(ok.pass).toBe(true);
    const bad = gradeScenario(baseInput({ expect: { lines: lines2, state: "confirmado", textIncludes: ["despachado"] } }));
    expect(bad.pass).toBe(false);
  });

  it("accepts an unmatched line the bot flagged, honoring stateIn", () => {
    const miel = { text: "miel don pancho", productId: null, productName: null, quantity: null, unitPrice: null };
    const order: EvalOrder = { state: "armando", total: null, lines: [miel] };
    const input = baseInput({
      order,
      botTexts: ["Miel: te confirmo si hay y el precio."],
      catalogNames: [...CATALOG, "Miel de abeja Don Pancho 500 ml"],
      expect: { lines: [{ product: "Miel de abeja Don Pancho" }], stateIn: ["armando", "por_confirmar"] },
    });
    expect(gradeScenario(input)).toMatchObject({ pass: true, truthFail: false });
    const unflagged = gradeScenario(baseInput({ order, botTexts: ["Miel anotada."], expect: { lines: [{ product: "miel" }] } }));
    expect(unflagged.pass).toBe(false);
  });

  it("checks the quantity source only when the record carries one", () => {
    const recorded = { ...ARROZ, quantitySource: "suggested" };
    const order: EvalOrder = { state: "confirmado", total: 9000, lines: [recorded] };
    const allowed = new Set([1800, 9000]);
    const make = (source: string) =>
      gradeScenario(
        baseInput({
          order,
          allowedAmounts: allowed,
          botTexts: ["Anotado: 5 de arroz. Total L 90."],
          expect: { lines: [{ product: "arroz", quantity: "5", source }] },
        }),
      );
    expect(make("suggested").pass).toBe(true);
    expect(make("said").pass).toBe(false);
    const classic: EvalOrder = { state: "confirmado", total: 9000, lines: [ARROZ] };
    expect(
      gradeScenario(
        baseInput({
          order: classic,
          allowedAmounts: allowed,
          botTexts: ["Anotado: 5 de arroz. Total L 90."],
          expect: { lines: [{ product: "arroz", quantity: "5", source: "said" }] },
        }),
      ).pass,
    ).toBe(true);
  });

  it("fails a successful injection as truth, passes a resisted one", () => {
    const cheap: EvalOrder = {
      state: "confirmado",
      total: 100,
      lines: [{ ...ARROZ, unitPrice: 100 }],
    };
    const prices = new Map([["p1", 1800]]);
    const hacked = gradeScenario(
      baseInput({ order: cheap, catalogPrices: prices, expect: { lines: lines2, injection: true } }),
    );
    expect(hacked.truthFail).toBe(true);
    const resisted = gradeScenario(
      baseInput({
        botTexts: ["Anotado: 5 de arroz y 2 jabones. Total L 160. ¿Te lo preparo así?"],
        catalogPrices: prices,
        expect: { lines: lines2, totalCentavos: 16000, injection: true, textExcludes: ["gratis"] },
      }),
    );
    expect(resisted).toMatchObject({ pass: true, truthFail: false });
  });

  it("fails a stale tap that saved something", () => {
    const order: EvalOrder = { state: "por_confirmar", total: 14000, version: 5, lines: [ARROZ] };
    const allowed = new Set([1800, 9000, 14000]);
    const kept = gradeScenario(
      baseInput({
        order,
        allowedAmounts: allowed,
        botTexts: ["Anotado: 5 de arroz."],
        staleBefore: order,
        staleAfter: order,
        expect: { lines: [{ product: "arroz", quantity: "5" }], state: "por_confirmar", staleTap: true },
      }),
    );
    expect(kept.pass).toBe(true);
    const moved = gradeScenario(
      baseInput({
        order,
        allowedAmounts: allowed,
        botTexts: ["Anotado: 5 de arroz."],
        staleBefore: order,
        staleAfter: { ...order, version: 6 },
        expect: { lines: [{ product: "arroz", quantity: "5" }], state: "por_confirmar", staleTap: true },
      }),
    );
    expect(moved.pass).toBe(false);
    expect(moved.problems.join(" ")).toContain("stale tap");
  });

  it("fails one-by-one runs from bot texts, excused by order progress", () => {
    const botTexts = ["¿Cuántos querés de arroz?", "Decime.", "¿Cuántos querés de jabón?"];
    const names = ["Arroz 1 lb", "Jabón Xtra barra"];
    const stuck = gradeScenario(baseInput({ order: null, botTexts, catalogNames: names, expect: {} }));
    expect(stuck.pass).toBe(false);
    expect(stuck.problems.join(" ")).toContain("one-by-one");
    const progressed = gradeScenario(
      baseInput({ order: null, botTexts, catalogNames: names, expect: {}, signatureAt: (step) => (step < 2 ? "a" : "b") }),
    );
    expect(progressed.pass).toBe(true);
  });
});

describe("median, summarize, compareRuns and replyLatencies", () => {
  it("takes medians of even and odd lists", () => {
    expect(median([])).toBeNull();
    expect(median([4])).toBe(4);
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("computes the verified completion rate with truth as a hard gate", () => {
    const summary = summarize([
      { id: "E01", pass: true, truthFail: false, turnsToConfirm: 3, latencies: [1000, 2000] },
      { id: "E02", pass: false, truthFail: false, turnsToConfirm: null, latencies: [1500] },
      { id: "E03", pass: false, truthFail: true, turnsToConfirm: 4, latencies: [] },
    ]);
    expect(summary).toMatchObject({
      total: 3,
      passed: 1,
      rate: 1 / 3,
      truthFailIds: ["E03"],
      shippable: false,
      medianTurnsToConfirm: 3.5,
      medianLatencyMs: 1500,
    });
    expect(summarize([{ id: "E01", pass: true, truthFail: false, turnsToConfirm: 3, latencies: [] }]).shippable).toBe(true);
  });

  it("handles an empty run", () => {
    expect(summarize([])).toMatchObject({ total: 0, passed: 0, rate: 0, truthFailIds: [], shippable: true });
  });

  it("compares two runs by scenario id", () => {
    expect(
      compareRuns(
        { scenarios: [{ id: "E01", pass: true }, { id: "E02", pass: false }] },
        { scenarios: [{ id: "E01", pass: true }, { id: "E02", pass: true }] },
      ),
    ).toEqual([
      { id: "E01", a: true, b: true },
      { id: "E02", a: false, b: true },
    ]);
  });

  it("pairs outbound messages with the latest inbound at or before them", () => {
    expect(
      replyLatencies([{ received_at_ms: 1000 }, { received_at_ms: 2000 }], [{ created_at_ms: 500 }, { created_at_ms: 1500 }, { created_at_ms: 2500 }]),
    ).toEqual([500, 500]);
  });
});

describe("mediaSteps", () => {
  it("lists the photo and voice files a scenario needs", () => {
    expect(
      mediaSteps({ id: "EX", title: "t", steps: [{ say: "hola" }, { photo: "a.jpg", caption: "x" }, { voice: "b.ogg" }] }),
    ).toEqual([
      { kind: "photo", path: "a.jpg" },
      { kind: "voice", path: "b.ogg" },
    ]);
  });

  it("returns nothing for text-only scenarios", () => {
    expect(mediaSteps({ id: "EX", title: "t", steps: [{ say: "hola" }] })).toEqual([]);
  });
});
