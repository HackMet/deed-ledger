/**
 * Construction inspections, adopted with a policy and nothing else: no extension, no edit to the core. The same
 * steps run on the memory store and on D1 with schema.sql alone on a blank database, and the verdicts re-run from a
 * file that carries the policy and the entries.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  D1LedgerStore,
  DEFAULT_LEDGER_CONFIG,
  type Entry,
  type EntryJudge,
  type Evidence,
  type LedgerStore,
  MalformedEntry,
  MemoryLedgerStore,
  type Policy,
  type Verdict,
  entryFile,
  recheck,
} from "../src/deed-core";
import schemaSql from "../src/deed-core/schema.sql?raw";

const NOW = Date.UTC(2026, 10, 4);

const inspectionsPolicy: Policy = {
  kinds: {
    permit_issued: { evidence: [{ require: [{ kind: "permit_office_record", min: 1, max: 1 }] }] },
    // An engineer signs alone, with a site photo; without one, two inspectors must sign.
    inspection_passed: {
      evidence: [
        { when: { kind: "structural_engineer", min: 1 }, require: [{ kind: "structural_engineer", max: 1 }, { kind: "site_photo", min: 1 }] },
        { require: [{ kind: "inspector_signature", min: 2 }] },
      ],
    },
    defect_noted: { evidence: [{ require: [{ kind: "inspector_signature", min: 1, max: 1 }, { kind: "site_photo", min: 1 }] }] },
    occupancy_granted: { evidence: [{ require: [{ kind: "municipal_seal", min: 1, max: 1 }] }] },
    permit_revoked: { evidence: [{ require: [{ kind: "permit_office_record", min: 1 }] }] },
  },
};

const ev = (kind: string, refId: string): Evidence => ({ kind, refId, contentSha256: null });
const office = (refId: string) => ev("permit_office_record", refId);
const inspector = (refId: string) => ev("inspector_signature", refId);
const engineer = (refId: string) => ev("structural_engineer", refId);
const photo = (refId: string) => ev("site_photo", refId);
const seal = (refId: string) => ev("municipal_seal", refId);

function step(factId: string, kind: string, evidence: readonly Evidence[], rest: Partial<Entry> = {}): Entry {
  return { factId, kind, operationKey: `op-${factId}`, actor: "site-clerk", validFromMs: NOW, body: { lot: 12 }, evidence, dependsOn: [], closes: null, ...rest };
}

const permit = step("permit", "permit_issued", [office("rec-1")]);
const passed = step("pass-1", "inspection_passed", [inspector("i-1"), inspector("i-2")], { dependsOn: ["permit"] });

const scenarios: readonly { readonly name: string; readonly steps: readonly (readonly [Entry, string])[] }[] = [
  {
    name: "admits on either rule of a kind",
    steps: [
      [permit, "admitted"],
      [passed, "admitted"],
      [step("pass-2", "inspection_passed", [engineer("e-1"), photo("p-1")], { dependsOn: ["permit"] }), "admitted"],
    ],
  },
  {
    name: "refuses missing evidence: none, the wrong source, a first rule half met, one signature short, a bound passed, a witness counted twice",
    steps: [
      [permit, "admitted"],
      [step("none", "permit_issued", []), "evidence_incomplete"],
      [step("wrong", "permit_issued", [inspector("i-1")]), "evidence_incomplete"],
      [step("half", "inspection_passed", [engineer("e-1"), inspector("i-1"), inspector("i-2")], { dependsOn: ["permit"] }), "evidence_incomplete"],
      [step("short", "inspection_passed", [inspector("i-1")], { dependsOn: ["permit"] }), "evidence_incomplete"],
      [step("over", "occupancy_granted", [seal("s-1"), seal("s-2")], { dependsOn: ["permit"] }), "evidence_incomplete"],
      [step("twice", "inspection_passed", [inspector("i-1"), inspector("i-1")], { dependsOn: ["permit"] }), "evidence_incomplete"],
    ],
  },
  {
    name: "refuses a kind the policy doesn't name, and names on Object's prototype",
    steps: [
      [step("x", "demolition_ordered", [office("rec-1")]), "unknown_kind"],
      [step("y", "constructor", [office("rec-1")]), "unknown_kind"],
      [step("z", "PERMIT_ISSUED", [office("rec-1")]), "unknown_kind"],
    ],
  },
  {
    name: "refuses a repeated operation key and a repeated fact id, and a duplicate outranks everything else wrong with it",
    steps: [
      [permit, "admitted"],
      [step("again", "permit_issued", [office("rec-2")], { operationKey: permit.operationKey }), "duplicate"],
      [step("permit", "permit_issued", [office("rec-2")], { operationKey: "op-new" }), "duplicate"],
      [step("worse", "nothing_known", [], { operationKey: permit.operationKey, dependsOn: ["ghost"] }), "duplicate"],
    ],
  },
  {
    name: "a closed dependency blocks a descendant, however far down",
    steps: [
      [permit, "admitted"],
      [passed, "admitted"],
      [step("revoke", "permit_revoked", [office("rec-2")], { closes: { factId: "permit", reason: "cancelled" } }), "admitted"],
      [step("direct", "defect_noted", [inspector("i-3"), photo("p-3")], { dependsOn: ["permit"] }), "dependency_not_live"],
      [step("descendant", "occupancy_granted", [seal("s-1")], { dependsOn: ["pass-1"] }), "dependency_not_live"],
      [step("revoke-2", "permit_revoked", [office("rec-3")], { closes: { factId: "permit", reason: "cancelled" } }), "closes_not_live"],
    ],
  },
  {
    name: "a supersede keeps the new version and what rests on it live, and kills what rests on the old one alone",
    steps: [
      [permit, "admitted"],
      [passed, "admitted"],
      [step("repass", "inspection_passed", [engineer("e-2"), photo("p-2")], { dependsOn: ["pass-1"], closes: { factId: "pass-1", reason: "superseded" } }), "admitted"],
      [step("occupancy", "occupancy_granted", [seal("s-1")], { dependsOn: ["repass"] }), "admitted"],
      [step("on-old", "occupancy_granted", [seal("s-2")], { dependsOn: ["pass-1"] }), "dependency_not_live"],
      [step("on-both", "occupancy_granted", [seal("s-3")], { dependsOn: ["pass-1", "repass"] }), "admitted"],
    ],
  },
  {
    name: "refuses to close what isn't there",
    steps: [[step("revoke", "permit_revoked", [office("rec-2")], { closes: { factId: "ghost", reason: "cancelled" } }), "closes_not_live"]],
  },
];

const reasonOf = (verdict: Verdict): string => (verdict.admitted ? "admitted" : verdict.reason);

async function verdictsOn(store: LedgerStore, scope: string, entries: readonly Entry[]): Promise<string[]> {
  const verdicts: string[] = [];
  for (const entry of entries) verdicts.push(reasonOf(await store.admit(scope, entry, NOW)));
  return verdicts;
}

/** schema.sql as statements: each top-level statement starts with CREATE; D1's exec() refuses the file's comments. */
const schemaStatements = schemaSql
  .replace(/--.*$/gm, "")
  .split(/;\n(?=CREATE\b)/)
  .map((statement) => statement.trim().replace(/;$/, ""))
  .filter((statement) => statement.length > 0);

