# Deed core

A small black box. It takes entries in and gives a verdict out. It holds no business nouns: a new industry is a
new policy, never an edit to the core.

## What goes in

An `Entry` (`types.ts`): one append-only fact the host asks to admit.

- `factId`, `kind` and `operationKey`: the fact's id, its kind (an opaque string) and its one logical operation.
  A second entry with the same key is a duplicate.
- `actor`, `validFromMs`, `body`: who asked, business time and the payload. The core stores them and never reads them.
- `evidence`: what the fact rests on, each `{ kind, refId, contentSha256 }`. The kinds are opaque strings.
- `dependsOn`: the facts this one was decided with. Each must be live.
- `sameBatch` (optional): dependencies written earlier in the same host batch, checked again after the writes.
- `closes`: `{ factId, reason: "cancelled" | "superseded" }` for the fact this one closes, or `null`.
- `agentId` (optional): stamped by the host; stored, never read.

## What comes out

A `Verdict` (`types.ts`): `{ admitted: true, factId }`, or `{ admitted: false, reason }`. The core's own reasons are
`duplicate`, `unknown_kind`, `evidence_incomplete`, `dependency_not_live` and `closes_not_live`. A host may add
reasons of its own in its extension.

Liveness (`liveness.ts`): a fact is dead when it is missing, or closed in a way that kills it. A cancellation always
kills. A supersede kills unless the superseding fact is itself an ancestor, so v2 can depend on v1, supersede it,
and keep whatever rests on both.

Pairing (`pair.ts`): `pair(claim, witnesses, matcher)` returns `paired`, `unpaired`, `in_doubt` or `blocked`.
Silence is `in_doubt`, never `unpaired`.

Re-check (`recheck.ts`): `entryFile` stores the input with the verdicts a judge gave it; `recheck` re-runs the judge
on the input alone and reports every row that differs.

## The policy

The only thing an industry writes. Plain data, one entry per kind it admits:

```ts
const policy: Policy = {
  kinds: {
    sample_taken: { evidence: [{ require: [{ kind: "clinician", min: 1, max: 1 }] }] },
    result_corrected: {
      evidence: [
        { when: { kind: "lab_device", min: 2 }, require: [{ kind: "lab_device", min: 2 }, { kind: "clinician", min: 1 }] },
        { require: [{ kind: "clinician", min: 1, max: 1 }] },
      ],
    },
  },
};
```

An `EvidenceRule` is `{ when?, require }`. The first rule whose `when` holds decides, and it must then be satisfied.
A rule without `when` always holds. No rule holding refuses the entry. Zero evidence is always refused, whatever the
policy says.

## Adoption example

A host with its own policy, on the memory store:

```ts
import { MemoryLedgerStore, type Entry, type Policy } from "./deed-core";

const policy: Policy = {
  kinds: {
    shipment_declared: { evidence: [{ require: [{ kind: "carrier_scan", min: 1 }] }] },
    customs_cleared: { evidence: [{ require: [{ kind: "officer", min: 1, max: 1 }] }] },
  },
};

const store = new MemoryLedgerStore(policy);

const declared: Entry = {
  factId: "f-1", kind: "shipment_declared", operationKey: "decl-1", actor: "agent-7",
  validFromMs: Date.now(), body: { weightKg: 12 },
  evidence: [{ kind: "carrier_scan", refId: "scan-88", contentSha256: null }],
  dependsOn: [], closes: null,
};

const verdict = await store.admit("tenant-a", declared);
// verdict: { admitted: true, factId: "f-1" }
```

On D1, the host runs `schema.sql` on its database and uses `D1LedgerStore` (`d1-store.ts`) as it is. Its `admit`
takes an optional `HostExtension` (`store.ts`): guards, statements and columns that join the same atomic batch. A
guard with a `reason` refuses with that reason as the verdict; a host that writes its own batch calls `planEntry`
for the core's part and runs it with its own fence.

## What it does not do

- It does not decide what is true. It decides what may be written, given the evidence and the policy.
- It does not cascade. A closed fact kills its descendants by the liveness rule, nothing is deleted.
- It does not read a clock, call a model, or do I/O in the judge. The store takes the time it is given.
- It does not know any kind, evidence kind or reason string of a business. Those belong to the policy and the host.
- It does not sign, hash-chain or authenticate entries. The host does that if it needs to.
- It does not limit which kind closes which, or require a dependency or a closure. A host that needs that adds an
  extension guard, which exists only on D1.
- It does not judge whether a witness is real. A requirement with no bound is always true, and an empty `refId` counts.
- It does not validate a host's extension. Its statements run in the batch as written, so an extension can insert a
  fact with no evidence: the host is trusted with what it writes beside the core's rules.
