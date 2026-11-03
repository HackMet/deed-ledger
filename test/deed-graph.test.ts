import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type DeedFact, type DeedGraph, type DeedStatus, blockingPath, deedGraph, isLiveStatus, visibleAt } from "../src/domain/deed-graph";
import { D1OrderStore } from "../src/infrastructure/d1/order-store";
import { newStore } from "./helpers/orders";

const fact = (id: string, recordedAtMs: number, dependsOn: string[] = [], closure: DeedFact["closure"] = null, kind = "order_status"): DeedFact => ({
  id,
  kind,
  recordedAtMs,
  dependsOn,
  closure,
});

const statusesOf = (graph: DeedGraph): Record<string, DeedStatus> => Object.fromEntries(graph.nodes.map((node) => [node.id, node.status]));

describe("deedGraph: layout", () => {
  const facts = [
    fact("v1", 1, [], null, "order_version"),
    fact("c", 2, ["v1"], null, "order_confirm"),
    fact("s", 3, ["c"]),
    fact("t", 4, ["v1"]),
  ];

  it("is the same for the same facts, whatever order they come in", () => {
    expect(deedGraph([...facts].reverse())).toEqual(deedGraph(facts));
    expect(deedGraph([facts[2]!, facts[0]!, facts[3]!, facts[1]!])).toEqual(deedGraph(facts));
  });

  it("puts a fact one layer below what rests on it: no dependency points to a lower layer", () => {
    const graph = deedGraph(facts);
    const layer = new Map(graph.nodes.map((node) => [node.id, node.layer]));
    for (const edge of graph.edges.filter((candidate) => candidate.type === "depends")) {
      expect(layer.get(edge.to)).toBeGreaterThan(layer.get(edge.from)!);
    }
    expect(Object.fromEntries(graph.nodes.map((node) => [node.id, node.layer]))).toEqual({ v1: 0, c: 1, t: 1, s: 2 });
    expect(graph.layers).toBe(3);
  });

  it("orders a layer by recorded time, then id, with one column per fact", () => {
    const graph = deedGraph(facts);
    const inLayerOne = graph.nodes.filter((node) => node.layer === 1).map((node) => [node.id, node.column]);
    expect(inLayerOne).toEqual([
      ["c", 0],
      ["t", 1],
    ]);
  });

  it("is empty for no facts", () => {
    expect(deedGraph([])).toEqual({ nodes: [], edges: [], layers: 0, refusals: [] });
  });
});

describe("visibleAt: the replay's view of a time", () => {
  const facts = [
    fact("v1", 1, [], null, "order_version"),
    fact("c", 2, ["v1"], { closedByFactId: "x", reason: "cancelled", atMs: 5 }, "order_confirm"),
    fact("x", 5, [], null, "order_cancel"),
  ];

  it("keeps the facts recorded by then, and the closures recorded by then", () => {
    expect(visibleAt(facts, 4).map((f) => f.id)).toEqual(["v1", "c"]);
    expect(visibleAt(facts, 4)[1]!.closure).toBeNull();
    expect(visibleAt(facts, 5).map((f) => f.id)).toEqual(["v1", "c", "x"]);
    expect(visibleAt(facts, 5)[1]!.closure).toEqual({ closedByFactId: "x", reason: "cancelled", atMs: 5 });
    expect(statusesOf(deedGraph(visibleAt(facts, 4)))).toEqual({ v1: "live", c: "live" });
    expect(statusesOf(deedGraph(visibleAt(facts, 5)))).toEqual({ v1: "live", c: "closed", x: "live" });
  });
});

describe("deedGraph: refused checks", () => {
  it("draws each refusal below the layers, linked to the fact that decided it", () => {
    const facts = [
      fact("v1", 1, [], null, "order_version"),
      fact("c", 2, ["v1"], { closedByFactId: "x", reason: "cancelled" }, "order_confirm"),
      fact("x", 3, [], null, "order_cancel"),
    ];
    const graph = deedGraph(facts, [
      { id: "r2", atMs: 9, reason: "invalid_state", decidingFactId: "x" },
      { id: "r1", atMs: 4, reason: "duplicate", decidingFactId: null },
    ]);
    expect(graph.refusals.map((refusal) => [refusal.id, refusal.column])).toEqual([
      ["r1", 0],
      ["r2", 1],
    ]);
    expect(graph.edges).toContainEqual({ from: "r2", to: "x", type: "refused" });
    expect(graph.edges.filter((edge) => edge.type === "refused")).toHaveLength(1);
    expect(graph.nodes.every((node) => node.layer < graph.layers)).toBe(true);
  });
});

