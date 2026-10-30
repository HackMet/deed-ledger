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

No entries yet. The first planned task is T2, voice notes to text ([plan](hackathon-plan.md#t2-voice-notes-to-text-muse-code-the-first-muse-task)).
