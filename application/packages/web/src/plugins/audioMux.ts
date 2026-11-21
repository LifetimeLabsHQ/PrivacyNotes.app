/**
 * Remove noise: the encoded audio packets of WebCodecs `AudioEncoder` wrapped
 * into a file that every platform plays. AAC goes into an `.m4a` (MP4), the
 * format the recorder prefers; Opus goes into an `.ogg`, the format Firefox
 * records (Firefox has no AAC encoder). Plain JavaScript, no WebAssembly.
 * Mono only: the model gives one channel.
 * Spec: docs/internal/specs/plugins-speech-enhancement.md (section 8)
 */

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16 = (v: number) => [(v >>> 8) & 255, v & 255];

type Bytes = number[] | Uint8Array;

function concat(parts: readonly Bytes[]): Uint8Array {
  const size = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function box(type: string, ...body: Bytes[]): Uint8Array {
  const inner = concat(body);
  return concat([u32(inner.length + 8), ascii(type), inner]);
}

const full = (type: string, version: number, flags: number, ...body: Bytes[]) => box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...body);

/** An MPEG-4 descriptor with a one-byte length (every one here is under 128 bytes). */
const descriptor = (tag: number, ...body: Bytes[]) => {
  const inner = concat(body);
  return concat([[tag, inner.length], inner]);
};

/** AAC LC, 48 kHz, mono: the AudioSpecificConfig to use when the encoder gives none. */
export const AAC_LC_48K_MONO = new Uint8Array([0x11, 0x88]);

/**
 * The AudioSpecificConfig in an AAC encoder's `description`. Chrome gives
 * the config itself; WebKit gives a whole ES descriptor (tag 3) with the
 * config inside, in its DecoderSpecificInfo (tag 5).
 */
export function aacConfig(description: Uint8Array | null): Uint8Array {
  if (!description || description.length === 0) return AAC_LC_48K_MONO;
  if (description[0] !== 0x03) return description;
  // Each descriptor: a tag, a length in 7-bit groups, then its body.
  const walk = (from: number, to: number): Uint8Array | null => {
    let at = from;
    while (at < to) {
      const tag = description[at++]!;
      let len = 0;
      for (let i = 0; i < 4 && at < to; i++) {
        const b = description[at++]!;
        len = (len << 7) | (b & 0x7f);
        if (b < 0x80) break;
      }
      const end = Math.min(at + len, to);
      if (tag === 0x05) return description.slice(at, end);
      // ES_Descriptor: ES_ID (2) and flags (1); DecoderConfigDescriptor: 13 bytes before its children.
      if (tag === 0x03) return walk(at + 3, end);
      if (tag === 0x04) return walk(at + 13, end);
      at = end;
    }
    return null;
  };
  return walk(0, description.length) ?? AAC_LC_48K_MONO;
}

/**
 * An `.m4a` with one AAC track: `ftyp`, then `moov` with the sample table,
 * then `mdat` with every packet in one chunk. Each AAC packet is 1024
 * samples. `config` is the AudioSpecificConfig. The edit list skips the
 * encoder's `priming` samples and ends after `samples`, so the file plays
 * exactly the audio that went in, not 44 ms later.
 */
