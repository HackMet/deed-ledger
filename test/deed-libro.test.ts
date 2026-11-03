import { describe, expect, it } from "vitest";
import type { Claim } from "../src/domain/contract/outcomes";
import {
  type LibroFact,
  type LibroReply,
  type RecordedLine,
  libroRows,
  pairDelivery,
  pairOrderState,
  pairOrderTotal,
  recordedTotalOf,
} from "../src/domain/deed-libro";

const fact = (over: Partial<LibroFact> & Pick<LibroFact, "id" | "kind">): LibroFact => ({
  operationKey: `op:${over.id}`,
  recordedAtMs: 1_000,
  version: 1,
  status: null,
  resumeState: null,
  live: true,
  witness: null,
  ...over,
});

const reply = (over: Partial<LibroReply> & Pick<LibroReply, "id" | "claims">): LibroReply => ({
  atMs: 2_000,
  status: "sent",
  providerStatus: null,
  providerStatusAtS: null,
  ...over,
});

const line = (over: Partial<RecordedLine> = {}): RecordedLine => ({ version: 1, counted: true, unitPrice: 1000, quantity: "2", ...over });

const listo = (version = 1): Claim => ({ type: "order_state", orderId: "o1", version, state: "listo" });

describe("pairOrderState: a claim of state pairs with the live fact of that state and version", () => {
  it("is emparejado when the live fact records the claimed state at the claimed version", () => {
    const facts = [fact({ id: "f-ready", kind: "order_status", status: "ready", version: 2 })];
    const found = pairOrderState({ version: 2, state: "listo" }, facts);
    expect(found.state).toBe("emparejado");
    expect(found.fact?.id).toBe("f-ready");
  });

  it("is sin pareja when no fact records the claimed state", () => {
    const found = pairOrderState({ version: 1, state: "listo" }, [fact({ id: "f-v", kind: "order_version" })]);
    expect(found).toEqual({ state: "sin_pareja", fact: null });
  });

  it("is sin pareja when the fact that records the state is closed", () => {
    const facts = [fact({ id: "f-ready", kind: "order_status", status: "ready", version: 1, live: false })];
    const found = pairOrderState({ version: 1, state: "listo" }, facts);
    expect(found.state).toBe("sin_pareja");
    expect(found.fact?.id).toBe("f-ready");
  });

  it("ignores the version: a fact of another version never pairs", () => {
    const facts = [fact({ id: "f-ready-v1", kind: "order_status", status: "ready", version: 1 })];
    expect(pairOrderState({ version: 2, state: "listo" }, facts).state).toBe("sin_pareja");
  });

  it("pairs a cancelled claim with the live cancel of the order, whatever version was said", () => {
    const facts = [fact({ id: "f-cancel", kind: "order_cancel", version: null })];
    expect(pairOrderState({ version: 3, state: "cancelado" }, facts).state).toBe("emparejado");
  });

  it("reads a confirm that resumed into preparando as the state preparando", () => {
    const facts = [fact({ id: "f-confirm", kind: "order_confirm", resumeState: "preparando", version: 1 })];
    expect(pairOrderState({ version: 1, state: "preparando" }, facts).state).toBe("emparejado");
    expect(pairOrderState({ version: 1, state: "confirmado" }, facts).state).toBe("sin_pareja");
  });
});

describe("pairOrderTotal: the total said pairs with the total recorded for its version", () => {
  it("is emparejado when the two are equal", () => {
    expect(pairOrderTotal(2000, 2000)).toBe("emparejado");
  });

  it("is sin pareja (the balance box) when the two differ", () => {
    expect(pairOrderTotal(2000, 1500)).toBe("sin_pareja");
  });

  it("is en duda when the recorded total is unknown, never red", () => {
    expect(pairOrderTotal(2000, null)).toBe("en_duda");
  });
});

describe("recordedTotalOf: the total of a version from its lines", () => {
  it("sums the counted lines, price times quantity", () => {
    expect(recordedTotalOf([line({ unitPrice: 1000, quantity: "2" }), line({ unitPrice: 250, quantity: "1.5" })])).toBe(2375);
  });

  it("is null when a counted line has no confirmed price, never a partial total", () => {
    expect(recordedTotalOf([line(), line({ unitPrice: null })])).toBeNull();
  });

  it("leaves out lines that do not count, and is null when none counts", () => {
    expect(recordedTotalOf([line({ counted: false, unitPrice: null })])).toBeNull();
    expect(recordedTotalOf([line(), line({ counted: false, unitPrice: 9999 })])).toBe(2000);
  });
});

describe("pairDelivery: a reply ↔ its delivery; silence is never red", () => {
  it.each(["delivered", "read", "played"] as const)("is emparejado when the provider reports %s", (providerStatus) => {
    expect(pairDelivery({ status: "sent", providerStatus })).toBe("emparejado");
  });

  it.each(["failed", "expired", "unknown_delivery"])("is sin pareja when the row ended unsent (%s)", (status) => {
    expect(pairDelivery({ status, providerStatus: null })).toBe("sin_pareja");
  });

  it("is sin pareja when the provider reports failed", () => {
    expect(pairDelivery({ status: "sent", providerStatus: "failed" })).toBe("sin_pareja");
  });

  it("is en duda when the reply has no delivery status yet", () => {
    expect(pairDelivery({ status: "sent", providerStatus: null })).toBe("en_duda");
    expect(pairDelivery({ status: "sent", providerStatus: "sent" })).toBe("en_duda");
  });

  it("is never red for silence: no status, in any row state that is not unsent", () => {
    for (const status of ["pending", "sending", "sent", "waiting_window"]) {
      expect(pairDelivery({ status, providerStatus: null })).not.toBe("sin_pareja");
    }
  });
});

