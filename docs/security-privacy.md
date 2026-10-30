# Security, privacy and legal readiness

A working checklist, written October 26, 2026. It is not legal advice and not a claim of compliance. Items marked
**verify** need a qualified check before any commercial use. The threat model in [PRD §9](PRD.md#09-security-privacy-and-responsible-ai)
still applies; this file adds what the build and the hackathon need.

## 1. Data ownership and tenant isolation

- Each store (business) owns its records. Every row carries `business_id` (and `location_id` where it applies);
  composite keys stop references across stores (PRD §8.3).
- The store comes from the sender's verified membership or a signed token. Never from model output, a URL or
  message text.
- Automated cross-store attack tests (PRD §10.3 test 8, plan M8) must pass before any demo with real data.
- We, as operators, have no routine access to a store's content. Debugging uses IDs and redacted logs.

## 2. Authorization for inventory changes

- Only members whose role allows it confirm stock changes. A confirmation is bound to store, actor, action and
  draft revision, and it expires (FR-07).
- Unknown WhatsApp numbers get a polite fixed reply and no data (FR-01).
- Anomaly flags for unusually large changes (PRD §9.1) come after the hackathon.

## 3. Consent before any real data

Before the first real invoice, voice note, photo or filming, get Johan's explicit consent in writing (a WhatsApp
message is enough) for:

- sending invoices, product photos and his voice notes to Meta's models;
- keeping them during the hackathon and deleting them afterwards, or the retention he chooses;
- filming him and the store for the demo video, knowing the Official Rules let Meta and Cerebral Valley reuse
  submissions and recordings indefinitely;
- naming the store, the town and himself in public, including the product name "Johan AI".

If he says no to naming, the README, the PRD and the product name must change before the first commit, because git
history keeps everything.
Until consent arrives: synthetic data only.

**Status:** Johan agreed on Oct 26 (per Angel), covering all four points. Keep his written message as the record.
Anyone else who will see real data, a teammate for example, needs his OK too.

## 4. Suppliers and customers

- Invoices carry supplier names, prices and sometimes tax IDs, which is other businesses' commercial data. Blur or
  replace them in the video, and never commit them.
- The MVP stores no customer data (fiado is out of scope). Voice notes can pick up bystanders, so ask Johan to record
  away from customers.
- The product never messages the store's customers or suppliers.
- Store numbers are sensitive in Honduras (extortion risk). The demo shows no real cash or totals without Johan's
  OK.

## 5. Retention and deletion

- Real media goes in a private R2 bucket under the store's prefix. No public URLs; access only through short-lived
  signed links.
- Hackathon default: delete real media and drafts after judging, unless Johan asks to keep them. Record his choice in
  [status.md](status.md). Uncommitted voice media gets short retention (PRD §9.2).
- Before commercial use: per-store export and deletion, and legal retention for supplier documents (PRD Q-08).

## 6. Auditability

Stock movements are append-only and record actor, source message, model ID, prompt version and operation key
(FR-11). Corrections are compensating movements, never edits.

## 7. AI extraction errors and confidence

- Every model output is schema-constrained, validated and saved as a draft. Nothing is saved to stock without a
  confirmation.
- Unknown fields stay empty and become questions. A confidence score never authorizes a write and is never shown to
  the owner.
- Accuracy claims in the demo come from the measured benchmark ([testing.md](testing.md)), with the real sample size.

## 8. Secrets and credentials

| Secret | Where it lives | Notes |
|---|---|---|
| `MODEL_API_KEY` | `.dev.vars` locally; Cloudflare secret when deployed | Standard models only; spend alert set |
| `WHATSAPP_TOKEN` | same | Long-lived system-user token scoped to this app |
| `WHATSAPP_APP_SECRET` | same | Checks webhook signatures |
| `WHATSAPP_VERIFY_TOKEN` | same | Random |
| `SENDER_HASH_SALT` | same | Random, long. Keys the hashes kept for numbers that aren't members; changing it resets their daily notice limit |
| `LINK_SIGNING_SECRET` | same | Rotate if a link leaks |

- `.dev.vars` is gitignored and blocked for Claude's Read tool. Muse Code and Codex can read files in the workspace,
  so local keys must be low-limit test keys.
- Never paste a secret into an agent chat. Check `git diff --cached` before each commit. Scan the whole history for
  secrets before the repo goes public.
- If a key leaks: revoke and rotate it first, then clean the history before publishing.
- Turn on 2FA for the Meta, Cloudflare and GitHub accounts.

## 9. Access to production resources

- Only Angel deploys. `.claude/settings.json` blocks the usual deploy and force-push commands for Claude. It matches
  command text, so it's a guard, not a boundary.
- Cloudflare API tokens are scoped to this project's resources. The Meta and WhatsApp tokens belong to this app
  only.
- Agents never get production credentials. Production data never goes into agent sessions.

## 10. Coding agents are data processors too

- **Muse Code:** subscriptions start in Contributor mode, where Meta may train on prompts, code and files. Turn it
  off. Muse can also load other tools' personal instructions and skills ("foreign context"), and Angel's
  `~/.claude/CLAUDE.md` holds private details. See [workflow.md](workflow.md#muse-code).
- **Claude Code and Codex:** same rule. No real store data in prompts, and no secrets.
- Saved session transcripts stay outside the repo until reviewed.

## 11. Third parties that receive data

| Processor | What it receives | Terms to check |
|---|---|---|
| Meta Model API | Invoice images, audio, text | Standard mode: content not used for training (pricing page, Oct 26). How long Meta keeps it: not settled; zero data retention is mentioned only for Voice Transcribe. **Verify** before real pilot data |
| WhatsApp Cloud API (Meta) | Messages and media | WhatsApp Business Solution Terms and Business Messaging Policy |
| Cloudflare | Database, media, logs | Account settings, data location |

## 12. Honduran law and Meta platform policies (verify)

- **Honduras:** confirm with a local lawyer or accountant which personal-data rules apply (the Constitution's
  habeas data guarantee and any newer law); how long supplier invoices must be kept for tax purposes and by whom (the
  store, not us); consumer-protection rules if the product is sold.
- **WhatsApp Business Solution Terms:** AI providers are barred when AI is the primary functionality being offered,
  rather than incidental or ancillary. Angel's earlier WhatsApp research checked this clause on a page last modified
  March 6, 2026. Keep the assistant on store operations, with no open-ended chat, and review the "Johan AI" name and
  positioning against the clause before onboarding real stores.
- **WhatsApp messaging rules:** owner-started conversations stay inside the 24-hour service window; anything we start
  needs an approved template (verify before relying on it).
- **Meta Model API terms and acceptable use:** read before real data is processed (verify).
