#!/usr/bin/env node
// Sends a Meta-shaped, signed webhook to the local Worker (`npm run dev:sim`), then prints the
// outbox: the replies the Worker would send. Synthetic data only.
//
//   npm run simulate -- --text "Vinieron 2 cajas de leche"
//   npm run simulate -- --image            (a photo; media download is a stub for now)
//   npm run simulate -- --audio            (a voice note)
//   npm run simulate -- --text "Hola" --from 50400000099     (another customer)
//   npm run simulate -- --sweep            (also run the cron sweep once)
// Options: --to <phone_number_id>, --url <base URL>, --wait <seconds> (default 6)
import { createHmac, randomUUID } from "node:crypto";
import { parseArgs, queryLocal, SIM } from "./lib/sim.mjs";

const args = parseArgs(process.argv.slice(2));
const url = typeof args.url === "string" ? args.url : `http://127.0.0.1:${SIM.port}`;
const from = typeof args.from === "string" ? args.from : SIM.ownerPhone;
const to = typeof args.to === "string" ? args.to : SIM.phoneNumberId;
const waitSeconds = typeof args.wait === "string" ? Number(args.wait) : 6;

const base = { from, id: `wamid.SIM-${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)) };
let message;
if (args.image === true) {
  message = { ...base, type: "image", image: { id: `sim-media-${randomUUID()}`, mime_type: "image/jpeg", sha256: "c2lt", caption: typeof args.text === "string" ? args.text : undefined } };
} else if (args.audio === true) {
  message = { ...base, type: "audio", audio: { id: `sim-media-${randomUUID()}`, mime_type: "audio/ogg; codecs=opus", sha256: "c2lt", voice: true } };
} else {
  message = { ...base, type: "text", text: { body: typeof args.text === "string" ? args.text : "Hola" } };
}

const body = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "900000000000001",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550000000", phone_number_id: to },
            contacts: [{ profile: { name: "Simulador" }, wa_id: from }],
            messages: [message],
          },
        },
      ],
    },
  ],
});
const signature = `sha256=${createHmac("sha256", SIM.appSecret).update(body).digest("hex")}`;

const response = await fetch(`${url}/webhooks/whatsapp`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-signature-256": signature },
  body,
});
console.log(`POST /webhooks/whatsapp → ${response.status} ${await response.text()}`);

if (args.sweep === true) {
  const sweep = await fetch(`${url}/cdn-cgi/local/scheduled?cron=*+*+*+*+*`);
  console.log(`cron sweep → ${sweep.status}`);
}

console.log(`Waiting ${waitSeconds}s for the settle window and the queue…`);
await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

const outbox = queryLocal(
  `SELECT o.created_at_ms, o.kind, o.status, o.body_text,
          CASE WHEN o.conversation_id IS NULL THEN 'old notice' ELSE 'customer' END AS recipient
   FROM outbound_messages o ORDER BY o.created_at_ms DESC LIMIT 10`,
);
console.log("Outbox (newest first; nothing is sent to WhatsApp in the simulator):");
console.table(
  outbox.map((row) => ({
    at: new Date(row.created_at_ms).toISOString(),
    recipient: row.recipient,
    kind: row.kind,
    status: row.status,
    text: row.body_text,
  })),
);
