/**
 * The short code staff and customers say out loud for an order: "#" and the first five Crockford
 * base32 characters of the SHA-256 of its confirm fact's id. Display only: two orders can share a
 * code, so no lookup ever uses it. Null until the order has a confirm.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 5;

export async function orderCode(confirmFactId: string | null): Promise<string | null> {
  if (confirmFactId === null) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(confirmFactId)));
  let code = "";
  for (let n = 0; n < CODE_LENGTH; n++) {
    const bit = n * 5;
    const window = ((digest[bit >> 3]! << 8) | (digest[(bit >> 3) + 1] ?? 0)) >> (11 - (bit & 7));
    code += CROCKFORD[window & 31];
  }
  return `#${code}`;
}
