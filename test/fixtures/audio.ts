/**
 * Synthetic audio only: never real voice notes. TONE_1S_OGG is a 1-second 440 Hz sine, mono 48 kHz
 * OGG/Opus like a WhatsApp voice note, made with:
 *   ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=1" -ac 1 -ar 48000 \
 *     -c:a libopus -b:a 12k -vbr on -application voip -frame_duration 20 -map_metadata -1 \
 *     -fflags +bitexact -flags:a +bitexact tone-1s.ogg
 * sha256 bfb0c20ede89bb4aec6585197144d2389768667cce74d4066e58501d7a84f0ac
 */
export const TONE_1S_OGG_BASE64 =
  "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";

export function toneOgg(): Uint8Array {
  return Uint8Array.from(atob(TONE_1S_OGG_BASE64), (char) => char.charCodeAt(0));
}

/**
 * The same file with the end-of-stream flag cleared on its last page, the way WhatsApp writes voice
 * notes, and that page's CRC recomputed so it is still valid Ogg.
 */
export function withoutEndOfStream(ogg: Uint8Array): Uint8Array {
  const out = ogg.slice();
  let last = 0;
  for (let at = 0; at < out.length; ) {
    last = at;
    at = pageEnd(out, at);
  }
  out[last + 5] = out[last + 5]! & ~0x04;
  new DataView(out.buffer).setUint32(last + 22, oggPageCrc(out.subarray(last, pageEnd(out, last))), true);
  return out;
}

function pageEnd(ogg: Uint8Array, start: number): number {
  const segments = ogg[start + 26]!;
  let body = 0;
  for (let i = 0; i < segments; i++) body += ogg[start + 27 + i]!;
  return start + 27 + segments + body;
}

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let bit = 0; bit < 8; bit++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** An Ogg page's CRC (RFC 3533: polynomial 0x04c11db7, computed with the CRC field as zeros). */
export function oggPageCrc(page: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const byte = i >= 22 && i < 26 ? 0 : page[i]!;
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  }
  return crc;
}

/**
 * Builds an Ogg Opus file around the given audio packets. Page CRCs are left at zero: the reader
 * doesn't check them, and these files never reach libopus (they test what's refused before it).
 */
export function oggOpus(
  packets: readonly Uint8Array[],
  options: { readonly endOfStream?: boolean; readonly samples48kPerPacket?: number } = {},
): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1; // version
  head[9] = 1; // mono
  new DataView(head.buffer).setUint16(10, 312, true); // pre-skip
  new DataView(head.buffer).setUint32(12, 48000, true);
  const tags = new Uint8Array(16);
  tags.set(new TextEncoder().encode("OpusTags"), 0);

  const pages: Uint8Array[] = [page([head], 0x02, 0, 0), page([tags], 0, 0, 1)];
  const perPage = 200;
  for (let i = 0, sequence = 2; i < packets.length; i += perPage, sequence++) {
    const last = i + perPage >= packets.length;
    const flags = last && options.endOfStream !== false ? 0x04 : 0;
    const ending = Math.min(i + perPage, packets.length);
    const granule = options.samples48kPerPacket === undefined ? -1 : ending * options.samples48kPerPacket;
    pages.push(page(packets.slice(i, ending), flags, granule, sequence));
  }
  const out = new Uint8Array(pages.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One Ogg page holding whole packets of under 255 bytes each. granule -1 means "unset" (below 2^31 only). */
function page(packets: readonly Uint8Array[], flags: number, granule: number, sequence: number): Uint8Array {
  const body = packets.reduce((sum, p) => sum + p.length, 0);
  const bytes = new Uint8Array(27 + packets.length + body);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OggS"), 0);
  bytes[5] = flags;
  view.setInt32(6, granule, true);
  view.setInt32(10, granule < 0 ? -1 : 0, true);
  view.setUint32(14, 0x5eed, true); // stream serial
  view.setUint32(18, sequence, true);
  bytes[26] = packets.length;
  let at = 27 + packets.length;
  packets.forEach((packet, i) => {
    bytes[27 + i] = packet.length;
    bytes.set(packet, at);
    at += packet.length;
  });
  return bytes;
}