const db = env.MIGRATION_TEST_DB;

describe("construction inspections on the core, with a policy alone", () => {
  beforeAll(async () => {
    await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
  });

  describe.each(scenarios.map((scenario, index) => ({ ...scenario, index })))("$name", ({ steps, index }) => {
    const entries = steps.map(([entry]) => entry);
    const expected = steps.map(([, verdict]) => verdict);

    it("on the memory store", async () => {
      expect(await verdictsOn(new MemoryLedgerStore(inspectionsPolicy), "site-a", entries)).toEqual(expected);
    });

    it("on D1, on schema.sql alone, with a refused entry leaving no row", async () => {
      const scope = `scenario-${index}`;
      expect(await verdictsOn(new D1LedgerStore(db, DEFAULT_LEDGER_CONFIG, inspectionsPolicy), scope, entries)).toEqual(expected);
      const row = await db.prepare(`SELECT count(*) AS n FROM facts WHERE scope_id = ?`).bind(scope).first<{ n: number }>();
      expect(row?.n).toBe(expected.filter((verdict) => verdict === "admitted").length);
    });
  });

  it("keeps two sites apart on D1 and in memory: a key, a dependency and a closure stay on their site", async () => {
    const stores: readonly LedgerStore[] = [new MemoryLedgerStore(inspectionsPolicy), new D1LedgerStore(db, DEFAULT_LEDGER_CONFIG, inspectionsPolicy)];
    for (const store of stores) {
      expect(reasonOf(await store.admit("north", permit, NOW))).toBe("admitted");
      expect(reasonOf(await store.admit("south", step("on-north", "defect_noted", [inspector("i"), photo("p")], { dependsOn: ["permit"] }), NOW))).toBe("dependency_not_live");
      expect(reasonOf(await store.admit("south", step("close-north", "permit_revoked", [office("r")], { closes: { factId: "permit", reason: "cancelled" } }), NOW))).toBe("closes_not_live");
      expect(reasonOf(await store.admit("south", permit, NOW))).toBe("admitted");
    }
  });
});

