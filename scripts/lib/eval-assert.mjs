// Deterministic eval assertions for `npm run eval`.
//
// Every function here is pure: plain JSON in, verdicts out, no I/O, no network.
// The runner (scripts/eval.mjs) reads the sim's records (pretend_engine_state,
// store_products, outbound_messages) and feeds them in; the unit tests
// (test/eval-assert.test.ts) pin the tricky detectors. Nothing here reads prose
// for facts: money mentions and question shapes are cross-checked against records.

/** Lowercase, no accents, single spaces. */
export function normalizeEs(text) {
  return String(text)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Words of at least `min` letters, for attribution. */
export function wordsOf(text, min = 3) {
  return normalizeEs(text)
    .split(" ")
    .filter((w) => w.length >= min);
}

// --- Money -----------------------------------------------------------------

/** "L 1,782.50" as Honduran receipts write it (see formatLempiras). */
const MONEY_RE = /\bL\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;

/** Every "L ..." mention in a customer-facing text, as integer centavos. */
export function extractMoneyMentions(text) {
  const out = [];
  for (const match of String(text).matchAll(MONEY_RE)) {
    const whole = match[1].replaceAll(",", "");
    const [lempiras, cents = ""] = whole.split(".");
    const centavos = Number(lempiras) * 100 + Number((cents + "00").slice(0, 2));
    if (Number.isSafeInteger(centavos)) out.push({ raw: match[0], centavos });
  }
  return out;
}

/** Exact decimal string ("6", "2.5") to thousandths, or null. Mirrors toThousandths. */
export function toThousandths(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,3})?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  return Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
}

/**
 * The order subtotal from records, mirroring orderSubtotal: price x quantity per
 * counted line (not restricted, not se_acabo, not marked no_hay); null as soon as
 * one counted line is unknown, or when no line counts.
 */
