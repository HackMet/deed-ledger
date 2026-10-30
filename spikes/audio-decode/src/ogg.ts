// Minimal reader for a single-stream Ogg Opus file: Ogg pages (RFC 3533) carrying Opus packets
// (RFC 7845). A voice note is one mono or stereo stream; anything else is rejected, not guessed at.

export class OggOpusError extends Error {
  override name = "OggOpusError";
}

export interface OpusHead {
  channels: number;
  /** Samples at 48 kHz that the decoder must drop from the start. */
  preSkip: number;
  /** The encoder's input rate. Informational only; Opus always decodes at a rate we choose. */
  inputSampleRate: number;
  /** Gain in dB, Q7.8 fixed point, to apply after decoding. */
  outputGainQ8: number;
}

export interface OggOpusStream {
  head: OpusHead;
  /** Audio packets, in order, without the two header packets. */
  packets: Uint8Array[];
  /** Granule position (48 kHz samples, pre-skip included) of the last page that ends a packet. */
  finalGranule: number | null;
}

const OGG_CAPTURE = 0x5367674f; // "OggS" read as a little-endian uint32
const FLAG_CONTINUED = 0x01;
const FLAG_BEGIN = 0x02;
const FLAG_END = 0x04;

export function readOggOpus(bytes: Uint8Array): OggOpusStream {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packets: Uint8Array[] = [];
  let pending: Uint8Array[] = [];
  let serial: number | null = null;
  let finalGranule: number | null = null;
  let offset = 0;

  while (offset + 27 <= bytes.length) {
    if (view.getUint32(offset, true) !== OGG_CAPTURE) {
      throw new OggOpusError(`expected an Ogg page at byte ${offset}`);
    }
    if (bytes[offset + 4] !== 0) throw new OggOpusError("unsupported Ogg version");

    const flags = bytes[offset + 5]!;
    const granuleLow = view.getUint32(offset + 6, true);
    const granuleHigh = view.getInt32(offset + 10, true);
    const pageSerial = view.getUint32(offset + 14, true);
    const segmentCount = bytes[offset + 26]!;
    const tableStart = offset + 27;
    const bodyStart = tableStart + segmentCount;
    if (bodyStart > bytes.length) break; // truncated upload: keep the complete pages

    let bodyLength = 0;
    for (let i = 0; i < segmentCount; i++) bodyLength += bytes[tableStart + i]!;
    const pageEnd = bodyStart + bodyLength;
    if (pageEnd > bytes.length) break;

    if (serial === null) {
      if (!(flags & FLAG_BEGIN)) throw new OggOpusError("the first page does not start a stream");
      serial = pageSerial;
    }
    if (pageSerial !== serial) throw new OggOpusError("more than one logical stream");

    // A page that does not continue a packet means the pending fragment was cut off.
    if (!(flags & FLAG_CONTINUED)) pending = [];

    let pieceStart = bodyStart;
    let position = bodyStart;
    let endedPacket = false;
    for (let i = 0; i < segmentCount; i++) {
      const lacing = bytes[tableStart + i]!;
      position += lacing;
      if (lacing < 255) {
        const piece = bytes.subarray(pieceStart, position);
        packets.push(pending.length ? concat([...pending, piece]) : piece);
        pending = [];
        pieceStart = position;
        endedPacket = true;
      }
    }
    if (pieceStart < pageEnd) pending.push(bytes.subarray(pieceStart, pageEnd));

    const granuleUnset = granuleLow === 0xffffffff && granuleHigh === -1;
    if (endedPacket && !granuleUnset) finalGranule = granuleHigh * 2 ** 32 + granuleLow;

    offset = pageEnd;
    if (flags & FLAG_END) break;
  }

  if (packets.length < 2) throw new OggOpusError("missing Opus header packets");
  const head = parseOpusHead(packets[0]!);
  if (ascii(packets[1]!, 0, 8) !== "OpusTags") throw new OggOpusError("missing OpusTags packet");

  return { head, packets: packets.slice(2), finalGranule };
}

function parseOpusHead(packet: Uint8Array): OpusHead {
  if (packet.length < 19 || ascii(packet, 0, 8) !== "OpusHead") {
    throw new OggOpusError("not an Ogg Opus stream");
  }
  if ((packet[8]! & 0xf0) !== 0) throw new OggOpusError("unsupported OpusHead version");

  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const channels = packet[9]!;
  const mappingFamily = packet[18]!;
  if (mappingFamily !== 0 || channels < 1 || channels > 2) {
    throw new OggOpusError("only mono or stereo Opus is supported");
  }
  return {
    channels,
    preSkip: view.getUint16(10, true),
    inputSampleRate: view.getUint32(12, true),
    outputGainQ8: view.getInt16(16, true),
  };
}

/** Samples at 48 kHz that one Opus packet decodes to, from its TOC byte (RFC 6716 section 3.1). */
export function opusPacketSamples48k(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  const config = toc >> 3;
  let frameSize: number;
  if (config < 12) frameSize = [480, 960, 1920, 2880][config & 3]!; // SILK: 10, 20, 40, 60 ms
  else if (config < 16) frameSize = config & 1 ? 960 : 480; // hybrid: 10, 20 ms
  else frameSize = [120, 240, 480, 960][config & 3]!; // CELT: 2.5, 5, 10, 20 ms

  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return frames * frameSize;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
