# Deploy checklist

Angel runs every remote command (repo rule). Run from the repo root on the branch being deployed. Secrets are typed
or piped into `wrangler secret put`; never paste them into a file, a chat or a log.

## First deploy (#24)

1. **Log in:** `npx wrangler login`, then `npx wrangler whoami` shows the right account.
2. **Create the resources** (once):
   - `npx wrangler d1 create store-assistant`: copy the printed `database_id` into `wrangler.jsonc` under
     `d1_databases` (the ID isn't a secret).
   - `npx wrangler r2 bucket create store-assistant-media`
   - `npx wrangler queues create store-assistant-jobs`
3. **Set the secrets** (each prompts for its value):
   - From the Meta app dashboard: `npx wrangler secret put WHATSAPP_APP_SECRET`,
     `npx wrangler secret put WHATSAPP_TOKEN`.
   - `npx wrangler secret put WHATSAPP_VERIFY_TOKEN`: make up a long value and type it; you paste the same value
     into Meta in step 7.
   - `npx wrangler secret put MODEL_API_KEY`: the Meta model key (the name is `MODEL_API_KEY`, never
     `META_API_KEY`).
   - Random values nobody needs to see; piping keeps them off the screen:
     - `openssl rand -hex 32 | npx wrangler secret put SENDER_HASH_SALT`
     - `openssl rand -hex 32 | npx wrangler secret put LINK_SIGNING_SECRET`
4. **Apply the migrations:** `npx wrangler d1 migrations apply DB --remote`
5. **Deploy** with the pretend engine on (until the real engine is ready) and login still required:
   `npx wrangler deploy --var PRETEND_ENGINE:1`. Note the `https://store-assistant.<account>.workers.dev` URL it
   prints. Never pass `DEV_CONSOLE` to a deployed Worker: it turns login off.
6. **Deploy again with the public URL**, so the first message links the privacy page:
   `npx wrangler deploy --var PRETEND_ENGINE:1 --var PUBLIC_BASE_URL:https://store-assistant.<account>.workers.dev`
   (no trailing slash). Every later deploy passes both `--var`s.
7. **Point WhatsApp at it** (Meta app dashboard → WhatsApp → Configuration):
   - Callback URL: `https://store-assistant.<account>.workers.dev/webhooks/whatsapp`
   - Verify token: the value you typed for `WHATSAPP_VERIFY_TOKEN`.
   - Subscribe to the `messages` field.
   - Add the test phones as recipients (the test number only messages registered recipients).
8. **Create the store** (synthetic names until Johan's setup session):
   `npm run admin:create-store -- --name "<store>" --phone-number-id <WhatsApp phone number ID> --owner-phone <owner> --remote`
9. **First console login:**
   `npm run admin:invite -- --phone-number-id <id> --phone <owner> --role owner --base-url https://store-assistant.<account>.workers.dev --remote`
   prints a link good for 15 minutes. Open it on the phone and tap "Entrar".
10. **Spend alert** on the Meta credits (Meta dashboard), if not set yet. The app also caps model spend at US$2 per
    store per day.

## Smoke test

- `curl https://store-assistant.<account>.workers.dev/health` prints `ok`.
- Meta's "Verify and save" in step 7 succeeds (that's the webhook GET).
- From a registered phone: "Hola" gets the introduction; an order gets a readback with Confirmar / Corregir /
  Cancelar; Confirmar puts it on the console's list; "Pedido listo" in the console sends "Tu pedido ya está listo".
- A voice note and a photo are read. The first real download is also the first live run of the media size and hash
  check (#27): if media fails with `media_not_downloaded` and then "No pude descargar…", suspect that check first.
- `npx wrangler tail` while sending a message shows IDs only: no phone numbers, message text or secrets.

## Testing on the live number

- Deploy with `--var TEST_COMMANDS:1` to turn on the WhatsApp test commands; never on a store with real customers
  unless the owner wants it. They answer only a phone that is an active member (owner or staff) of the store that
  owns the number; for anyone else, or with the variable off, the text is an ordinary customer message.
- `/new` (or `/nuevo`, `/reset`): you become a new customer of the store. Your open order is cancelled, your name,
  saved places, messages and readback are erased as a data deletion erases them, and your next message gets the
  first-message welcome. `/help` (or `/ayuda`) lists the commands.

## Every later deploy

1. **Back up first**, outside the repo (the file holds real data once customers write):
   `mkdir -p ~/store-assistant-backups && npx wrangler d1 export DB --remote --output ~/store-assistant-backups/backup-$(date +%Y%m%d-%H%M).sql`
2. `npx wrangler d1 migrations apply DB --remote` (applies only new migrations).
3. `npx wrangler secret put <NAME>` for any secret a branch added to `secrets.required` in `wrangler.jsonc`.
4. Deploy with the same `--var`s, then the smoke test.

## Switching to the real engine (#13)

When the teammate's engine answers `verifyClaims`, `preparationList` and `onConsoleAction`: settle the migration
numbers first (nothing of hers may be renamed after it ran remotely), merge, apply the migrations, and deploy
without `PRETEND_ENGINE`. Orders taken by the pretend engine stay in its own table and aren't carried over.

## If something goes wrong

- `npx wrangler deployments list` and `npx wrangler rollback` return to the previous version. A rollback doesn't
  undo migrations; migrations only add, so the older code keeps working.
- A failing webhook verification is almost always the verify token or the callback URL.
