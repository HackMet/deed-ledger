import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type FactForView, nodeViews } from "../src/domain/deed-node-view";
import type { DeedStatus } from "../src/domain/deed-graph";
import { D1OrderTrail } from "../src/infrastructure/d1/order-trail";
import { ids } from "./fixtures/contract";
import { T0, newStore, placeFirstOrder } from "./helpers/orders";

const fact = (over: Partial<FactForView> & Pick<FactForView, "factId" | "kind">): FactForView => ({
  recordedAtMs: 1,
  agentId: null,
  evidence: [],
  detail: null,
  closedByReason: null,
  ...over,
});
const view = (f: FactForView, status?: DeedStatus) => nodeViews([f], new Map(status === undefined ? [] : [[f.factId, status]]))[0]!;

describe("nodeViews", () => {
  it("one node per state", () => {
    const member = [{ kind: "member", refId: "m1" }];
    const msg = [{ kind: "inbound_message", refId: "i1" }];
    const out = nodeViews(
      [
        fact({ factId: "a", kind: "order_version", detail: "2 azúcar" }),
        fact({ factId: "b", kind: "order_confirm", evidence: msg, agentId: "ag" }),
        fact({ factId: "c", kind: "order_cancel", evidence: member, closedByReason: "cancelled" }),
        fact({ factId: "d", kind: "change_request", evidence: msg, detail: "3 azúcar" }),
      ],
      new Map<string, DeedStatus>([["a", "pending"], ["b", "live"], ["c", "closed"], ["d", "blocked"]]),
    );
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "agentId": null,
          "confirmedBy": null,
          "evidenceKinds": [],
          "factId": "a",
          "recordedAtMs": 1,
          "state": "en_duda",
          "title": "Pedido · 2 azúcar",
        },
        {
          "agentId": "ag",
          "confirmedBy": "cliente",
          "evidenceKinds": [
            "inbound_message",
          ],
          "factId": "b",
          "recordedAtMs": 1,
          "state": "hecho",
          "title": "Confirmado por el cliente",
        },
        {
          "agentId": null,
          "confirmedBy": "tienda",
          "evidenceKinds": [
            "member",
          ],
          "factId": "c",
          "recordedAtMs": 1,
          "state": "cerrado",
          "title": "Cancelado por la tienda",
        },
        {
          "agentId": null,
          "confirmedBy": "cliente",
          "evidenceKinds": [
            "inbound_message",
          ],
          "factId": "d",
          "recordedAtMs": 1,
          "state": "bloqueado",
          "title": "Cambio → 3 azúcar",
        },
      ]
    `);
  });

  it("never marks unconfirmed facts hecho", () => {
    const empty = view(fact({ factId: "x", kind: "order_confirm", agentId: "ag" }), "live");
    const unknown = view(fact({ factId: "y", kind: "order_confirm", agentId: "ag", evidence: [{ kind: "confirmation", refId: "z" }] }), "live");
    expect(empty.state).toBe("en_duda");
    expect(unknown.state).toBe("en_duda");
    expect(unknown.confirmedBy).toBeNull();
    expect(view(fact({ factId: "z", kind: "order_confirm" })).state).toBe("en_duda");
  });

  it("store wins over customer, and titles never say Versión", () => {
    const both = view(fact({ factId: "a", kind: "order_cancel", evidence: [{ kind: "inbound_message", refId: "i" }, { kind: "member", refId: "m" }] }), "live");
    expect(both.confirmedBy).toBe("tienda");
    expect(both.title).toBe("Cancelado por la tienda");
    const kinds = ["order_version", "order_confirm", "order_cancel", "order_status", "change_request", "change_review"] as const;
    for (const kind of kinds) {
      for (const detail of [null, "x"]) expect(view(fact({ factId: "a", kind, detail })).title).not.toContain("Versión");
    }
  });

  it("keeps agentId null when the record has none", () => {
    expect(view(fact({ factId: "a", kind: "order_version" })).agentId).toBeNull();
  });
});

describe("trail detail", () => {
  it("fills the order lines on the version fact", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s, ids.customer, T0);
    const trail = await new D1OrderTrail(env.DB).trail({ businessId: s.businessId }, v1.orderId);
    const version = trail!.facts.find((f) => f.kind === "order_version")!;
    expect(version.detail).toMatch(/\S/);
    expect(trail!.facts.filter((f) => f.kind !== "order_version").every((f) => f.detail === null)).toBe(true);
  });
});