describe("deedGraph: status", () => {
  it("closes the confirm a cancel closes, and blocks every fact that rests on it", () => {
    const graph = deedGraph([
      fact("v1", 1, [], null, "order_version"),
      fact("c", 2, ["v1"], { closedByFactId: "x", reason: "cancelled" }, "order_confirm"),
      fact("s", 3, ["c"]),
      fact("x", 4, [], null, "order_cancel"),
    ]);
    expect(statusesOf(graph)).toEqual({ v1: "live", c: "closed", s: "blocked", x: "live" });
    expect(graph.edges).toContainEqual({ from: "x", to: "c", type: "closes" });
  });

  it("blocks a fact by a closure two levels up, not only its parent", () => {
    const graph = deedGraph([
      fact("v1", 1, [], { closedByFactId: "x", reason: "cancelled" }, "order_version"),
      fact("c", 2, ["v1"], null, "order_confirm"),
      fact("s1", 3, ["c"]),
      fact("s2", 4, ["s1"]),
      fact("x", 5, [], null, "order_cancel"),
    ]);
    expect(statusesOf(graph)).toEqual({ v1: "closed", c: "blocked", s1: "blocked", s2: "blocked", x: "live" });
  });

  it("keeps a version live when a newer version it rests on supersedes it", () => {
    const graph = deedGraph([
      fact("v1", 1, [], { closedByFactId: "v2", reason: "superseded" }, "order_version"),
      fact("v2", 2, ["v1"], null, "order_version"),
      fact("c2", 3, ["v2"], null, "order_confirm"),
    ]);
    expect(statusesOf(graph)).toEqual({ v1: "closed", v2: "live", c2: "live" });
  });

  it("marks a change request nobody has answered as pending, and an answered one as closed", () => {
    const open = deedGraph([fact("v1", 1, [], null, "order_version"), fact("r", 2, ["v1"], null, "change_request")]);
    expect(statusesOf(open)).toEqual({ v1: "live", r: "pending" });
    expect(isLiveStatus("pending")).toBe(true);
    const answered = deedGraph([
      fact("v1", 1, [], null, "order_version"),
      fact("r", 2, ["v1"], { closedByFactId: "rv", reason: "superseded" }, "change_request"),
      fact("rv", 3, ["r"], null, "change_review"),
    ]);
    expect(statusesOf(answered)).toEqual({ v1: "live", r: "closed", rv: "live" });
  });

  it("names the nearest closed ancestor of a blocked fact, and the path down to it", () => {
    const facts = [
      fact("v1", 1, [], { closedByFactId: "x", reason: "cancelled" }, "order_version"),
      fact("c", 2, ["v1"], null, "order_confirm"),
      fact("s1", 3, ["c"]),
      fact("s2", 4, ["s1"]),
      fact("x", 5, [], null, "order_cancel"),
    ];
    const graph = deedGraph(facts);
    expect(blockingPath(graph, "s2", facts)).toEqual({ closedId: "v1", path: ["s2", "s1", "c", "v1"] });
    expect(blockingPath(graph, "x", facts)).toBeNull();
  });

  it("names the old version that kills a change review, not the request its own supersede closed (B1)", () => {
    // Demo order D's shape: the review rests on the request it answers, and the request is superseded by the
    // review. Its real killer is the old version, superseded by the new one, which the review does not rest on.
    const facts = [
      fact("v1", 1, [], { closedByFactId: "v2", reason: "superseded" }, "order_version"),
      fact("v2", 2, [], null, "order_version"),
      fact("r", 3, ["v1"], { closedByFactId: "rv", reason: "superseded" }, "change_request"),
      fact("rv", 4, ["r"], null, "change_review"),
    ];
    const graph = deedGraph(facts);
    expect(statusesOf(graph)).toEqual({ v1: "closed", v2: "live", r: "closed", rv: "blocked" });
    expect(blockingPath(graph, "rv", facts)).toEqual({ closedId: "v1", path: ["rv", "r", "v1"] });
  });
});