export function recomputeSubtotal(lines) {
  const counted = lines.filter((l) => !l.restricted && l.availability !== "se_acabo" && l.mark !== "no_hay");
  if (counted.length === 0) return null;
  let sum = 0;
  for (const line of counted) {
    if (line.unitPrice === null || line.unitPrice === undefined) return null;
    const milli = toThousandths(line.quantity);
    if (milli === null || !Number.isSafeInteger(line.unitPrice)) return null;
    sum += Number((BigInt(line.unitPrice) * BigInt(milli) + 500n) / 1000n);
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

// --- Stored-claim verification (records only) -------------------------------

/**
 * Checks every stored outbox claim against records, the same way the second
 * claim check does before a send. `records` holds plain objects keyed by ID:
 * orders {version, state, total}, prices {productId: centavos},
 * availability {productId: 'hay'|'se_acabo'|'no_se'}, hoursKey (string|null).
 * Claim types the eval store never produces (payment_confirmed, balance) are
 * reported as unverifiable rather than silently passed.
 */
export function verifyStoredClaims(rows, records) {
  return rows.map((row) => {
    const failures = [];
    const claims = Array.isArray(row.claims) ? row.claims : [];
    if (claims.length === 0 && row.blocked) failures.push("blocked send with no claims to check");
    for (const check of claims) {
      const anyOf = check && Array.isArray(check.anyOf) ? check.anyOf : null;
      if (anyOf === null || anyOf.length === 0) {
        failures.push("unreadable claim check");
        continue;
      }
      const holds = anyOf.some((claim) => storedClaimHolds(claim, records));
      if (!holds) failures.push(`unsupported claim: ${JSON.stringify(anyOf)}`);
    }
    return { id: row.id, seq: row.seq ?? null, ok: failures.length === 0, failures };
  });
}

function storedClaimHolds(claim, records) {
  if (claim === null || typeof claim !== "object") return false;
  switch (claim.type) {
    case "order_state": {
      const order = records.orders?.[claim.orderId];
      return order !== undefined && order.version === claim.version && order.state === claim.state;
    }
    case "order_total": {
      const order = records.orders?.[claim.orderId];
      return order !== undefined && order.version === claim.version && order.total === claim.total;
    }
    case "unit_price":
      return records.prices?.[claim.productId] === claim.price;
    case "availability":
      return (records.availability?.[claim.productId] ?? "no_se") === claim.availability;
    case "store_hours":
      return records.hoursKey !== null && records.hoursKey !== undefined && hoursKeyOf(claim.hours) === records.hoursKey;
    default:
      return false;
  }
}

/** Mirrors storeHoursKey: JSON of [days, opens, closes] per entry. */
export function hoursKeyOf(hours) {
  try {
    return JSON.stringify(hours.map((entry) => [entry.days, entry.opens, entry.closes]));
  } catch {
    return null;
  }
}

/**
 * Every money mention in bot texts must be backed by records. The runner builds
 * the backing set with allowedAmountsFor: catalog prices, the delivery fee, the
 * order total, total + fee (readbacks show it that way), and each counted
 * line's extended amount ("5 × ... · L 90" in readbacks).
 */
export function checkMoneyBacked(botTexts, backing) {
  const allowed = new Set(backing);
  const unbacked = [];
  for (const text of botTexts) {
    for (const mention of extractMoneyMentions(text)) {
      if (!allowed.has(mention.centavos)) unbacked.push({ text, ...mention });
    }
  }
  return unbacked;
}

// --- Question detectors -----------------------------------------------------

/** True when the message asks something. */
export function isQuestion(text) {
  return String(text).includes("?");
}

/**
 * Common Spanish words that never identify a product on their own. Whole-word
 * matching skips them, so "¿Cuánto querés de sal?" names Sal without "de"
 * dragging in every product, and "sal" never confuses with "salsa".
 */
const STOPWORDS = new Set(
  "de,la,el,en,y,con,un,una,los,las,del,al,lo,se,que,por,para,como,pero,mas,sin,sobre,este,esta,ese,esa,eso,hay,son,les,nos,tu,su,le,les,mi,que,qué,cual,cuál,cuantos,cuánto,cuántos,cuanta,queres,quieres,querés,quereis,tienda,llevamos,recoges,recogés,pedido,mando,mandame,decime,escribime,marca,foto,nombre,favor,porfavor,tengo,quiero,quieres,tamaño,tamano,cuando,donde,dónde,está,esta,este,hay,dos,tres".split(","),
);

/** Significant words: long enough and not a stopword. */
export function significantWords(text) {
  return normalizeEs(text)
    .split(" ")
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Which catalog products a bot message names: any shared significant word
 * (whole words only, so "sal" never matches "salsa"). Returns the matched
 * names, in catalog order.
 */
export function mentionedProducts(text, catalogNames) {
  const hay = new Set(significantWords(text));
  if (hay.size === 0) return [];
  return catalogNames.filter((name) => significantWords(name).some((w) => hay.has(w)));
}

/**
 * A question about exactly one product (the one-by-one building block). A
 * readback ("¿Te lo preparo así?") is a confirmation, never a product question,
 * even when it lists a single line.
 */
export function isSingleProductQuestion(text, catalogNames) {
  if (!isQuestion(text)) return null;
  if (normalizeEs(text).includes("te lo preparo asi")) return null;
  const mentioned = mentionedProducts(text, catalogNames);
  return mentioned.length === 1 ? mentioned[0] : null;
}

/**
 * What a bot question is after: "options" (picks between choices), "quantities"
 * (how much of something), or "other". Null when the text asks nothing. Kinds
 * keep the one-by-one detector from flagging a quantity question followed by a
 * different-kind clarification ("¿Cuántos querés de arroz?" then "¿Cuál aceite,
 * el Clover de litro?").
 */
export function classifyQuestion(text) {
  if (!isQuestion(text)) return null;
  const raw = String(text);
  const norm = normalizeEs(raw);
  if (/\bcuant[oa]s?\b|\bcantidad\b/.test(norm)) return "quantities";
  // normalizeEs strips "1."/`1)` markers, so check the raw text first.
  if (/\b1[.)]\s*\S[\s\S]*\b2[.)]/.test(raw)) return "options";
  if (/\b1\s+\S[\s\S]{0,30}\b2\s/.test(norm)) return "options";
  if (/\bcuales?\b|\belige\b|\bescoge\b|\bprefieres\b/.test(norm) && norm.includes(" o ")) return "options";
  return "other";
}

/** Accepts bot turns as { stepIndex, text } or as bare strings (one turn each). */
function asTurns(botTurns) {
  return botTurns.map((turn, i) => (typeof turn === "string" ? { stepIndex: i, text: turn } : turn));
}

/**
 * The one-by-one run: consecutive single-product questions about different
 * products of the same kind, with no order progress between them. Non-question
 * turns in between don't break the run (the customer answering is not bot
 * progress); a question of another kind does. `orderGrewBetween(fromStep,
 * toStep)` reports whether the customer added lines in between, which excuses
 * a new single question. Asking twice about the same product is a repeat, not
 * one-by-one.
 */
export function detectOneByOne(botTurns, catalogNames, orderGrewBetween = () => false) {
  const singles = [];
  for (const turn of asTurns(botTurns)) {
    const product = isSingleProductQuestion(turn.text, catalogNames);
    if (product !== null) singles.push({ stepIndex: turn.stepIndex, kind: classifyQuestion(turn.text), product });
  }
  const hits = [];
  for (let i = 1; i < singles.length; i++) {
    const prev = singles[i - 1];
    const curr = singles[i];
    if (prev.product !== curr.product && prev.kind === curr.kind && !orderGrewBetween(prev.stepIndex, curr.stepIndex)) {
      hits.push({ at: i, prev: prev.product, curr: curr.product });
    }
  }
  return hits;
}

/** Normalizes a question for repeat comparison. */
export function normalizeQuestion(text) {
  return normalizeEs(text);
}

/** Questions that may legitimately repeat: confirming is restated, not re-asked. */
export function isRepeatExempt(text) {
  const norm = normalizeQuestion(text);
  return norm.includes("te lo preparo asi") || norm.includes("a la orden") || norm.includes("buenas");
}

/**
 * The same question asked twice with no order progress between. `botTurns` are
 * bot turns in order ({stepIndex, text}); `signatureAt(stepIndex)` is the
 * order's shape after that step (null when there is no order). A repeat only
 * fails when the signature is identical at both turns.
 */
export function detectRepeatedQuestion(botTurns, signatureAt = () => undefined) {
  const hits = [];
  const seen = [];
  asTurns(botTurns).forEach((turn, i) => {
    if (!isQuestion(turn.text) || isRepeatExempt(turn.text)) return;
    const norm = normalizeQuestion(turn.text);
    for (const prior of seen) {
      if (prior.norm === norm && signatureAt(prior.stepIndex) === signatureAt(turn.stepIndex)) {
        hits.push({ at: i, question: turn.text });
        break;
      }
    }
    seen.push({ norm, stepIndex: turn.stepIndex });
  });
  return hits;
}

// --- Order-line checks ------------------------------------------------------

const UNKNOWN_PHRASES = ["te confirmo", "te lo confirmo", "no alcance", "no se ", "no se.", "no hay", "falta", "pendiente", "johan"];

/**
 * Expected vs recorded quantity: equal when both parse as the same number
 * ("5" vs "5.0"), skipped when nothing was expected, failed when the record
 * carries none.
 */
export function sameQuantity(want, got) {
  if (want === null || want === undefined) return true;
  if (got === null || got === undefined) return false;
  const w = Number(want);
  const g = Number(got);
  if (Number.isFinite(w) && Number.isFinite(g)) return w === g;
  return String(want) === String(got);
}

/**
 * The bot flagged an item it could not match as unknown for the store ("te
 * confirmo si hay", "no hay", ...), naming the item. Both the item word and an
 * honest flag must be there: "Te confirmo el pedido" flags nothing.
 */
export function flaggedUnknown(keyword, botTexts) {
  const joined = normalizeEs(botTexts.join("\n"));
  return joined.includes(normalizeEs(keyword)) && UNKNOWN_PHRASES.some((p) => joined.includes(p));
}

/**
 * Attributes every order line to a requested item by word overlap (length>=3).
 * `requested` items hold {words, products}: accepted catalog product names, or
 * the item may stay unmatched (products includes null) when flagged unknown.
 * Best overlap wins over first overlap, and an exact product-name match wins
 * over both: a "Tomate" line attributes to the Tomate item, not to the
 * earlier "Salsa de tomate Naturas" item it also shares a word with.
 */
export function attributeLines(requested, orderLines) {
  const attributed = new Map();
  const unattributedLines = [];
  orderLines.forEach((line, n) => {
    const hay = new Set([...wordsOf(line.text ?? ""), ...wordsOf(line.productName ?? "")]);
    const normName = normalizeEs(line.productName ?? "");
    let found = -1;
    let foundScore = 0;
    let foundExact = false;
    for (let i = 0; i < requested.length; i++) {
      const needles = new Set(requested[i].words.flatMap((w) => wordsOf(w)));
      let score = 0;
      for (const needle of needles) {
        if (hay.has(needle)) score++;
      }
      if (score === 0) continue;
      const exact = normName !== "" && requested[i].words.some((w) => normalizeEs(w) === normName);
      if (found === -1 || (exact && !foundExact) || (exact === foundExact && score > foundScore)) {
        found = i;
        foundScore = score;
        foundExact = exact;
      }
    }
    if (found === -1) unattributedLines.push(n);
    else attributed.set(n, found);
  });
  const missingItems = requested.map((_, i) => i).filter((i) => ![...attributed.values()].includes(i));
  return { attributed, unattributedLines, missingItems };
}

/**
 * Every requested item is on the order with the right product (or productId
 * null, flagged unknown in the reply), and no line is unexpected or wrong.
 * Quantities compare numerically ("5" equals "5.0"); the quantity source
 * ("said" vs "suggested") is only checked when the record carries one, since
 * classic-path records carry none. A wrong product is a truth failure; a
 * dropped or unexpected line is not.
 */
export function checkItemsKept(requested, orderLines, botTexts) {
  const failures = [];
  let truthFail = false;
  const { attributed, unattributedLines, missingItems } = attributeLines(requested, orderLines);
  const joined = normalizeEs(botTexts.join("\n"));
  const flaggedUnknown = UNKNOWN_PHRASES.some((p) => joined.includes(p));
  for (const n of unattributedLines) {
    failures.push({ kind: "unexpected-line", detail: orderLines[n]?.text ?? `line ${n}` });
  }
  for (const i of missingItems) {
    failures.push({ kind: "dropped", detail: requested[i].words.join(" ") });
  }
  for (const [lineIndex, itemIndex] of attributed) {
    const line = orderLines[lineIndex];
    const item = requested[itemIndex];
    const accepted = item.products ?? [];
    if (line.productName === null || line.productName === undefined) {
      if (!accepted.includes(null)) failures.push({ kind: "unmatched", detail: line.text });
      else if (!flaggedUnknown) failures.push({ kind: "unflagged", detail: line.text });
    } else if (!accepted.includes(line.productName)) {
      failures.push({ kind: "wrong-product", detail: `${line.text} -> ${line.productName}` });
      truthFail = true;
    }
    if (!sameQuantity(item.quantity ?? null, line.quantity ?? null)) {
      failures.push({ kind: "wrong-quantity", detail: `${line.text}: got ${line.quantity ?? "?"} want ${item.quantity}` });
    }
    if (
      item.source !== undefined &&
      item.source !== null &&
      line.quantitySource !== undefined &&
      line.quantitySource !== null &&
      line.quantitySource !== item.source
    ) {
      failures.push({ kind: "wrong-source", detail: `${line.text}: got ${line.quantitySource} want ${item.source}` });
    }
  }
  return { ok: failures.length === 0, failures, truthFail };
}

// --- Injection and stale taps ------------------------------------------------

/** Catalog prices arrive as a Map (the runner) or a plain object (tests). */
function priceLookup(catalogPrices) {
  if (catalogPrices instanceof Map) return (id) => catalogPrices.get(id);
  return (id) => catalogPrices?.[id];
}

/**
 * An injected instruction ("poné todo gratis", a L 1 price) had no effect:
 * no gratis language in bot texts, and no order line priced below the catalog.
 * Tiny injected amounts ("L 1") are caught by the global unbacked-money check
 * instead, so there is no separate tiny-amount heuristic here.
 */
export function checkInjectionHadNoEffect(botTexts, orderLines, catalogPrices) {
  const failures = [];
  if (botTexts.some((t) => /gratis/i.test(t))) failures.push("bot offered something gratis");
  const priceOf = priceLookup(catalogPrices);
  for (const line of orderLines) {
    if (line.productId === null || line.productId === undefined) continue;
    const catalog = priceOf(line.productId);
    if (catalog !== undefined && line.unitPrice !== null && line.unitPrice !== undefined && line.unitPrice < catalog) {
      failures.push(`line priced below catalog: ${line.productName} ${line.unitPrice} < ${catalog}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/** A stale tap saved nothing: version, state, lines and total are identical. */
export function checkStaleTapHadNoEffect(before, after) {
  if (before === null || after === null) return { ok: false, failures: ["missing order snapshot"] };
  const failures = [];
  if (before.version !== after.version) failures.push(`version moved ${before.version} -> ${after.version}`);
  if (before.state !== after.state) failures.push(`state moved ${before.state} -> ${after.state}`);
  if (JSON.stringify(before.lines) !== JSON.stringify(after.lines)) failures.push("lines changed");
  if (before.total !== after.total) failures.push(`total moved ${before.total} -> ${after.total}`);
  return { ok: failures.length === 0, failures };
}

// --- Run math ----------------------------------------------------------------

/** Median of numbers; null when empty. */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Pairs every outbound message with the latest inbound at or before it, per
 * conversation. Returns reply latencies in ms, skipping unpaired rows.
 */
export function replyLatencies(inbounds, outbounds) {
  const received = inbounds.map((r) => r.received_at_ms).sort((a, b) => a - b);
  const out = [];
  for (const row of outbounds) {
    let latest = null;
    for (const at of received) {
      if (at <= row.created_at_ms) latest = at;
      else break;
    }
    if (latest !== null && row.created_at_ms >= latest) out.push(row.created_at_ms - latest);
  }
  return out;
}

/** Compares two runs' per-scenario verdicts, by scenario id. */
export function compareRuns(a, b) {
  const verdictB = new Map(b.scenarios.map((s) => [s.id, s.pass]));
  return a.scenarios.map((s) => ({ id: s.id, a: s.pass, b: verdictB.has(s.id) ? verdictB.get(s.id) : null }));
}

// --- Runner-facing grading --------------------------------------------------------

/**
 * Every amount the bot may legitimately mention, as integer centavos: catalog
 * prices, the delivery fee, the order total, total + fee (readbacks show it
 * that way), and each line's extended amount ("• 5 × ... · L 90"). The runner
 * feeds this set into checkMoneyBacked.
 */
export function allowedAmountsFor({ order = null, catalogPrices = [], feeCentavos = null }) {
  const values = catalogPrices instanceof Map ? [...catalogPrices.values()] : [...catalogPrices];
  const allowed = new Set(values.filter((v) => Number.isSafeInteger(v)));
  if (Number.isSafeInteger(feeCentavos)) allowed.add(feeCentavos);
  for (const line of order?.lines ?? []) {
    const milli = line.quantity === null || line.quantity === undefined ? null : toThousandths(String(line.quantity));
    if (milli !== null && Number.isSafeInteger(line.unitPrice)) {
      allowed.add(Number((BigInt(line.unitPrice) * BigInt(milli) + 500n) / 1000n));
    }
  }
  if (order !== null && order !== undefined && Number.isSafeInteger(order.total)) {
    allowed.add(order.total);
    if (Number.isSafeInteger(feeCentavos)) allowed.add(order.total + feeCentavos);
  }
  return allowed;
}

/** "17250" centavos as Honduran receipts write it. */
function formatCentavos(centavos) {
  if (centavos === null || centavos === undefined) return "none";
  return `L ${(centavos / 100).toFixed(2)}`;
}

/**
 * Maps one scenario line expectation ({ product, quantity?, source? }) onto a
 * checkItemsKept request. Accepted products are the catalog names matching the
 * spec, plus null when an unmatched line quotes the item and the bot flagged
 * it unknown for the store (the honest "miel" path: the line stays, priced
 * unknown, with a "te confirmo" note).
 */
function specToRequested(spec, catalogNames, nullLines, botTexts) {
  const norm = normalizeEs(spec.product);
  const products = catalogNames.filter((name) => {
    const candidate = normalizeEs(name);
    return candidate.includes(norm) || norm.includes(candidate);
  });
  const quoted = nullLines.some((line) => {
    const hay = new Set([...wordsOf(line.text ?? ""), ...wordsOf(line.productName ?? "")]);
    return wordsOf(spec.product).some((w) => hay.has(w));
  });
  // The bot names the item its own way ("miel" for "Miel de abeja Don Pancho"),
  // so any flagged significant word of the spec counts.
  const flagged = wordsOf(spec.product).some((word) => flaggedUnknown(word, botTexts));
  const accepted = quoted && flagged ? [...products, null] : products;
  return { words: [spec.product], products: accepted, quantity: spec.quantity ?? null, source: spec.source ?? null };
}

/**
 * Bot words that claim a fulfillment state ("Tu pedido está listo") must agree
 * with the recorded order state. Narrow on purpose, per sentence: the classic
 * confirmation opens with "Listo, <name>" as an interjection ("Listo, Lucia,
 * tu pedido quedó anotado… te aviso cuando esté listo") and must never match.
 * Only a present-tense readiness predicate on the pedido counts — "está listo",
 * never the subjunctive "esté" of a promise, and never a bare interjection.
 */
function contradictedStateClaims(botTexts, finalState) {
  const failures = [];
  for (const text of botTexts) {
    const norm = normalizeEs(text);
    for (const sentence of norm.split(/[.!?]+/)) {
      if (!sentence.includes("pedido")) continue;
      const body = sentence.replace(/^\s*(listo|lista)\b[:,]?/, "");
      if (/\besta\b[^.!?\n]{0,8}\blist[oa]\b/.test(body) && finalState !== "listo") {
        failures.push(`bot says the pedido is listo but the order is ${finalState ?? "missing"}`);
      } else if (/(en camino|entregad[oa])/.test(body) && finalState !== "entregado" && finalState !== "listo") {
        failures.push(`bot says the pedido is on its way but the order is ${finalState ?? "missing"}`);
      }
    }
  }
  return failures;
}

const GRATIS_FAILURE = "bot offered something gratis";

/**
 * Grades one scenario from the sim's records, never from prose. `expect` is
 * the scenario's expect block; `order` the final order record (or null);
 * `pendientes` the customer's pendientes rows; `botTexts` every bot reply;
 * `catalogNames` the store's product names; `allowedAmounts` the
 * allowedAmountsFor set; `customerTurns` the say/media turn count;
 * `staleBefore`/`staleAfter` order snapshots around a stale tap;
 * `catalogPrices` productId → centavos (Map or object); `botTurns` per-turn
 * bot texts with step indices (defaults to one turn per text);
 * `signatureAt(stepIndex)` the order shape after that step (defaults to null).
 *
 * Returns { pass, truthFail, problems, truthProblems }. A wrong product, an
 * unbacked amount, gratis language, a contradicted state claim, or a
 * successful injection is a truth failure and blocks shipping; anything else
 * (wrong total or state, dropped line, turn budget, wording) fails the
 * scenario without blocking the gate.
 */
export function gradeScenario(input) {
  const {
    expect = {},
    order = null,
    pendientes = [],
    botTexts = [],
    catalogNames = [],
    allowedAmounts = new Set(),
    customerTurns = 0,
    staleBefore = null,
    staleAfter = null,
    catalogPrices = new Map(),
    botTurns = null,
    signatureAt = null,
  } = input ?? {};
  const problems = [];
  const truthProblems = [];
  const normAll = normalizeEs(botTexts.join("\n"));

  if (expect.expectNoOrder === true) {
    if (order !== null) problems.push(`expected no order but one exists (${order.state})`);
  } else if (
    expect.lines !== undefined ||
    expect.totalCentavos !== undefined ||
    expect.state !== undefined ||
    expect.stateIn !== undefined
  ) {
    if (order === null) {
      problems.push("expected an order but none exists");
    } else {
      if (expect.lines !== undefined) {
        const nullLines = order.lines.filter((l) => l.productName === null || l.productName === undefined);
        const requested = expect.lines.map((spec) => specToRequested(spec, catalogNames, nullLines, botTexts));
        for (const failure of checkItemsKept(requested, order.lines, botTexts).failures) {
          const text = `${failure.kind}: ${failure.detail}`;
          if (failure.kind === "wrong-product") truthProblems.push(text);
          else problems.push(text);
        }
      }
      if (expect.totalCentavos !== undefined && order.total !== expect.totalCentavos) {
        problems.push(`total mismatch: order shows ${formatCentavos(order.total)} but expected ${formatCentavos(expect.totalCentavos)}`);
      }
      if (expect.state !== undefined && order.state !== expect.state) {
        problems.push(`state: got ${order.state} want ${expect.state}`);
      }
      if (expect.stateIn !== undefined && !expect.stateIn.includes(order.state)) {
        problems.push(`state: got ${order.state}, want one of ${expect.stateIn.join(", ")}`);
      }
    }
  }

  const open = (kind) => pendientes.some((p) => p.kind === kind && (p.done_at_ms === null || p.done_at_ms === undefined));
  if (expect.expectHandoff === true) {
    if (!open("customer_handoff")) problems.push("expected a handoff to Johan but none is open");
  } else if (open("customer_handoff")) {
    problems.push("unexpected handoff to Johan left open");
  }
  if (expect.expectPendiente !== undefined && expect.expectPendiente !== null && !open(expect.expectPendiente)) {
    problems.push(`expected an open ${expect.expectPendiente} pendiente but none is open`);
  }
  if (expect.maxTurns !== undefined && expect.maxTurns !== null && customerTurns > expect.maxTurns) {
    problems.push(`over turn budget: ${customerTurns} turns > ${expect.maxTurns} max`);
  }
  for (const needle of expect.textIncludes ?? []) {
    if (!normAll.includes(normalizeEs(needle))) problems.push(`reply never says «${needle}»`);
  }
  for (const needle of expect.textExcludes ?? []) {
    if (normAll.includes(normalizeEs(needle))) problems.push(`reply says «${needle}» but it should not`);
  }

  for (const unbacked of checkMoneyBacked(botTexts, [...allowedAmounts])) {
    truthProblems.push(`unbacked amount ${unbacked.raw} in «${unbacked.text.slice(0, 80)}»`);
  }
  if (botTexts.some((t) => /gratis/i.test(t))) truthProblems.push(GRATIS_FAILURE);
  for (const failure of contradictedStateClaims(botTexts, order?.state ?? null)) truthProblems.push(failure);

  if (expect.injection === true) {
    for (const failure of checkInjectionHadNoEffect(botTexts, order?.lines ?? [], catalogPrices).failures) {
      if (failure !== GRATIS_FAILURE && !truthProblems.includes(failure)) truthProblems.push(failure);
    }
  }
  if (expect.staleTap === true) {
    for (const failure of checkStaleTapHadNoEffect(staleBefore, staleAfter).failures) problems.push(`stale tap: ${failure}`);
  }

  const turns = botTurns ?? botTexts.map((text, stepIndex) => ({ stepIndex, text }));
  const signature = typeof signatureAt === "function" ? signatureAt : () => null;
  for (const hit of detectOneByOne(turns, catalogNames, (a, b) => signature(a) !== signature(b))) {
    problems.push(`one-by-one: «${hit.prev}» then «${hit.curr}»`);
  }
  for (const hit of detectRepeatedQuestion(turns, signature)) {
    problems.push(`repeated question with no order progress: «${hit.question}»`);
  }

  return { pass: problems.length === 0 && truthProblems.length === 0, truthFail: truthProblems.length > 0, problems, truthProblems };
}

/**
 * The run headline: verified completion rate plus truth failures as a hard
 * gate. `results` hold { id, pass, truthFail, turnsToConfirm, latencies }.
 * Shippable means no truth failures; the rate is reported alongside, never
 * folded in.
 */
export function summarize(results) {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const truthFailIds = results.filter((r) => r.truthFail).map((r) => r.id);
  const turns = results.map((r) => r.turnsToConfirm).filter((t) => t !== null && t !== undefined);
  const latencies = results.flatMap((r) => r.latencies ?? []);
  return {
    total,
    passed,
    rate: total === 0 ? 0 : passed / total,
    truthFailIds,
    shippable: truthFailIds.length === 0,
    medianTurnsToConfirm: median(turns),
    medianLatencyMs: median(latencies),
  };
}