const STATES = ["admitted", "duplicate", "unknown_kind", "evidence_incomplete", "dependency_not_live", "closes_not_live"] as const;
type State = (typeof STATES)[number];

interface InspectionFile {
  readonly policy: Policy;
  readonly entries: readonly Entry[];
}

/** The judge a third party runs: everything it reads is in the file. */
const fileJudge: EntryJudge<InspectionFile, State> = {
  domain: "construction-inspections",
  states: STATES,
  parse: (raw) => {
    const input = raw as Partial<InspectionFile> | null;
    if (typeof input !== "object" || input === null || typeof input.policy !== "object" || !Array.isArray(input.entries)) {
      throw new MalformedEntry("input must carry a policy and its entries");
    }
    return input as InspectionFile;
  },
  rows: ({ policy, entries }) => {
    const store = new MemoryLedgerStore(policy);
    return entries.map((entry, index) => ({ rowKey: `${index}:${entry.factId}`, state: reasonOf(store.admitNow("file", entry)) as State }));
  },
};

describe("re-check from the file alone", () => {
  const scenario = scenarios.find((item) => item.name.startsWith("a supersede"))!;
  const input: InspectionFile = { policy: inspectionsPolicy, entries: scenario.steps.map(([entry]) => entry) };
  const written = JSON.parse(JSON.stringify(entryFile(fileJudge, input))) as { verdicts: { rowKey: string; state: string }[] };

  it("gives the verdicts the stores gave, through a JSON round trip", () => {
    expect(written.verdicts.map((row) => row.state)).toEqual(scenario.steps.map(([, verdict]) => verdict));
    const count = scenario.steps.length;
    expect(recheck(fileJudge, written)).toEqual({ ok: true, pairs: count, same: count, differ: [] });
  });

  it("reports a changed verdict, a changed input and a row taken out", () => {
    const flipped = { ...written, verdicts: written.verdicts.map((row, n) => (n === 4 ? { ...row, state: "admitted" } : row)) };
    expect(recheck(fileJudge, flipped)).toEqual({ ok: true, pairs: 6, same: 5, differ: [{ rowKey: "4:on-old", stored: "admitted", recomputed: "dependency_not_live" }] });

    const weakened = JSON.parse(JSON.stringify(written)) as { input: InspectionFile; verdicts: unknown[] };
    (weakened.input.entries[2] as { closes: unknown }).closes = null;
    const changed = recheck(fileJudge, weakened);
    expect(changed.ok && changed.differ.map((row) => row.rowKey)).toEqual(["4:on-old"]);

    const short = { ...written, verdicts: written.verdicts.slice(1) };
    expect(recheck(fileJudge, short)).toEqual({ ok: true, pairs: 6, same: 5, differ: [{ rowKey: "0:permit", stored: "missing", recomputed: "admitted" }] });
  });

  it("refuses another domain's file and a malformed one", () => {
    expect(recheck(fileJudge, { ...written, domain: "freight" })).toMatchObject({ ok: false });
    expect(recheck(fileJudge, { ...written, input: null })).toMatchObject({ ok: false });
    expect(recheck(fileJudge, { ...written, schema: 2 })).toMatchObject({ ok: false });
  });
});