describe("libroRows: the three lanes, row by row", () => {
  const orderId = "o1";

  it("shows every pair state in one order: emparejado, sin pareja, en duda and bloqueado", () => {
    const rows = libroRows({
      orderId,
      facts: [
        fact({ id: "f-ready", kind: "order_status", status: "ready", version: 1, witness: { kind: "member", refId: "member-1" } }),
        fact({ id: "f-cancel", kind: "order_cancel", version: null, live: false }),
      ],
      lines: [line({ version: 1 })],
      replies: [
        reply({ id: "m1", atMs: 2_000, providerStatus: "delivered", claims: [listo(1)] }),
        reply({ id: "m2", atMs: 3_000, claims: [{ type: "order_total", orderId, version: 1, total: 9999 }] }),
        reply({ id: "m3", atMs: 4_000, status: "failed", claims: [{ type: "order_state", orderId, version: 1, state: "cancelado" }] }),
      ],
      refusals: [{ id: "d1", atMs: 5_000, reason: "invalid_state", decidingFactId: "f-cancel", operationKey: "staff:o1:1:mark_ready" }],
    });
    const states = rows.map((row) => row.state);
    expect(states).toContain("emparejado");
    expect(states).toContain("sin_pareja");
    expect(states).toContain("en_duda");
    expect(states).toContain("bloqueado");
    const balance = rows.find((row) => row.book?.kind === "balance");
    expect(balance?.book?.text).toBe("dijo L 99.99 · registró L 20");
    expect(rows.find((row) => row.book?.kind === "gate")?.book?.text).toBe("Bloqueado: el estado no lo permite");
  });

  it("gives a reply with no delivery status an en duda row, not a red one", () => {
    const rows = libroRows({
      orderId,
      facts: [fact({ id: "f-ready", kind: "order_status", status: "ready" })],
      lines: [],
      replies: [reply({ id: "m1", claims: [listo(1)] })],
      refusals: [],
    });
    const delivery = rows.find((row) => row.world?.kind === "delivery");
    expect(delivery?.state).toBe("en_duda");
    expect(delivery?.world?.text).toBe("Sin confirmación de entrega todavía");
  });

  it("never shows a reply that carries no claim about this order", () => {
    const rows = libroRows({
      orderId,
      facts: [],
      lines: [],
      replies: [
        reply({ id: "m-other", claims: [{ type: "order_state", orderId: "o-other", version: 1, state: "listo" }] }),
        reply({ id: "m-none", claims: [] }),
      ],
      refusals: [],
    });
    expect(rows).toEqual([]);
  });

  it("draws a witnessed fact with its tap as an emparejado row, and an unwitnessed fact with no pair as a row without a state", () => {
    const rows = libroRows({
      orderId,
      facts: [
        fact({ id: "f-dispatch", kind: "order_status", status: "dispatched", witness: { kind: "member", refId: "member-abcdef12" } }),
        fact({ id: "f-version", kind: "order_version", version: 1 }),
      ],
      lines: [],
      replies: [],
      refusals: [],
    });
    const tap = rows.find((row) => row.world?.kind === "tap");
    expect(tap?.state).toBe("emparejado");
    expect(tap?.world?.details).toEqual([
      { term: "Hecho", value: "f-dispatch" },
      { term: "Tocó", value: "member-a" },
    ]);
    expect(rows.find((row) => row.book?.factId === "f-version")?.state).toBeNull();
  });

  it("shows the fact a claim paired with once, not again as its own row", () => {
    const rows = libroRows({
      orderId,
      facts: [fact({ id: "f-ready", kind: "order_status", status: "ready", witness: { kind: "session", refId: "s-1" } })],
      lines: [],
      replies: [reply({ id: "m1", providerStatus: "read", claims: [listo(1)] })],
      refusals: [],
    });
    expect(rows.filter((row) => row.book?.factId === "f-ready")).toHaveLength(1);
    expect(rows.find((row) => row.book?.factId === "f-ready")?.world?.kind).toBe("tap");
  });

  it("names a claim with no fact in the book, in Spanish", () => {
    const rows = libroRows({ orderId, facts: [], lines: [], replies: [reply({ id: "m1", claims: [listo(2)] })], refusals: [] });
    const missing = rows.find((row) => row.book?.kind === "missing");
    expect(missing?.state).toBe("sin_pareja");
    expect(missing?.book?.text).toBe("Dijo listo, el libro no lo tiene");
  });

  it("numbers the rows oldest first, so the anchors never depend on the input order", () => {
    const rows = libroRows({
      orderId,
      facts: [],
      lines: [],
      replies: [reply({ id: "late", atMs: 9_000, claims: [listo(1)] }), reply({ id: "early", atMs: 1_000, claims: [listo(1)] })],
      refusals: [],
    });
    expect(rows.map((row) => row.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(rows[0]?.atMs).toBe(1_000);
  });
});
