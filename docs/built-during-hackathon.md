# Built during the hackathon

Regenerate right before submitting: `node scripts/built-during.mjs` (git + gh only, no dependencies).

- Kickoff boundary (D-17): 2026-10-26 16:00Z (Mon Oct 26, 10:00 AM Honduras time). Commits dated before it are marked **pre-event**.
- Source: `origin/main` at `7bec048`, 146 commits, 0 dated before kickoff. Dates are author dates in UTC.
- There is no `pre-event-baseline` tag in the repo, so the boundary is the date, not a tag.
- Authors as `git log --format=%an` shows them: Angel-Rodas (117), kercmari (7), kerly (21), x (1).

## Pull requests

| # | Title | Author | Opened (UTC) | State | Merged (UTC) |
|---|---|---|---|---|---|
| #1 | Add planning docs, agent instructions and experiment cases | Angel-Rodas | 2026-10-29 15:15Z | MERGED | 2026-10-30 06:57Z |
| #2 | Add model and voice spikes with results | Angel-Rodas | 2026-10-29 15:15Z | MERGED | 2026-10-30 06:57Z |
| #3 | Add foundation: webhook intake, ordered processing, outbox, store isolation | Angel-Rodas | 2026-10-29 15:16Z | MERGED | 2026-10-30 06:57Z |
| #4 | Add engine commits, contract v1 draft and dev preparation list | Angel-Rodas | 2026-10-30 15:27Z | MERGED | 2026-10-30 20:02Z |
| #61 | Add console login with single-use invites and sessions | Angel-Rodas | 2026-10-30 22:49Z | MERGED | 2026-10-31 14:31Z |
| #62 | Order engine and fact memory: the save batch, read-before-guard, and the engine wired behind a fixture adapter | kercmari | 2026-10-31 08:17Z | MERGED | 2026-11-02 17:45Z |
| #63 | Add the customer order flow, replies, reading, media and console screens | Angel-Rodas | 2026-10-31 12:13Z | MERGED | 2026-11-03 16:53Z |
| #64 | Renumber our migrations to 0020-0022 to clear Angel's 0004-0017 | kercmari | 2026-11-02 18:28Z | MERGED | 2026-11-02 18:36Z |
| #65 | Fix sold-out wording, join with ni, and keep items without an amount out of Anotado | Angel-Rodas | 2026-11-03 23:04Z | MERGED | 2026-11-03 23:15Z |
| #66 | Add Probar como cliente to the console | Angel-Rodas | 2026-11-03 23:04Z | MERGED | 2026-11-03 23:16Z |
| #67 | Show read and typing on WhatsApp while the bot works | Angel-Rodas | 2026-11-03 23:04Z | MERGED | 2026-11-03 23:16Z |
| #68 | Make the daily Muse Spark budget a setting | Angel-Rodas | 2026-11-03 23:04Z | MERGED | 2026-11-03 23:15Z |
| #69 | Rewrite the README for judges | Angel-Rodas | 2026-11-03 23:04Z | MERGED | 2026-11-03 23:15Z |

## Not yet on origin/main (local branches)

Commits are counted against the parent branch; the stack order is the merge order.
`claude/stack-on-main`, `claude/demo-on-main` and `claude/owner-on-main` are the stack above merged onto main: their count leaves out the commits already counted in the rows they carry (`claude/dispatch` and its ancestors, `claude/demo-env`, and `claude/facturas` with `claude/console-negocio`), so only the commits new on that branch are listed, merges included.

| Branch | Parent | Commits | Head |
|---|---|---|---|
| claude/engine-issue-12 | origin/main | 4 | 58bac3c |
| claude/engine-facts | claude/engine-issue-12 | 7 | d2c835d |
| claude/console-pedidos | claude/engine-facts | 3 | 55cc21b |
| claude/change-requests | claude/console-pedidos | 6 | 230bb30 |
| claude/dispatch | claude/change-requests | 4 | 2846878 |
| claude/demo-env | claude/dispatch | 6 | cbce8de |
| claude/console-negocio | claude/dispatch | 4 | 56fb3a4 |
| claude/facturas | claude/console-negocio | 4 | 367813e |
| claude/engine-docs | origin/main | 4 | d94b256 |
| claude/stack-on-main | origin/main | 2 | 4fb745d |
| claude/demo-on-main | claude/stack-on-main | 4 | 47a2d5c |
| claude/owner-on-main | claude/demo-on-main | 2 | 3e7d97f |
| claude/adversary | claude/demo-on-main | 2 | dd3a342 |
| claude/engine-reads | claude/owner-on-main | 5 | fcb34b0 |
| claude/deed-graph | claude/owner-on-main | 10 | 3d61a80 |
| claude/deed-on-main | claude/engine-reads | 1 | 8ec9f87 |

