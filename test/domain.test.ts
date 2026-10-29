import { describe, expect, it } from "vitest";
import { couldNotDownload, couldNotProcess } from "../src/domain/copy";
import { isUnderStorePrefix, mediaObjectKey } from "../src/domain/media";
import {
  CLAIM_CONFIRM_MAX_MS,
  isExpired,
  isProviderStatus,
  isWindowOpen,
  providerStatusRank,
  SEND_CLAIM_MS,
  SEND_TIMEOUT_MS,
} from "../src/domain/outbox";
import { normalizePhone } from "../src/domain/phone";
import { orderingTimestampS, retryAfterMs, settleDelaySeconds } from "../src/domain/processing";
import { splitText } from "../src/domain/text";

describe("domain rules", () => {
  it("normalizes WhatsApp phone numbers to digits, or rejects them", () => {
    expect(normalizePhone("+50400000001")).toBe("50400000001");
    expect(normalizePhone("50400000001")).toBe("50400000001");
    for (const bad of ["", "+", "12345", "1234567890123456", "504 0000 0001", "50400000001x", "++50400000001"]) {
      expect(normalizePhone(bad)).toBeNull();
    }
  });

  it("waits for the newest message of a burst to be three seconds old", () => {
    const now = 1_000_000;
    expect(settleDelaySeconds(now, now)).toBe(3);
    expect(settleDelaySeconds(now, now - 2_500)).toBe(1);
    expect(settleDelaySeconds(now, now - 3_000)).toBe(0);
    expect(settleDelaySeconds(now, now - 60_000)).toBe(0);
    expect(retryAfterMs(now, 2)).toBe(now + 10_000);
  });

  it("clamps the provider timestamp to [received - 7 days, received + 5 minutes] for ordering", () => {
    const received = Date.UTC(2026, 9, 28, 12);
    const receivedS = received / 1000;
    expect(orderingTimestampS(receivedS - 2, received)).toBe(receivedS - 2);
    expect(orderingTimestampS(receivedS + 365 * 86_400, received)).toBe(receivedS + 300);
    expect(orderingTimestampS(0, received)).toBe(receivedS - 7 * 86_400);
  });

  it("opens the 24-hour window from our own receive time, and handles expiry", () => {
    const now = Date.UTC(2026, 9, 28, 12);
    const day = 24 * 60 * 60 * 1000;
    expect(isWindowOpen(now, null)).toBe(false);
    expect(isWindowOpen(now, now - 60_000)).toBe(true);
    expect(isWindowOpen(now, now - day + 1)).toBe(true);
    expect(isWindowOpen(now, now - day)).toBe(false);
    expect(isExpired(now, now)).toBe(true);
    expect(isExpired(now, now + 1)).toBe(false);
  });

  it("orders delivery statuses so they only move forward", () => {
    expect(providerStatusRank("sent")).toBeLessThan(providerStatusRank("delivered"));
    expect(providerStatusRank("delivered")).toBeLessThan(providerStatusRank("read"));
    expect(providerStatusRank("read")).toBeLessThan(providerStatusRank("played"));
    expect(providerStatusRank("played")).toBeLessThan(providerStatusRank("failed"));
    expect(isProviderStatus("read")).toBe(true);
    expect(isProviderStatus("constructor")).toBe(false);
    expect(isProviderStatus("toString")).toBe(false);
  });

  it("keeps media keys inside the store prefix, without prefix confusion", () => {
    expect(mediaObjectKey("b1", "x")).toBe("stores/b1/media/x");
    expect(isUnderStorePrefix("b1", "stores/b1/media/x")).toBe(true);
    expect(isUnderStorePrefix("b", "stores/b1/media/x")).toBe(false);
    expect(isUnderStorePrefix("b1", "stores/b10/media/x")).toBe(false);
  });

  it("splits long replies at whitespace within the limit, never inside a character, and drops blank ones", () => {
    expect(splitText("  hola  ", 10)).toEqual(["hola"]);
    expect(splitText("   ", 10)).toEqual([]);
    expect(splitText("uno dos tres cuatro", 8)).toEqual(["uno dos", "tres", "cuatro"]);
    const word = "a".repeat(9);
    expect(splitText(word, 4)).toEqual(["aaaa", "aaaa", "a"]);
    const emoji = "aaa😀😀";
    for (const part of splitText(emoji, 4)) {
      expect(part.length).toBeLessThanOrEqual(4);
      expect(part).not.toMatch(/[\uD800-\uDBFF]$/);
    }
    expect(splitText(emoji, 4).join("")).toBe(emoji);
    const long = `${"palabra ".repeat(1_000)}fin`;
    const parts = splitText(long, 4096);
    expect(parts.every((part) => part.length <= 4096)).toBe(true);
    expect(parts.join(" ")).toBe(long.trim());
  });

  it("cuts text without whitespace between graphemes: flags and accented letters stay whole (G11)", () => {
    // A flag is two regional indicators, four UTF-16 units; a cut at 4,095 would land inside one.
    const flags = "🇭🇳".repeat(1_100);
    const flagParts = splitText(flags, 4095);
    expect(flagParts.join("")).toBe(flags);
    expect(flagParts.every((part) => part.length <= 4095 && /^(?:🇭🇳)+$/u.test(part))).toBe(true);
    expect(splitText("🇭🇳🇭🇳🇭🇳", 10)).toEqual(["🇭🇳🇭🇳", "🇭🇳"]);

    // "café" with a combining accent: "e" + U+0301 is one letter, two units.
    const cafe = "café";
    expect(splitText(`${cafe}${cafe}`, 4)).toEqual(["caf", "éca", "fé"]);
    const cafeParts = splitText(cafe.repeat(1_000), 4094);
    expect(cafeParts.join("")).toBe(cafe.repeat(1_000));
    expect(cafeParts.every((part) => part.length <= 4094 && !part.startsWith("́"))).toBe(true);
  });

  it("cuts a single grapheme longer than the limit by code units, as the last resort, never inside a surrogate pair (H6)", () => {
    // "e" with nine combining accents is one grapheme of ten units: no part of four can hold it whole.
    const stacked = `e${"́".repeat(9)}`;
    expect(splitText(stacked, 4)).toEqual([`e${"́".repeat(3)}`, "́".repeat(4), "́".repeat(2)]);

    // A family emoji is one grapheme of eleven units: four people (surrogate pairs) joined by U+200D.
    const family = "👨‍👩‍👧‍👦";
    const parts = splitText(family, 4);
    expect(parts).toEqual(["👨‍", "👩‍", "👧‍", "👦"]);
    expect(parts.join("")).toBe(family);
    for (const part of parts) {
      expect(part).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(part).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
  });

  it("leaves time to store a send's result after a confirmation at the limit and a send at its timeout", () => {
    expect(SEND_CLAIM_MS - CLAIM_CONFIRM_MAX_MS - SEND_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("words failure messages after what was sent, without blaming anyone", () => {
    expect(couldNotDownload("image")).toBe("No pude descargar la foto. ¿Me la mandás otra vez?");
    expect(couldNotDownload("audio")).toBe("No pude descargar la nota de voz. ¿Me la mandás otra vez?");
    expect(couldNotProcess("image")).toBe("Perdón, no pude leer tu foto. ¿Me la mandás otra vez?");
    expect(couldNotProcess("audio")).toBe("Perdón, no pude escuchar tu nota de voz. ¿Me la mandás otra vez?");
    expect(couldNotProcess("text")).toBe("Perdón, no pude revisar tu mensaje. ¿Me lo mandás otra vez?");
  });
});
