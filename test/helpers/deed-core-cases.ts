/**
 * One table of cases, written so the same rows can run on the memory store now and on D1 later. Each case is a
 * fresh ledger; each step is one entry and the verdict it must get: "admitted" or the refusal reason.
 */
import type { Entry, Evidence } from "../../src/deed-core";
import type { PolicyName } from "./deed-core-policies";

export interface Step {
  readonly entry: Entry;
  readonly expect: "admitted" | (string & {});
}

export interface Case {
  readonly name: string;
  readonly policy: PolicyName;
  readonly steps: readonly Step[];
}

/** An entry with the fields a test does not care about filled in. */
export function entry(init: Pick<Entry, "factId" | "kind" | "operationKey"> & Partial<Entry>): Entry {
  return { actor: "actor-1", validFromMs: 1_000, body: {}, evidence: [], dependsOn: [], closes: null, ...init };
}

export function ev(kind: string, refId: string): Evidence {
  return { kind, refId, contentSha256: null };
}

const sample = (factId: string, evidence: Evidence[] = [ev("clinician", `c-${factId}`)]) =>
  entry({ factId, kind: "sample_taken", operationKey: `op-${factId}`, evidence });

const result = (factId: string, dependsOn: string[], evidence: Evidence[] = [ev("lab_device", `d-${factId}`)]) =>
  entry({ factId, kind: "result_reported", operationKey: `op-${factId}`, dependsOn, evidence });

const correction = (
  factId: string,
  dependsOn: string[],
  evidence: Evidence[],
  closes: Entry["closes"] = null,
) => entry({ factId, kind: "result_corrected", operationKey: `op-${factId}`, dependsOn, evidence, closes });

const shipment = (factId: string, evidence: Evidence[] = [ev("carrier_scan", `s-${factId}`)]) =>
  entry({ factId, kind: "shipment_declared", operationKey: `op-${factId}`, evidence });

const clearance = (
  factId: string,
  dependsOn: string[],
  evidence: Evidence[] = [ev("officer", `o-${factId}`)],
  closes: Entry["closes"] = null,
) => entry({ factId, kind: "customs_cleared", operationKey: `op-${factId}`, dependsOn, evidence, closes });

