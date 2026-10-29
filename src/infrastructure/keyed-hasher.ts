import type { KeyedHasher } from "../application/ports";

const encoder = new TextEncoder();

/**
 * HMAC-SHA256 keyed with SENDER_HASH_SALT. Deterministic, so the same number hashes the same way
 * for de-duplication and the daily limit, but it can't be reversed by trying every phone number
 * without the key. A blank key fails instead of hashing.
 */
export class HmacKeyedHasher implements KeyedHasher {
  #key: Promise<CryptoKey> | undefined;

  constructor(private readonly salt: string) {}

  async hash(purpose: "sender" | "message" | "status", value: string): Promise<string> {
    if (this.salt === "") throw new Error("SENDER_HASH_SALT is not set");
    this.#key ??= crypto.subtle.importKey("raw", encoder.encode(this.salt), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const mac = await crypto.subtle.sign("HMAC", await this.#key, encoder.encode(`${purpose}:${value}`));
    return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}