export function muxM4a(packets: readonly Uint8Array[], config: Uint8Array, sampleRate: number, bitrate: number, samples = packets.length * 1024, priming = 0): Uint8Array {
  const count = packets.length;
  const duration = count * 1024;
  const shown = Math.min(samples, duration - priming);
  const ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('M4A '), ascii('isom'), ascii('mp42'));
  const moovFor = (dataOffset: number) => {
    const esds = full(
      'esds', 0, 0,
      descriptor(3, u16(1), [0],
        descriptor(4, [0x40, 0x15, 0, 0, 0], u32(bitrate), u32(bitrate), descriptor(5, config)),
        descriptor(6, [0x02]),
      ),
    );
    const mp4a = box('mp4a', [0, 0, 0, 0, 0, 0], u16(1), [0, 0, 0, 0, 0, 0, 0, 0], u16(1), u16(16), u16(0), u16(0), u32(sampleRate * 65536), esds);
    const sizes = new Uint8Array(count * 4);
    packets.forEach((p, i) => sizes.set(u32(p.length), i * 4));
    const stbl = box(
      'stbl',
      full('stsd', 0, 0, u32(1), mp4a),
      full('stts', 0, 0, u32(1), u32(count), u32(1024)),
      full('stsc', 0, 0, u32(1), u32(1), u32(count), u32(1)),
      full('stsz', 0, 0, u32(0), u32(count), sizes),
      full('stco', 0, 0, u32(1), u32(dataOffset)),
    );
    const minf = box('minf', full('smhd', 0, 0, u16(0), u16(0)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
    const mdia = box(
      'mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(duration), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), ascii('soun'), u32(0), u32(0), u32(0), ascii('SoundHandler'), [0]),
      minf,
    );
    const matrix = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
    const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(shown), u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0), matrix, u32(0), u32(0));
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(shown), u32(0x10000), u16(0x0100), u16(0), u32(0), u32(0), matrix, new Uint8Array(24), u32(2));
    const edts = box('edts', full('elst', 0, 0, u32(1), u32(shown), u32(priming), u16(1), u16(0)));
    return box('moov', mvhd, box('trak', tkhd, edts, mdia));
  };
  // The offset of the first packet depends on the size of moov, which does not depend on the offset.
  const probe = moovFor(0);
  const moov = moovFor(ftyp.length + probe.length + 8);
  const data = concat(packets);
  return concat([ftyp, moov, u32(data.length + 8), ascii('mdat'), data]);
}

/** Ogg's CRC-32: polynomial 0x04c11db7, no bit reflection, start 0. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]!) & 255]!) >>> 0;
  return crc;
}

const le32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const le16 = (v: number) => [v & 255, (v >>> 8) & 255];

/** One Ogg page with whole packets; `granule` is the sample count at its end. */
function oggPage(packets: readonly Uint8Array[], granule: number, seq: number, flags: number, serial: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const page = concat([
    ascii('OggS'), [0, flags],
    // The granule position, 64-bit little-endian.
    le32(granule % 0x100000000), le32(Math.floor(granule / 0x100000000)),
    le32(serial), le32(seq), le32(0), [lacing.length], lacing, ...packets,
  ]);
  page.set(le32(oggCrc(page)), 22);
  return page;
}

/** What libopus adds before the first sample at 48 kHz (RFC 7845, section 4.2). */
const OPUS_PRE_SKIP = 312;

/**
 * An `.ogg` with one Opus stream (RFC 7845): the OpusHead page, the OpusTags
 * page, then the packets, at most 255 lacing values a page. `samples` is the
 * length of the audio at 48 kHz; the last page's granule cuts the padding.
 * `frame` is the samples per packet (960 for 20 ms).
 */
export function muxOgg(packets: readonly Uint8Array[], samples: number, frame: number, preSkip = OPUS_PRE_SKIP): Uint8Array {
  const serial = 0x504e4f50;
  const head = new Uint8Array([...ascii('OpusHead'), 1, 1, ...le16(preSkip), ...le32(48000), 0, 0, 0]);
  const vendor = ascii('PrivacyNotes');
  const tags = new Uint8Array([...ascii('OpusTags'), ...le32(vendor.length), ...vendor, ...le32(0)]);
  const pages: Uint8Array[] = [oggPage([head], 0, 0, 0x02, serial), oggPage([tags], 0, 1, 0, serial)];
  const end = preSkip + samples;
  let seq = 2;
  let granule = preSkip;
  let batch: Uint8Array[] = [];
  let laces = 0;
  packets.forEach((p, i) => {
    const need = Math.floor(p.length / 255) + 1;
    if (batch.length && laces + need > 255) {
      pages.push(oggPage(batch, Math.min(granule, end), seq++, 0, serial));
      batch = [];
      laces = 0;
    }
    batch.push(p);
    laces += need;
    granule += frame;
    if (i === packets.length - 1) pages.push(oggPage(batch, end, seq++, 0x04, serial));
  });
  return concat(pages);
}
