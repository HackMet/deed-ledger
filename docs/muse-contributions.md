# Muse Code contributions

A record of work done with Meta's Muse Code in this repo. "Use of Meta AI Tooling" is 25% of the score, and judges
must be able to check what we say, so every row has to point to real commits, real test runs and a saved session.
Record only what happened. No placeholder or demonstration activity.

## How to record a task

1. Muse works on its own branch and worktree (`muse/<slug>`), as described in [workflow.md](workflow.md).
2. At the end of the session, export it:
   `/export transcript --redacted --out ../hackathon-evidence/<date>-<slug>.txt`.
   This saves it outside the repo. Review it before sharing anything from it.
3. Angel reviews and commits Muse's changes (Muse's sandbox can't write to `.git`), then merges the branch with a
   merge commit, not a squash, so the branch name stays in the history. List the commits below.
4. Say what Claude or Angel changed afterwards, so credit stays accurate.

## Log

| Date | Task | Branch and commits | What Muse Code did | Tests (command → result) | Changed after review | Evidence |
|---|---|---|---|---|---|---|
| Oct 27, 2026 | E1-E8 orchestration: contracts + 53 fixed cases (Oct 26), spikes/ move, 3 parallel lanes, reruns, synthesis, KB cards | spike/runner-e1e3, spike/paperwork-e2e5, spike/trust-e6e8 (all uncommitted; Angel commits) | Orchestrator session: wrote contracts/cases, ran lanes A/B/C isolated, re-ran full v3/v2 suites + trust tests, wrote cards | JSON validator 54 OK; E1 14/15, E3 10/10, E2 5/6, E5 9/9, trust 8/8 + 7/7 scenarios | None yet | Transcript export pending (Angel) |
| Oct 27, 2026 | E4 voice spike + E1-02 rescore + Workers conversion research | spike/voice-e4 (uncommitted; Angel commits) | Built spikes/voice (ASR client + 2-step runner), transcribed 6 notes, scored vs E1, rescored E1-02 offline, researched decode options | Transcription 6/6, interpretation 4/6 strict, E1-02 PASS offline | None yet | Transcript export pending (Angel) |
| Oct 27, 2026 | e1-v4 filler + spoken-correction fix | spike/e1-v4 (uncommitted; Angel commits) | Wrote 6 held-out E1 cases first, then e1-v4 prompt + echo convention, ran 21-case suite + E4 interpret re-run | E1 19/21 (15/15 orig, 4/6 held-out), E4 interpret 6/6 | None yet | Transcript export pending (Angel) |
