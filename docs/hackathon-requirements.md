# Hackathon requirements

Checked Monday, October 26, 2026, around 8:00 AM Honduras time, two hours before the kickoff stream. The Official
Rules let the organizers change the terms, so recheck this page after the kickoff and again before submitting.
Discord announcements and organizer emails were not available to this check.

Each finding is labeled:

- **Confirmed**: stated by an official source below.
- **Ours**: supported by our own documents (the application we submitted on October 15, the PRD).
- **Unverified**: not settled by any source we could read. Don't build on it; ask.

## Sources

| Ref | Source | What it is |
|---|---|---|
| S1 | [Participant Guide](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details) (Cerebral Valley) | Rules, schedule, judging, prizes, credits. Read live on Oct 26; a PDF snapshot from 6:32 AM is kept locally at `docs/source/cv-participant-guide-2026-10-26.pdf` (gitignored: it embeds participant-only form links). |
| S2 | [Hackathon Terms & Conditions ("Official Rules") and Event Waiver](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) | The binding contract, dated October 25, 2026. Read live on Oct 26. No snapshot is saved yet; Angel saves one on day 0 ([plan](hackathon-plan.md#day-0-today-angel)), kept local like the guide. |
| S3 | [Meta event page](https://dev.meta.ai/events/global-hackathon) | Dates, tracks, eligibility. Still says the Official Rules "will be published"; S2 is where they are. |
| S4 | [Cerebral Valley event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) | Event window and track descriptions. |
| S5 | [Meta Model API docs](https://dev.meta.ai/docs/overview) and [Muse Code docs](https://dev.meta.ai/docs/muse-code) | Models, prices, tool behavior. Details in [architecture.md](architecture.md) and [workflow.md](workflow.md). |

## Dates

The organizers publish Eastern Time. Honduras stays on CST (UTC−6) all year, while the US leaves daylight time on
Sunday, November 1. So the gap is 2 hours until October 31 and 1 hour from November 1.

| What | Official (ET) | Honduras | Source |
|---|---|---|---|
| Kickoff stream: rules, prizes, judging | Mon Oct 26, 12:00 PM | Mon Oct 26, 10:00 AM | S1, S4 |
| Event window | Oct 26, 12:00 PM to Nov 4, 9:00 PM | Oct 26, 10:00 AM to Nov 4, 8:00 PM | S4 |
| "Building period" | Oct 27 to Nov 4 | | S1 (see U4) |
| Agents 101: Build a Multimodal AI Agent | Tue Oct 27, 12:00–1:00 PM | 10:00–11:00 AM | S1 |
| Agents 102: Best Practices for Verifiable Agents | Wed Oct 28, 12:00–1:00 PM | 10:00–11:00 AM | S1 |
| Building Specialized Intelligence on Fireworks with Muse open models | Fri Oct 30, 12:00–1:00 PM | 10:00–11:00 AM | S1 |
| Discord office hours (#office-hours, text only, weekdays) | 10:00–11:00 AM | 8:00–9:00 AM until Oct 30; 9:00–10:00 AM from Nov 2 | S1 |
| Last full day for submission and technical questions | Tue Nov 3 | Tue Nov 3 | S1 |
| **Submission deadline** (Cerebral Valley platform; late entries not considered) | **Wed Nov 4, 9:00 PM** | **Wed Nov 4, 8:00 PM** | S1, S4 |
| Deadline to claim the $150 Meta Model API credits | Wed Nov 4, 9:00 PM | Wed Nov 4, 8:00 PM | S1 |
| Judging | Nov 5–8 (S1); Nov 4–8 (S3) | | S1, S3 |
| Closing ceremony: top 10 (5 per track), live finals, winners | Mon Nov 9, 12:00 PM | Mon Nov 9, 11:00 AM | S1 |
| Bonus prizes announced | on or about Nov 10 | | S2 |
| Community vote winner | Mon Nov 16 | | S1 |

The kickoff and deadline in our brief (October 26 kickoff, November 4 at 9:00 PM ET) match S1, S2 and S4.

## The critical question: what Meta technology is required

Two different things, with different obligations:

**1. Meta models inside the product: required. Confirmed.**

- S1 §1 says the project must incorporate Meta's models, then lists the routes: Muse Spark series, Muse Wonder,
  Muse Image, Muse Voice Transcribe and SAM 3.1 through the Meta Model API; the open-weight models Muse Glimmer and
  Muse Spark Open; and the Muse Code coding agent.
- S2 (Event Overview): participants build with Meta AI products, naming Muse Spark, Glimmer and SAM 3.
- S1 §8, Stage One is pass/fail: the project must reasonably fit a theme and reasonably use the Meta Model API
  and/or Meta's open-weight models to build the project during the hackathon. Failing it ends the entry.
- S1 §8 and S2 score "Use of Meta AI Tooling" at 25%: how creatively we used Meta's AI tooling and whether we went
  beyond a basic integration.

Our answer: Muse Spark (invoice images and intent, with structured output) and Muse Voice Transcribe (voice notes),
called through the Meta Model API, carry the core workflow. Without them the product does nothing, so they are not
decorative. See [hackathon-plan.md](hackathon-plan.md) for how we push past a basic integration.

**2. Muse Code for writing our code: not required by any official text we found. Recommended.**

- S1 lists Muse Code among the ways to use Meta technology ("code faster with Muse Code"), right after the
  sentence that makes Meta models mandatory. That placement is the only hint of an obligation.
- S2 never mentions Muse Code. The Stage One gate names only the Meta Model API and open-weight models.
- Unverified: whether judges give credit for Muse Code under "Use of Meta AI Tooling".

Our position: we don't claim Muse Code is mandatory, and we don't claim compliance because of it. Until the
organizers answer, we take the conservative route: Muse Code does real, separately scoped engineering tasks, and each
one is logged with commits, tests and a transcript in [muse-contributions.md](muse-contributions.md). No artificial
activity.

**3. Other coding agents (Claude Code, Codex): no restriction found.**

- No rule mentions AI-generated code or limits coding tools.
- S2 (Hackathon Submission): the submission must be our original work and solely ours. Help from a third party is
  allowed if the components remain our own work and we own all rights to them. Open-source software is allowed when
  its licenses are followed and the submission builds on it.
- Unverified: each coding tool's terms on who owns its output. Check before submitting (U9).

## Requirements

| # | Requirement | Status | Source | What it means for us |
|---|---|---|---|---|
| R1 | Build toward one problem statement: "Build for Your World" or "Push the Frontier" | Confirmed | S1 §1 | "Build for Your World": a problem we know firsthand, a notebook-run store in Tocoa. Ours: application. |
| R2 | Incorporate Meta's models; Stage One requires reasonable use of the Meta Model API and/or open-weight models | Confirmed | S1 §1, §8; S2 | Spark and Voice Transcribe in the core flow (D-09, D-10). |
| R3 | Judged on Impact 30%, Use of Meta AI Tooling 25%, Technical Depth & Execution 20%, Demo 25%; top 5 per track go to a final round | Confirmed | S1 §8; S2 | Shapes the scope cut in the plan. |
| R4 | Repository must be public | Confirmed | S1 §4 | Every commit is published. No secrets or real data, ever. License not chosen yet. |
| R5 | Team of up to 4; solo allowed; everyone who worked on it listed in the submission | Confirmed | S1 §4, §7; S2 | Confirm team members (application was solo). |
| R6 | The demo may only highlight what was built during the hackathon, and judges must be able to tell what that is. Failing to clearly identify original contributions results in immediate disqualification, at the judges' sole discretion | Confirmed | S1 §4 | README section "Built during the hackathon"; a first commit with only planning docs and agent config, tagged `pre-event-baseline`; product code only after the kickoff (D-17). |
| R7 | New work only. Startups may build on existing codebases if they mark what's new | Confirmed | S1 §4 | Indie entry: write everything during the event; copy no code from other repos (D-13). |
| R8 | Disqualified if the project breaks legal, ethical or platform policies, or uses code, data or assets without rights | Confirmed | S1 §4 | Johan's consent for real data; license checks on dependencies; WhatsApp policy (see [security-privacy.md](security-privacy.md)). |
| R9 | Avoid generic "anti-projects": basic RAG apps, simple image analyzers, and others | Confirmed | S1 §4 | Invoice reading alone could look like a simple image analyzer. The verified review-and-ledger workflow must be the visible core of the demo. |
| R10 | Submit on the Cerebral Valley platform by Nov 4, 9:00 PM ET; one project per team, entered by its Representative | Confirmed | S1 §7; S2 | Target submitting by noon Honduras time on Nov 4. |
| R11 | A three-minute demo video of the features, code and functionality built during the hackathon. Judges use the video, the code and the live product | Confirmed | S1 §7 | The product must be live and reachable at judging, not only recorded (see U7). |
| R12 | Repository public, video link accessible | Confirmed | S1 §7 | Test both while logged out before submitting. |
| R13 | One track per participant and per submission | Confirmed | S2 | Indie, as applied on Oct 15 (D-08). Ours: application. Confirm on the form (U5). |
| R14 | Indie track is judged on creativity, technical ambition and whether it works | Confirmed | S3, S4 | |
| R15 | Eligibility: 18+, age of majority, not sanctioned or in a listed country or region; Meta and Cerebral Valley staff and government-affiliated people excluded | Confirmed | S2 | Honduras is not listed. |
| R16 | We keep ownership but grant the organizers a perpetual, irrevocable, worldwide, royalty-free license to use, change and publish the submission for any purpose | Confirmed | S2 | Treat the repo, video and pitch as public and reusable by Meta. |
| R17 | Nothing shared during the event is confidential (code, ideas, pitches, Discord), and it is licensed to the organizers | Confirmed | S2 | Don't share Johan's numbers, private plans or anything confidential in Discord, the repo or the video. |
| R18 | The organizers may use participants' names, likeness, voice, chat messages, screen shares and submissions in any media, indefinitely | Confirmed | S2 | If Johan appears in the video, his likeness falls under this too. Ask him explicitly. |
| R19 | $150 in Meta Model API credits: claim individually through the form by Nov 4, 9:00 PM ET; distributed in batches; a credit card is required to make API calls; spend-limit notification available; valid for a 10-day development window; read the Credit Terms first | Confirmed | S1 §5; S2 | Claim today. The Credit Terms are a PDF linked from S2 that we have not read (U3). |
| R20 | Partner credits are not guaranteed: Baseten $100 (up to 2,000 people, reviewed), Modal $100 (first 1,000), Fireworks $25 (shortlist). On Baseten use `meta-models/muse-spark-open-1026` | Confirmed | S1 §6 | Only matters if we run open-weight models. |
| R21 | Bonus prizes: Most Viral (X post, engagement until Nov 8), Best Build on Meta Open Weight Models, Community Vote, Best Agentic Use-Case, Best Creative Build (Muse Image or Muse Wonder). The organizers may change the categories | Confirmed | S1 §9; S2 | Natural fits: Best Agentic Use-Case (multi-step, verified workflow) and Community Vote. Most Viral is optional. |
| R22 | Code of conduct applies in Discord, calls and shared repos | Confirmed | S2 | |
| R23 | Winners provide a W-8BEN (non-US) and pay transfer fees and taxes | Confirmed | S2 | Only relevant if we win. |
| R24 | The submission must be our original work, solely ours, and must not infringe anyone's rights. Third-party technical help is allowed if the components remain our own work. Open source is allowed under its license when the submission builds on it | Confirmed | S2 | No copied code (D-13); check each coding tool's output-ownership terms (U9). |

## Unverified: ask or check before relying on it

| # | Question | Why it matters | Current handling |
|---|---|---|---|
| U1 | Is Muse Code expected, and does it count toward "Use of Meta AI Tooling"? | Could affect 25% of the score | Use Muse Code for real tasks and log them. Ask. |
| U2 | Do the $150 credits cover Muse Code when it's signed in with an API key? | Cost of Muse usage | Muse auth docs say API-key use is billed pay-as-you-go to the Meta Model API account; credits are not mentioned. Ask. |
| U3 | What do the Credit Terms say (when the 10-day window starts, what usage counts)? | Credits could expire before Nov 4 | Credits claimed Oct 26. Check the expiry date on the Billing page and read the Credit Terms PDF linked from S2. |
| U4 | May product code start on Oct 26 after the kickoff, or only on Oct 27 ("Building period")? | "New work only" | Plan: start after the kickoff, inside the event window (D-17, proposed). The strictest reading is Oct 27. Ask. |
| U5 | Does our acceptance and the submission form show the Indie track? | One track only | Check the acceptance email and the form. |
| U6 | Are planning documents written before the event acceptable in the repo? | "New work only" | They describe plans, not features. The first commit holds only planning docs and agent config, tagged `pre-event-baseline`. |
| U7 | How do judges try the "live product" of a WhatsApp-first app? WhatsApp test numbers only deliver to a few registered recipients (cap to verify) | Demo is 25% | Plan a read-only web view with a synthetic demo store, plus the video. Ask. |
| U8 | Which fields does the submission form ask for? | Packaging | The submit link redirected to the event page on Oct 26 (submissions likely not open yet). Recheck after the kickoff. |
| U9 | Do the terms of Claude Code, Codex and Muse Code give us ownership of what they produce? | S2 ownership warranty | Not checked. Check before submitting. |

### Questions to post

Drafts. Angel posts them in #questions or #office-hours.

1. Is using Muse Code during development required, or only recommended? Does it count toward "Use of Meta AI
   Tooling"?
2. Do the $150 Meta Model API credits cover Muse Code usage when it's signed in with an API key?
3. When does the 10-day credit window start: when we claim, or when the credits land?
4. Can we start writing code on Oct 26 after the kickoff, or does building start on Oct 27?
5. Our product runs on WhatsApp, and test numbers only reach registered recipients. Is a demo video plus a public
   web view of a demo store enough for the "live product"?

## Compliance status

Not compliant yet, because nothing is built. The checklist that turns these requirements into a submission is in
[hackathon-plan.md](hackathon-plan.md#submission-checklist). Don't describe the project as compliant until every item
there is checked.
