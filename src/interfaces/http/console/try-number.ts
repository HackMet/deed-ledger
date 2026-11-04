/**
 * "Probar como cliente": the store's WhatsApp number, as customers see it, with a button that opens
 * a chat with it and a first message typed in. The number comes from Meta's signed webhooks
 * (`channel_accounts.display_phone_number`), so nobody types it and it can't be wrong; until the
 * first message arrives there is none, and the card isn't shown.
 */
import { html } from "hono/html";

/** The first message the button types in; the person can change it before sending. */
export const TRY_TEXT = "Hola, quiero hacer un pedido";

/** "+1 555 031 7081", "+504 9999 9999"; any other country as "+" and its digits. */
export function shownNumber(digits: string): string {
  const us = /^1(\d{3})(\d{3})(\d{4})$/u.exec(digits);
  if (us !== null) return `+1 ${us[1]} ${us[2]} ${us[3]}`;
  const hn = /^504(\d{4})(\d{4})$/u.exec(digits);
  if (hn !== null) return `+504 ${hn[1]} ${hn[2]}`;
  return `+${digits}`;
}

/** WhatsApp's own click-to-chat link: https://wa.me/<digits>?text=<message>. */
export function tryLink(digits: string): string {
  return `https://wa.me/${digits}?text=${encodeURIComponent(TRY_TEXT)}`;
}

/** The card, one per number; nothing when the store has no number yet. */
export function tryCard(numbers: readonly string[]) {
  if (numbers.length === 0) return "";
  return html`<section class="try">
<span class="label">Tu WhatsApp para clientes</span>
${numbers.map(
  (digits) => html`<span class="number">${shownNumber(digits)}</span>
<a class="try-go" href="${tryLink(digits)}" target="_blank" rel="noopener">Probar como cliente</a>`,
)}
<span class="hint">Escribile como si fueras cliente y mirá lo que ellos ven.</span>
</section>`;
}

export const TRY_STYLE = `
.try{display:block;margin:12px 14px;padding:16px;border:1px solid #cfddce;border-radius:18px;background:var(--soft)}
.try .label{display:block;font-weight:700}
.try .number{display:block;margin-top:4px;font-size:28px;font-weight:800;letter-spacing:-.3px;line-height:1.2}
.try-go{display:flex;align-items:center;justify-content:center;margin:12px 0 8px;min-height:56px;border-radius:14px;background:var(--ink);color:#fff;text-align:center;font-size:17px;font-weight:800;text-decoration:none}
.try .hint{display:block;font-size:14px;color:var(--mute)}
`;
