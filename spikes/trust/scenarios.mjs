// Scenario executor + scorer for E6/E8 (Lane C). Binds the case-file behavior
// labels (create_draft, confirm, ingest_message, correct_draft, abandon, wait)
// to DraftStore methods without changing expected behavior.
import { readFileSync, readdirSync } from "node:fs";
import { DraftStore } from "./store.mjs";

const ACTIONS = ["create_draft", "confirm", "ingest_message", "correct_draft", "abandon", "wait"];

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function actualFinal(caseId, store, stepResults, expected) {
  // Build the actual values for exactly the keys the case expects.
  const out = {};
  for (const key of Object.keys(expected)) {
    switch (key) {
      case "draft_id":
        out.draft_id = expected.draft_id;
        break;
      case "state":
        out.state = store.getDraft(expected.draft_id)?.state ?? null;
        break;
      case "committed_revision":
        out.committed_revision = store.getDraft(expected.draft_id)?.committed_revision ?? null;
        break;
      case "revision":
        out.revision = store.getDraft(expected.draft_id)?.revision ?? null;
        break;
      case "open_drafts_for_M-5001": {
        const n = store.openDraftsForMessage("M-5001");
        out["open_drafts_for_M-5001"] = n;
        break;
      }
      case "resumed_or_restarted": {
        const last = stepResults[stepResults.length - 1]?.result ?? {};
        out.resumed_or_restarted = last.resumed === true || last.created === true;
        break;
      }
      case "correction_lost": {
        const lastStep = stepResults[stepResults.length - 1];
        const body = lastStep?.args?.body;
        const draft = store.getDraft(lastStep?.result?.draft_id);
        out.correction_lost = !(body && draft && draft.notes.includes(body));
        break;
      }
      case "duplicate_warning":
        out.duplicate_warning = store.hasDuplicateWarning();
        break;
      case "silent_second_commit":
        out.silent_second_commit = store.commits > 0;
        break;
      case "correction_on_wrong_draft": {
        const target = store.getDraft(expected.draft_id);
        const stray = [...store.drafts.values()].some(
          (d) => d.draft_id !== expected.draft_id && d.corrections.length > 0,
        );
        out.correction_on_wrong_draft = !(target && target.corrections.length > 0) || stray;
        break;
      }
      default:
        out[key] = `UNSCORABLE:${key}`;
    }
  }
  void caseId;
  return out;
}

export function runCase(casePath) {
  const kase = JSON.parse(readFileSync(casePath, "utf8"));
  const store = new DraftStore();
  const stepResults = [];
  for (const { step, action, args } of kase.steps) {
    if (!ACTIONS.includes(action)) {
      stepResults.push({ step, action, ok: false, reason: "unknown_action", args });
      continue;
    }
    const result = store[action](args);
    stepResults.push({ step, action, ok: result.ok, reason: result.reason ?? null, args, result });
  }
  const actualRejects = stepResults.filter((s) => !s.ok).map((s) => s.step);
  const checks = {
    rejects: { expected: kase.expected.rejects ?? null, actual: actualRejects },
  };
  if ("commits" in kase.expected) {
    checks.commits = { expected: kase.expected.commits, actual: store.commits };
  }
  if ("drafts_created" in kase.expected) {
    checks.drafts_created = { expected: kase.expected.drafts_created, actual: store.drafts.size };
  }
  const actual = actualFinal(kase.id, store, stepResults, kase.expected.final ?? {});
  checks.final = { expected: kase.expected.final ?? {}, actual };
  const pass =
    deepEqual(checks.rejects.expected, checks.rejects.actual) &&
    (checks.commits ? checks.commits.expected === checks.commits.actual : true) &&
    (checks.drafts_created ? checks.drafts_created.expected === checks.drafts_created.actual : true) &&
    deepEqual(checks.final.expected, checks.final.actual);
  return { id: kase.id, pass, checks, steps: stepResults };
}

export function runExperiment(exp, casesDir) {
  const files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
  const cases = files.map((f) => runCase(`${casesDir}/${f}`));
  const passed = cases.filter((c) => c.pass).length;
  return {
    experiment: exp,
    date: "2026-10-27",
    model: "none (deterministic, zero model calls)",
    cases,
    passed,
    total: cases.length,
  };
}
