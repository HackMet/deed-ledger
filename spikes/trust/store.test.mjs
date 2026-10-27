// Unit checks for the trust store guards + full E6/E8 scenario pass.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DraftStore } from "./store.mjs";
import { runExperiment } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function openDraft(store, id = "D-1", storeName = "A") {
  const r = store.create_draft({ draft_id: id, store: storeName, kind: "sale" });
  assert.equal(r.ok, true);
}

describe("DraftStore guards", () => {
  it("rejects calls without store context", () => {
    const s = new DraftStore();
    assert.equal(s.create_draft({ draft_id: "D-1", kind: "sale" }).ok, false);
    openDraft(s);
    assert.equal(s.confirm({ draft_id: "D-1", revision: 1, operation_key: "K-1" }).ok, false);
  });

  it("rejects cross-store reads and writes", () => {
    const s = new DraftStore();
    openDraft(s);
    assert.equal(s.confirm({ draft_id: "D-1", revision: 1, store: "B", operation_key: "K-1" }).reason, "wrong_store");
    assert.equal(s.correct_draft({ draft_id: "D-1", store: "B", changes: {} }).ok, false);
    assert.equal(s.commits, 0);
  });

  it("enforces operation-key uniqueness", () => {
    const s = new DraftStore();
    openDraft(s, "D-1");
    openDraft(s, "D-2");
    assert.equal(s.confirm({ draft_id: "D-1", revision: 1, store: "A", operation_key: "K-1" }).ok, true);
    const r = s.confirm({ draft_id: "D-2", revision: 1, store: "A", operation_key: "K-1" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "duplicate_operation");
    assert.equal(s.commits, 1);
  });

  it("rejects stale revisions without consuming the fresh key", () => {
    const s = new DraftStore();
    openDraft(s);
    s.correct_draft({ draft_id: "D-1", store: "A", changes: { quantity_value: 10 } });
    const stale = s.confirm({ draft_id: "D-1", revision: 1, store: "A", operation_key: "K-stale" });
    assert.equal(stale.reason, "stale_revision");
    assert.equal(s.confirm({ draft_id: "D-1", revision: 2, store: "A", operation_key: "K-fresh" }).ok, true);
    assert.equal(s.commits, 1);
  });

  it("dedupes replayed message IDs visibly", () => {
    const s = new DraftStore();
    const first = s.ingest_message({ message_id: "M-1", store: "A", kind: "image", ref: "pic.png" });
    assert.equal(first.ok, true);
    const replay = s.ingest_message({ message_id: "M-1", store: "A", kind: "image", ref: "pic.png" });
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, "duplicate_message");
    assert.equal(s.drafts.size, 1);
  });

  it("flags same bytes under a new message ID instead of committing", () => {
    const s = new DraftStore();
    s.ingest_message({ message_id: "M-1", store: "A", kind: "image", ref: "pic.png" });
    const resend = s.ingest_message({ message_id: "M-2", store: "A", kind: "image", ref: "pic.png" });
    assert.equal(resend.ok, true);
    assert.equal(resend.duplicate_warning, true);
    assert.equal(s.commits, 0);
    assert.equal(s.hasDuplicateWarning(), true);
  });
});

describe("E6/E8 scenarios", () => {
  for (const exp of ["E6", "E8"]) {
    it(`${exp}: all scenarios pass as written`, () => {
      const report = runExperiment(exp, join(root, "cases", exp.toLowerCase()));
      for (const c of report.cases) {
        assert.equal(c.pass, true, `${c.id} failed: ${JSON.stringify(c.checks)}`);
      }
    });
  }
});