export const cases: readonly Case[] = [
  // Clinic lab
  { name: "clinic: admits a sample with one clinician", policy: "clinic", steps: [{ entry: sample("s1"), expect: "admitted" }] },
  {
    name: "clinic: refuses a sample with no evidence",
    policy: "clinic",
    steps: [{ entry: sample("s1", []), expect: "evidence_incomplete" }],
  },
  {
    name: "clinic: refuses a sample with two clinicians (max 1)",
    policy: "clinic",
    steps: [{ entry: sample("s1", [ev("clinician", "c1"), ev("clinician", "c2")]), expect: "evidence_incomplete" }],
  },
  {
    name: "clinic: refuses a kind the policy does not name",
    policy: "clinic",
    steps: [{ entry: entry({ factId: "x1", kind: "sample_shredded", operationKey: "op-x1", evidence: [ev("clinician", "c1")] }), expect: "unknown_kind" }],
  },
  {
    name: "clinic: refuses a repeated operation key",
    policy: "clinic",
    steps: [
      { entry: sample("s1"), expect: "admitted" },
      { entry: entry({ factId: "s2", kind: "sample_taken", operationKey: "op-s1", evidence: [ev("clinician", "c2")] }), expect: "duplicate" },
    ],
  },
  {
    name: "clinic: refuses a fact id that is used again under a new key",
    policy: "clinic",
    steps: [
      { entry: sample("s1"), expect: "admitted" },
      { entry: entry({ factId: "s1", kind: "sample_taken", operationKey: "op-s9", evidence: [ev("clinician", "c9")] }), expect: "duplicate" },
    ],
  },
  {
    name: "clinic: refuses a result on a sample that is not there",
    policy: "clinic",
    steps: [{ entry: result("r1", ["nope"]), expect: "dependency_not_live" }],
  },
  {
    name: "clinic: refuses a result with no lab device",
    policy: "clinic",
    steps: [
      { entry: sample("s1"), expect: "admitted" },
      { entry: result("r1", ["s1"], [ev("clinician", "c9")]), expect: "evidence_incomplete" },
    ],
  },
  {
    name: "clinic: admits a result on a live sample",
    policy: "clinic",
    steps: [
      { entry: sample("s1"), expect: "admitted" },
      { entry: result("r1", ["s1"]), expect: "admitted" },
    ],
  },
  {
    name: "clinic: a correction with one lab device uses the second rule",
    policy: "clinic",
    steps: [
      { entry: sample("s1"), expect: "admitted" },
      { entry: result("r1", ["s1"]), expect: "admitted" },
      { entry: correction("r2", ["r1"], [ev("lab_device", "d2"), ev("clinician", "c3")], { factId: "r1", reason: "superseded" }), expect: "admitted" },
    ],
  },
  {
    name: "clinic: when two lab devices are present the first rule decides, and it needs a clinician",
    policy: "clinic",
    steps: [
      { entry: sample("s1"), expect: "admitted" },
      { entry: correction("r1", ["s1"], [ev("lab_device", "d1"), ev("lab_device", "d2")]), expect: "evidence_incomplete" },
    ],
  },
  {
    name: "clinic: a supersede keeps a descendant that rests on both versions",
    policy: "clinic",
    steps: [
      { entry: sample("s1"), expect: "admitted" },
      { entry: result("r1", ["s1"]), expect: "admitted" },
      { entry: correction("r2", ["r1"], [ev("clinician", "c3")], { factId: "r1", reason: "superseded" }), expect: "admitted" },
      { entry: correction("r3", ["r1", "r2"], [ev("clinician", "c4")]), expect: "admitted" },
    ],
  },
  {
    name: "clinic: a supersede kills a descendant that rests on the old version alone",
    policy: "clinic",
    steps: [
      { entry: sample("s1"), expect: "admitted" },
      { entry: result("r1", ["s1"]), expect: "admitted" },
      { entry: correction("r2", ["r1"], [ev("clinician", "c3")], { factId: "r1", reason: "superseded" }), expect: "admitted" },
      { entry: correction("r3", ["r1"], [ev("clinician", "c4")]), expect: "dependency_not_live" },
    ],
  },
  {
    name: "clinic: a cancelled sample blocks the result that rests on it",
    policy: "clinic",
    steps: [
      { entry: sample("s1"), expect: "admitted" },
      { entry: result("r1", ["s1"]), expect: "admitted" },
      { entry: correction("c1", [], [ev("clinician", "c5")], { factId: "s1", reason: "cancelled" }), expect: "admitted" },
      { entry: result("r2", ["r1"]), expect: "dependency_not_live" },
    ],
  },
  {
    name: "clinic: a second close of the same fact is refused",
    policy: "clinic",
    steps: [
      { entry: sample("s1"), expect: "admitted" },
      { entry: correction("c1", [], [ev("clinician", "c5")], { factId: "s1", reason: "cancelled" }), expect: "admitted" },
      { entry: correction("c2", [], [ev("clinician", "c6")], { factId: "s1", reason: "cancelled" }), expect: "closes_not_live" },
    ],
  },
  {
    name: "clinic: closing a fact that was never written is refused",
    policy: "clinic",
    steps: [{ entry: correction("c1", [], [ev("clinician", "c5")], { factId: "ghost", reason: "cancelled" }), expect: "closes_not_live" }],
  },
  {
    name: "clinic: refuses a fact that closes itself",
    policy: "clinic",
    steps: [{ entry: correction("s1", [], [ev("clinician", "c5")], { factId: "s1", reason: "cancelled" }), expect: "closes_not_live" }],
  },

  // Freight
  { name: "freight: admits a shipment with a carrier scan", policy: "freight", steps: [{ entry: shipment("s1"), expect: "admitted" }] },
  {
    name: "freight: refuses a shipment with no evidence",
    policy: "freight",
    steps: [{ entry: shipment("s1", []), expect: "evidence_incomplete" }],
  },
  {
    name: "freight: refuses a clearance with no officer",
    policy: "freight",
    steps: [
      { entry: shipment("s1"), expect: "admitted" },
      { entry: clearance("k1", ["s1"], [ev("carrier_scan", "x")]), expect: "evidence_incomplete" },
    ],
  },
  {
    name: "freight: refuses a clearance of a shipment never declared",
    policy: "freight",
    steps: [{ entry: clearance("k1", ["ghost"]), expect: "dependency_not_live" }],
  },
  {
    name: "freight: a cancelled declaration blocks its clearance",
    policy: "freight",
    steps: [
      { entry: shipment("s1"), expect: "admitted" },
      { entry: clearance("k0", [], [ev("officer", "o0")], { factId: "s1", reason: "cancelled" }), expect: "admitted" },
      { entry: clearance("k1", ["s1"]), expect: "dependency_not_live" },
    ],
  },
  {
    name: "freight: a supersede keeps a clearance that rests on both declarations",
    policy: "freight",
    steps: [
      { entry: shipment("s1"), expect: "admitted" },
      { entry: shipment("s2"), expect: "admitted" },
      { entry: entry({ factId: "s3", kind: "shipment_declared", operationKey: "op-s3", dependsOn: ["s1"], closes: { factId: "s1", reason: "superseded" }, evidence: [ev("carrier_scan", "s-s3")] }), expect: "admitted" },
      { entry: clearance("k1", ["s1", "s3"]), expect: "admitted" },
    ],
  },
];