/** A seeded generator (mulberry32): the same seed draws the same numbers, on every run and host. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random DAG of order facts with random closures; dependencies only point at earlier facts. */
function randomDag(seed: number, orderId: string): DeedFact[] {
  const random = seededRandom(seed);
  const kinds = ["order_version", "order_confirm", "order_status", "order_cancel"] as const;
  const count = 2 + Math.floor(random() * 8);
  const ids = Array.from({ length: count }, (_, index) => `${orderId}-f${index}`);
  return ids.map((id, index) => {
    const dependsOn = ids.slice(0, index).filter(() => random() < 0.4);
    const closes = random() < 0.3 && count > 1;
    const closer = Math.floor(random() * count);
    return fact(id, 1_000 + index, dependsOn, closes && closer !== index
      ? { closedByFactId: ids[closer]!, reason: random() < 0.5 ? "cancelled" : "superseded" }
      : null, kinds[Math.floor(random() * kinds.length)]);
  });
}

/** A fact and everything it rests on, found by a plain walk: an oracle for the property below, not the module's code. */
function restingOn(id: string, byId: ReadonlyMap<string, DeedFact>): Set<string> {
  const found = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (found.has(current) || !byId.has(current)) continue;
    found.add(current);
    stack.push(...byId.get(current)!.dependsOn);
  }
  return found;
}

describe("blockingPath names a blocker that really kills the fact (B1)", () => {
  it("for 200 seeded random DAGs: a blocked fact's path runs down its dependencies to a closure that kills it", () => {
    let blocked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const facts = randomDag(seed, `blocker-${seed}`);
      const byId = new Map(facts.map((f) => [f.id, f]));
      const graph = deedGraph(facts);
      for (const node of graph.nodes.filter((candidate) => candidate.status === "blocked")) {
        blocked++;
        const named = blockingPath(graph, node.id, facts);
        expect(named, `seed ${seed}, fact ${node.id}`).not.toBeNull();
        const { closedId, path } = named!;
        const ancestors = restingOn(node.id, byId);
        const closure = byId.get(closedId)!.closure;
        expect(closure !== null && !(closure.reason === "superseded" && ancestors.has(closure.closedByFactId)), `seed ${seed}, blocker ${closedId}`).toBe(true);
        expect(path[0]).toBe(node.id);
        expect(path[path.length - 1]).toBe(closedId);
        for (let step = 0; step + 1 < path.length; step++) {
          expect(byId.get(path[step]!)!.dependsOn).toContain(path[step + 1]);
        }
      }
    }
    expect(blocked).toBeGreaterThan(0);
  });
});

describe("deedGraph agrees with the ledger's SQL liveness", () => {
  it("for 200 seeded random DAGs with random closures, written into local D1", async () => {
    const s = await newStore();
    const store = new D1OrderStore(env.DB);
    for (let seed = 1; seed <= 200; seed++) {
      const orderId = `deed-property-${seed}`;
      const facts = randomDag(seed, orderId);
      const statements = [];
      for (const [index, f] of facts.entries()) {
        statements.push(
          env.DB.prepare(
            `INSERT INTO facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json)
             VALUES (?, ?, ?, ?, 'property-member', 0, ?, ?)`,
          ).bind(f.id, s.businessId, f.kind, `${orderId}:${index}`, f.recordedAtMs, JSON.stringify({ orderId, version: 1 })),
        );
        for (const dependency of f.dependsOn) {
          statements.push(
            env.DB.prepare(`INSERT INTO fact_dependencies (business_id, fact_id, depends_on_fact_id) VALUES (?, ?, ?)`).bind(s.businessId, f.id, dependency),
          );
        }
        if (f.closure !== null) {
          statements.push(
            env.DB.prepare(
              `INSERT INTO fact_closures (business_id, fact_id, closed_by_fact_id, reason, closed_at_ms) VALUES (?, ?, ?, ?, 2000)`,
            ).bind(s.businessId, f.id, f.closure.closedByFactId, f.closure.reason),
          );
        }
      }
      await env.DB.batch(statements);

      const pure = statusesOf(deedGraph(facts));
      const sql = new Map((await store.orderFacts(s, orderId)).map((row) => [row.id, row.live]));
      for (const f of facts) {
        expect(isLiveStatus(pure[f.id]!), `seed ${seed}, fact ${f.id}`).toBe(sql.get(f.id));
      }
    }
  });
});