## Every commit on origin/main

| Date (UTC) | Sha | Author | Subject |
|---|---|---|---|
| 2026-10-27 12:18Z | 495573e | Angel-Rodas | Add planning docs, agent instructions and experiment cases |
| 2026-10-27 13:50Z | 90e7731 | Angel-Rodas | Move experiment cases under spikes |
| 2026-10-27 13:50Z | ec2c108 | Angel-Rodas | Add spike runner with E1 and E3 results |
| 2026-10-27 13:50Z | 49823e6 | Angel-Rodas | Add E2 and E5 paperwork spikes with results |
| 2026-10-27 13:50Z | 2dd1981 | Angel-Rodas | Add trust core spike with E6 and E8 results |
| 2026-10-27 14:01Z | c4903ff | Angel-Rodas | Echo the full quantity phrase in E1-02 |
| 2026-10-27 15:06Z | 6513ce4 | Angel-Rodas | Record E4 voice results in status |
| 2026-10-27 15:06Z | 3d91c36 | Angel-Rodas | Add E4 voice spike with results |
| 2026-10-27 15:33Z | 6164813 | Angel-Rodas | Record E1 v4 results in status |
| 2026-10-27 15:33Z | 23e863d | Angel-Rodas | Drop filler and fix spoken corrections in E1 prompt |
| 2026-10-27 21:49Z | 20ce982 | Angel-Rodas | Add spike handoffs and record team offer |
| 2026-10-27 21:51Z | 0e88c83 | Angel-Rodas | Merge branch 'spike/runner-e1e3' |
| 2026-10-27 21:51Z | 5e5428b | Angel-Rodas | Merge branch 'spike/paperwork-e2e5' |
| 2026-10-27 21:51Z | 2eef1c3 | Angel-Rodas | Merge branch 'spike/trust-e6e8' |
| 2026-10-27 21:51Z | bd1176c | Angel-Rodas | Merge branch 'spike/voice-e4' |
| 2026-10-27 21:51Z | aaf2c36 | Angel-Rodas | Merge branch 'spike/e1-v4' |
| 2026-10-27 21:52Z | c95d29b | Angel-Rodas | Record spike merges in status and Muse log |
| 2026-10-28 06:28Z | 7002275 | kercmari | Create README.md |
| 2026-10-28 13:07Z | 0993b19 | Angel-Rodas | Add A1 voice decoding spike with results |
| 2026-10-28 13:07Z | 5240139 | Angel-Rodas | Merge branch 'claude/audio-decode' |
| 2026-10-29 02:35Z | 35f145f | Angel-Rodas | Merge planning docs into deed-ledger |
| 2026-10-29 02:35Z | d0b2b56 | Angel-Rodas | Merge experiments into deed-ledger |
| 2026-10-29 02:35Z | 2b2cf6f | Angel-Rodas | Add foundation: webhook intake, ordered processing, outbox, store isolation |
| 2026-10-29 15:12Z | 4b52d03 | Angel-Rodas | Update status and team split, drop local paths |
| 2026-10-30 06:57Z | 4c649b6 | kercmari | Merge pull request #1 from kercmari/claude/planning-docs |
| 2026-10-30 15:26Z | 6979b06 | Angel-Rodas | Save engine commits in the job's completion batch |
| 2026-10-30 15:27Z | 5ed312f | Angel-Rodas | Add contract v1 draft with fixtures |
| 2026-10-30 15:27Z | 3c02c5e | Angel-Rodas | Add dev preparation list on a pretend engine |
| 2026-10-30 15:27Z | 453d016 | Angel-Rodas | Update docs for the order assistant and today's work |
| 2026-10-30 18:00Z | 9b83491 | Angel-Rodas | Require reconfirmation for order changes, one open order per customer |
| 2026-10-30 19:17Z | 2c3b174 | Angel-Rodas | Add post guards to Commit, record D-40 and agreed contract answers |
| 2026-10-30 20:02Z | 6398982 | kercmari | Merge pull request #4 from kercmari/claude/job-outcome-commits |
| 2026-10-30 22:49Z | dfce488 | Angel-Rodas | Add console login with single-use invites and sessions |
| 2026-10-31 02:53Z | 75c7c74 | Angel-Rodas | Treat every sender as a customer and wire the order handler |
| 2026-10-31 02:53Z | dd6591a | Angel-Rodas | Add console shell and Empleados |
| 2026-10-31 02:53Z | 6452973 | Angel-Rodas | Add Spanish replies, the claim check and reply buttons |
| 2026-10-31 02:53Z | 02bd4d9 | Angel-Rodas | Add order reading with Muse Spark and a daily spend cap |
| 2026-10-31 02:53Z | 2ff50d0 | Angel-Rodas | Merge branch 'claude/customers' into claude/integration |
| 2026-10-31 02:56Z | 42cbf02 | Angel-Rodas | Merge branch 'claude/replies' into claude/integration |
| 2026-10-31 02:57Z | 5283878 | Angel-Rodas | Merge branch 'claude/reading' into claude/integration |
| 2026-10-31 03:08Z | 99b89c7 | Angel-Rodas | Queue the two-minute message for stalled bursts |
| 2026-10-31 03:08Z | 5806f19 | Angel-Rodas | Download media and transcribe voice notes |
| 2026-10-31 03:10Z | 888cce6 | Angel-Rodas | Add the console reader and the Anotar screen |
| 2026-10-31 03:13Z | 4c6bddc | Angel-Rodas | Connect reading, the engine and replies in the order flow |
| 2026-10-31 03:13Z | 3c429f9 | Angel-Rodas | Merge branch 'claude/console-reader' into claude/integration |
| 2026-10-31 03:13Z | d9f94dd | Angel-Rodas | Merge branch 'claude/two-minute-message' into claude/integration |
| 2026-10-31 03:15Z | 84e61bd | Angel-Rodas | Merge branch 'claude/media' into claude/integration |
| 2026-10-31 03:17Z | e412877 | Angel-Rodas | Add the first message, ALTO, handoff and deletion |
| 2026-10-31 03:21Z | db877bb | Angel-Rodas | Merge branch 'claude/first-message' into claude/integration |
| 2026-10-31 03:26Z | 0bb5cd7 | Angel-Rodas | Save console taps with the customer messages they cause |
| 2026-10-31 03:27Z | b19e490 | Angel-Rodas | Read photos and voice notes in customer orders |
| 2026-10-31 03:28Z | 5241bc0 | Angel-Rodas | Merge branch 'claude/console-notices' into claude/integration |
| 2026-10-31 03:31Z | f30af2f | Angel-Rodas | Merge branch 'claude/media-in-orders' into claude/integration |
| 2026-10-31 11:09Z | 6358228 | Angel-Rodas | Harden console login forms and the invite script |
| 2026-10-31 11:53Z | 91e4899 | Angel-Rodas | Merge branch 'claude/console-login' into claude/integration |
| 2026-10-31 12:03Z | 94939d1 | Angel-Rodas | Keep member names per store and remove staff in one batch |
| 2026-10-31 12:05Z | 8cf8ddb | Angel-Rodas | Refuse cut-off and oversized voice notes; count only live replies for the slow notice |
| 2026-10-31 12:08Z | c9db45b | Angel-Rodas | Bound model spend and check every reading against its evidence |
| 2026-10-31 12:11Z | ec1de58 | Angel-Rodas | Gate every handler, refuse deleted senders inside the intake batch, recheck late media |
| 2026-10-31 12:11Z | 0199673 | Angel-Rodas | Update status for Saturday |
| 2026-10-31 12:11Z | dd862ab | Angel-Rodas | Merge branch 'claude/fix-console' into claude/integration |
| 2026-10-31 12:11Z | b6223b6 | Angel-Rodas | Merge branch 'claude/fix-reading' into claude/integration |
| 2026-10-31 12:11Z | 9e34f9e | Angel-Rodas | Merge branch 'claude/fix-media' into claude/integration |
| 2026-10-31 12:11Z | 759a6a0 | Angel-Rodas | Merge branch 'claude/fix-controls' into claude/integration |
| 2026-10-31 12:13Z | 039104b | Angel-Rodas | Drop local paths from handoffs |
| 2026-10-31 12:56Z | 4ff74f9 | Angel-Rodas | Add a terminal chat for the local simulator |
| 2026-10-31 13:05Z | bd5f343 | Angel-Rodas | Add an opt-in AI mode and a demo product list to the simulator |
| 2026-10-31 13:09Z | 5d7d890 | Angel-Rodas | Regenerate Worker types |
| 2026-10-31 13:37Z | 4d78631 | Angel-Rodas | Merge branch 'claude/chat-sim' into claude/integration |
| 2026-10-31 13:38Z | 5f5a29d | Angel-Rodas | Add the deploy checklist |
| 2026-10-31 13:45Z | f6c008b | Angel-Rodas | Run the pretend engine on D1 behind login for the demo |
| 2026-10-31 14:31Z | 1e533ef | kercmari | Merge pull request #61 from kercmari/claude/console-login |
| 2026-10-30 20:20Z | 7c4cbf8 | kerly | Add ledger tables migration with negative-stock and duplicate-fact tests |
| 2026-10-30 20:22Z | 63afad3 | kerly | Add fact commit types and the ledger that builds their batch statements |
| 2026-10-30 20:23Z | 20d00ec | kerly | Run a commit's post guards in the batch that completes the job |
| 2026-10-30 20:25Z | d35b9e1 | kerly | Add the receipt slice, record D-41 and what the chain's trace says |
| 2026-10-30 20:44Z | 83c6f52 | kerly | Read before every guard so the owner gets an answer, not a failure |
| 2026-10-30 21:27Z | d44f175 | kerly | Add orders migration with operations as the idempotency anchor |
| 2026-10-30 23:07Z | f1f746c | kerly | Let the orders migration hold every contract case and test all twelve mutations |
| 2026-10-30 23:12Z | 419268d | kerly | Add pure order rules: versions, line labels and exact totals |
| 2026-10-31 01:17Z | 4567fbf | kerly | Make an unknown delivery fee, fractional price or empty basket total null |
| 2026-10-31 01:25Z | 39c1b88 | kerly | Add the order engine: a burst becomes a versioned order, each tap saves once |
| 2026-10-31 01:32Z | 87db514 | kerly | Check order ownership before answering a repeated operation key |
| 2026-10-31 01:36Z | 62d1ce1 | kerly | Derive customer operation keys from the action and reject any other key |
| 2026-10-31 01:36Z | e6864d9 | kerly | Add the derived operation key check to the order engine |
| 2026-10-31 01:42Z | 92d53e7 | kerly | Record the order engine chain in status and add D-43, D-44 |
| 2026-10-31 07:39Z | b4aa6ac | kerly | Refuse a cancellation whose target is foreign, missing or already closed, and answer a repeat |
| 2026-10-31 07:59Z | 08ef369 | kerly | Wire the order engine into the default job handler through a fixture perception adapter |
| 2026-10-31 08:06Z | 245fad7 | kerly | Read the order intent only from the whole message and list the deploy as missing |
| 2026-10-31 08:08Z | c035e87 | kerly | Match the change intent only against the whole message |
| 2026-10-31 08:11Z | df2f6c6 | kerly | Drop the change intent from the fixture perception adapter |
| 2026-10-31 14:35Z | 9a1f25c | kerly | Point the migration comments at the renumbered ledger file |
| 2026-10-31 19:10Z | 187438e | Angel-Rodas | Fix review findings from the PR polish pass |
| 2026-10-31 19:10Z | af6045a | Angel-Rodas | Merge branch 'claude/pretend-online' into claude/pr63-polish |
| 2026-10-31 19:34Z | 0cbee76 | Angel-Rodas | Answer customer questions on stock, price and hours from records |
| 2026-10-31 19:34Z | 7137a97 | Angel-Rodas | Add delivery to a saved place |
| 2026-10-31 19:36Z | 859146b | Angel-Rodas | Merge branch 'claude/customer-questions' into claude/pr63-polish |
| 2026-11-01 12:48Z | a05c8d5 | x | tmp: menu |
| 2026-11-02 17:45Z | d014bab | kercmari | Merge pull request #62 from kercmari/claude/fact-ledger |
| 2026-11-02 18:25Z | c853b68 | kerly | Renumber our migrations to 0020-0022 to clear Angel's 0004-0017 |
| 2026-11-02 18:36Z | c15155b | kercmari | Merge pull request #64 from kercmari/claude/migrations-0020 |
| 2026-11-02 18:51Z | 3d09e59 | Angel-Rodas | tmp: local work Nov 2 |
| 2026-11-02 18:56Z | a0ddb25 | Angel-Rodas | Merge team main into local work |
| 2026-11-03 02:58Z | 89f585e | Angel-Rodas | Fold in conversation QA fixes and sim photo and voice |
| 2026-11-03 02:59Z | c2b7999 | Angel-Rodas | Add shared planner types |
| 2026-11-03 03:19Z | 797b2b8 | Angel-Rodas | Keep list items cut by the photo edge and ask about them |
| 2026-11-03 03:19Z | c6c9f9c | Angel-Rodas | Merge branch 'claude/list-photo-bug' |
| 2026-11-03 03:23Z | bdcdb29 | Angel-Rodas | Search the whole catalog and learn store-approved aliases |
| 2026-11-03 03:23Z | 86f992d | Angel-Rodas | Merge branch 'claude/retrieval-aliases' |
| 2026-11-03 03:43Z | 01e42e0 | Angel-Rodas | Let a planner call decide the next conversation step |
| 2026-11-03 03:43Z | d015af5 | Angel-Rodas | Merge branch 'claude/planner-spine' |
| 2026-11-03 04:08Z | 87b0d77 | Angel-Rodas | Wire whole-catalog retrieval and learned aliases into the planner |
| 2026-11-03 04:08Z | a51ba30 | Angel-Rodas | Merge branch 'claude/planner-spine' |
| 2026-11-03 04:28Z | 7b0b025 | Angel-Rodas | Close the planner review findings |
| 2026-11-03 04:28Z | 1ec7db1 | Angel-Rodas | Merge branch 'claude/planner-spine' |
| 2026-11-03 04:34Z | 3a274a3 | Angel-Rodas | Set reasoning effort and prompt cache keys per model call |
| 2026-11-03 04:38Z | 0670e4e | Angel-Rodas | Merge branch 'claude/latency' |
| 2026-11-03 05:00Z | a6eab4e | Angel-Rodas | Add eval suite with one completion score and a classic baseline |
| 2026-11-03 05:00Z | 944a5bc | Angel-Rodas | Merge branch 'muse/eval-suite' |
| 2026-11-03 05:01Z | 240de55 | Angel-Rodas | Record the eval suite in the Muse log |
| 2026-11-03 05:06Z | d20e272 | Angel-Rodas | Read captions, gate media phrases, and plan text in one call |
| 2026-11-03 05:06Z | 8213e38 | Angel-Rodas | Merge branch 'claude/planner-spine' |
| 2026-11-03 05:57Z | b8af284 | Angel-Rodas | Point the Worker at the remote D1 database |
| 2026-11-03 07:25Z | 902515c | Angel-Rodas | Resolve option answers, read voice like text, and remember the last answer |
| 2026-11-03 07:25Z | 0cd63f1 | Angel-Rodas | Merge branch 'claude/planner-spine' |
| 2026-11-03 07:26Z | 57a2c0a | Angel-Rodas | Merge branch 'claude/agentic' into claude/first-deploy |
| 2026-11-03 13:04Z | 0445da1 | Angel-Rodas | Add member-only WhatsApp test commands |
| 2026-11-03 13:04Z | f1a8d33 | Angel-Rodas | Merge branch 'claude/planner-spine' |
| 2026-11-03 13:06Z | 739d3dd | Angel-Rodas | Merge branch 'claude/agentic' into claude/first-deploy |
| 2026-11-03 13:47Z | d5feba0 | Angel-Rodas | Echo only new items, space out replies, and add a reply footer |
| 2026-11-03 13:47Z | dcbbf00 | Angel-Rodas | Merge branch 'claude/planner-spine' |
| 2026-11-03 13:49Z | fcbdd3f | Angel-Rodas | Merge branch 'claude/agentic' into claude/first-deploy |
| 2026-11-03 14:21Z | 200215b | Angel-Rodas | Drop per-pound sizes and unit tags from customer product names |
| 2026-11-03 14:21Z | 15c09d0 | Angel-Rodas | Merge branch 'claude/planner-spine' |
| 2026-11-03 14:26Z | 136aade | Angel-Rodas | Offer writing instead when a photo or voice note can't be read |
| 2026-11-03 14:30Z | 174d0cf | Angel-Rodas | Accept WhatsApp voice notes without an end-of-stream page; verify downloads |
| 2026-11-03 14:30Z | 6a79efc | Angel-Rodas | Merge branch 'claude/voice-eos' |
| 2026-11-03 14:32Z | 1f05712 | Angel-Rodas | Merge branch 'claude/agentic' into claude/first-deploy |
| 2026-11-03 14:35Z | 14dd738 | Angel-Rodas | Merge branch 'claude/first-deploy' into claude/agentic |
| 2026-11-03 14:39Z | d178a65 | Angel-Rodas | Bring the status up to the live deploy |
| 2026-11-03 14:59Z | 623dcdb | Angel-Rodas | Close the final review findings |
| 2026-11-03 14:59Z | 6b71c37 | Angel-Rodas | Merge branch 'claude/planner-spine' |
| 2026-11-03 15:04Z | 2a71f6b | Angel-Rodas | Show the full delivery place and log queue delivery lag |
| 2026-11-03 15:04Z | 2a62649 | Angel-Rodas | Merge branch 'claude/voice-eos' |
| 2026-11-03 15:35Z | c408870 | Angel-Rodas | Deploy the demo on every merge to main |
| 2026-11-03 16:53Z | 7bec048 | kercmari | Merge pull request #63 from HackMet/claude/order-assistant |
