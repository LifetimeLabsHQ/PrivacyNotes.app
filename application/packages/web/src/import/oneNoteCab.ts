/**
 * Reads the Microsoft Cabinet file that OneNote writes as a notebook package
 * (File > Export > Notebook > OneNote Package, `.onepkg`).
 *
 * Format facts are from [MS-CAB] (Microsoft Cabinet File Format): a CFHEADER,
 * then one CFFOLDER per compressed stream, one CFFILE per file, and the
 * CFDATA blocks of each folder. A folder is one compressed stream; each file
 * is a slice of its folder's uncompressed bytes. OneNote compresses with
 * MSZIP: every CFDATA block starts with "CK" and holds a complete deflate
 * stream (RFC 1951) of at most 32 KiB of output, and a back reference may
 * reach into the output of the blocks before it. So the folder is inflated
 * into one buffer, block after block, and the earlier blocks are the window.
 * The OneNote export seen in the lab (2026-11-19) compresses with LZX
 * instead, read in `oneNoteLzx.ts`; the window size is in bits 8 to 12 of
 * the folder's typeCompress. Store (no compression) is read too. Quantum is
 * refused with a typed error: no OneNote export seen uses it.
 *
 * The inflater below is written here, not taken from a package: the app has
 * no direct deflate dependency, and the platform's DecompressionStream cannot
 * be given the previous block as a preset window.
 *
 * The file is a stranger's bytes. Every offset is checked against the buffer,
 * the cumulative folder output is checked against `ONEPKG_OUTPUT_LIMIT`
 * before anything is allocated, and every block is refused the moment it
 * writes past what it declared.
 */

import { IMPORT_ENTRY_LIMIT } from './zipEntry';
import { lzxDecompress } from './oneNoteLzx';

/** What went wrong reading a package or a section, as a code the importer turns into a message. */
export type OneNoteErrorCode =
  | 'cab-not-cabinet'
  | 'cab-split'
  | 'cab-unsupported-compression'
  | 'cab-corrupt'
  | 'cab-too-large'
  | 'store-not-revision-store'
  | 'store-fsshttpb'
  | 'store-corrupt';

export class OneNoteError extends Error {
  readonly code: OneNoteErrorCode;
  constructor(code: OneNoteErrorCode, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/**
 * The most bytes one package may inflate to. A notebook with years of
 * pictures is real, so this sits well above the text budget of a zip import;
 * it bounds a crafted file whose few kilobytes declare gigabytes.
 */
const ONEPKG_OUTPUT_LIMIT = 2 * 1024 * 1024 * 1024;

/** MSZIP blocks hold at most this many uncompressed bytes ([MS-MCI] 2.1). */
const MSZIP_BLOCK_LIMIT = 32 * 1024 + 12;

export interface CabFile {
  /** The path inside the cabinet, with `/` separators. Not trusted: the caller normalizes it. */
  name: string;
  data: Uint8Array;
}

const CAB_FLAG_PREV = 0x0001;
const CAB_FLAG_NEXT = 0x0002;
const CAB_FLAG_RESERVE = 0x0004;
const ATTR_NAME_IS_UTF = 0x80;

const COMPRESS_NONE = 0;
const COMPRESS_MSZIP = 1;
const COMPRESS_LZX = 3;

/** True when the bytes start with the cabinet signature "MSCF". */
export function isCabinet(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x53 && bytes[2] === 0x43 && bytes[3] === 0x46;
}

class Cursor {
  constructor(
    private readonly bytes: Uint8Array,
    public pos: number,
  ) {}

  private need(n: number): void {
    if (this.pos < 0 || this.pos + n > this.bytes.length) throw new OneNoteError('cab-corrupt', 'read past end');
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }

  u16(): number {
    this.need(2);
    const v = this.bytes[this.pos]! | (this.bytes[this.pos + 1]! << 8);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const b = this.bytes;
    const v = (b[this.pos]! | (b[this.pos + 1]! << 8) | (b[this.pos + 2]! << 16) | (b[this.pos + 3]! << 24)) >>> 0;
    this.pos += 4;
    return v;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  /** A null-terminated byte string, at most 256 bytes as [MS-CAB] allows. */
  cstring(): Uint8Array {
    const start = this.pos;
    const max = Math.min(this.bytes.length, start + 257);
    for (let i = start; i < max; i++) {
      if (this.bytes[i] === 0) {
        this.pos = i + 1;
        return this.bytes.subarray(start, i);
      }
    }
    throw new OneNoteError('cab-corrupt', 'unterminated name');
  }
}

interface Folder {
  dataStart: number;
  blockCount: number;
  compression: number;
  /** typeCompress bits 8 to 12: the LZX window size as a power of two. */
  windowBits: number;
}

/**
 * Every file in the cabinet, in the order the cabinet lists them. Throws
 * `OneNoteError` on a file that is not a single, readable cabinet.
 */
export function readCab(bytes: Uint8Array, limit = ONEPKG_OUTPUT_LIMIT): CabFile[] {
  if (!isCabinet(bytes)) throw new OneNoteError('cab-not-cabinet');
  const c = new Cursor(bytes, 4);
  c.skip(4); // reserved1
  c.skip(4); // cbCabinet: the buffer length is what counts
  c.skip(4); // reserved2
  const coffFiles = c.u32();
  c.skip(4); // reserved3
  c.skip(2); // versionMinor, versionMajor
  const cFolders = c.u16();
  const cFiles = c.u16();
  const flags = c.u16();
  c.skip(4); // setID, iCabinet
  if (flags & (CAB_FLAG_PREV | CAB_FLAG_NEXT)) throw new OneNoteError('cab-split');
  let cbFolderReserve = 0;
  let cbDataReserve = 0;
  if (flags & CAB_FLAG_RESERVE) {
    const cbHeaderReserve = c.u16();
    cbFolderReserve = c.u8();
    cbDataReserve = c.u8();
    c.skip(cbHeaderReserve);
  }
  if (cFiles > IMPORT_ENTRY_LIMIT) throw new OneNoteError('cab-too-large', 'too many files');

  const folders: Folder[] = [];
  for (let i = 0; i < cFolders; i++) {
    const dataStart = c.u32();
    const blockCount = c.u16();
    const typeCompress = c.u16();
    const compression = typeCompress & 0x000f;
    const windowBits = (typeCompress >>> 8) & 0x1f;
    c.skip(cbFolderReserve);
    folders.push({ dataStart, blockCount, compression, windowBits });
  }

  const fc = new Cursor(bytes, coffFiles);
  const entries: { name: string; size: number; offset: number; folder: number }[] = [];
  const folderUses = new Uint32Array(folders.length);
  const utf8 = new TextDecoder('utf-8');
  const latin1 = new TextDecoder('windows-1252');
  let declared = 0;
  for (let i = 0; i < cFiles; i++) {
    const size = fc.u32();
    const offset = fc.u32();
    const folder = fc.u16();
    fc.skip(4); // date, time
    const attribs = fc.u16();
    const raw = fc.cstring();
    const name = ((attribs & ATTR_NAME_IS_UTF) !== 0 ? utf8 : latin1).decode(raw).replace(/\\/g, '/');
    // 0xFFFD, 0xFFFE and 0xFFFF mark files continued across cabinets.
    if (folder >= 0xfffd) throw new OneNoteError('cab-split');
    if (folder >= folders.length) throw new OneNoteError('cab-corrupt', 'file names a missing folder');
    declared += size;
    if (declared > limit) throw new OneNoteError('cab-too-large');
    folderUses[folder]!++;
    entries.push({ name, size, offset, folder });
  }

  let remaining = limit;
  const inflated = new Map<number, Uint8Array>();
  const files: CabFile[] = [];
  for (const e of entries) {
    let data = inflated.get(e.folder);
    if (!data) {
      data = readFolder(bytes, folders[e.folder]!, cbDataReserve, remaining);
      remaining -= data.byteLength;
      inflated.set(e.folder, data);
    }
    if (e.offset + e.size > data.length) throw new OneNoteError('cab-corrupt', 'file past its folder');
    const slice = e.size * 4 <= data.byteLength ? data.slice(e.offset, e.offset + e.size) : data.subarray(e.offset, e.offset + e.size);
    files.push({ name: e.name, data: slice });
    if (--folderUses[e.folder]! === 0) inflated.delete(e.folder);
  }
  return files;
}

/** The uncompressed bytes of one folder. */
function readFolder(bytes: Uint8Array, folder: Folder, cbDataReserve: number, limit: number): Uint8Array {
  if (folder.compression !== COMPRESS_NONE && folder.compression !== COMPRESS_MSZIP && folder.compression !== COMPRESS_LZX) {
    throw new OneNoteError('cab-unsupported-compression', String(folder.compression));
  }
  // First pass: find the blocks and add up what they declare, so the output
  // is allocated once and refused before any work if it is too large.
  const blocks: { start: number; cb: number; cbUncomp: number }[] = [];
  const c = new Cursor(bytes, folder.dataStart);
  let total = 0;
  for (let i = 0; i < folder.blockCount; i++) {
    c.skip(4); // csum: a damaged block shows up as a failed inflate instead
    const cb = c.u16();
    const cbUncomp = c.u16();
    c.skip(cbDataReserve);
    const start = c.pos;
    c.skip(cb);
    if (folder.compression !== COMPRESS_NONE && cbUncomp > MSZIP_BLOCK_LIMIT) throw new OneNoteError('cab-corrupt', 'block too large');
    total += cbUncomp;
    if (total > limit) throw new OneNoteError('cab-too-large');
    blocks.push({ start, cb, cbUncomp });
  }
  if (folder.compression === COMPRESS_LZX) {
    // One bitstream across the folder: the compressed bytes of every block, joined.
    const joined = new Uint8Array(blocks.reduce((n, b) => n + b.cb, 0));
    let j = 0;
    for (const b of blocks) {
      joined.set(bytes.subarray(b.start, b.start + b.cb), j);
      j += b.cb;
    }
    return lzxDecompress(
      joined,
      blocks.map((b) => b.cbUncomp),
      folder.windowBits,
    );
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    const src = bytes.subarray(b.start, b.start + b.cb);
    if (folder.compression === COMPRESS_NONE) {
      if (b.cb !== b.cbUncomp) throw new OneNoteError('cab-corrupt', 'stored block size');
      out.set(src, at);
    } else {
      if (src.length < 2 || src[0] !== 0x43 || src[1] !== 0x4b) throw new OneNoteError('cab-corrupt', 'missing CK');
      const end = inflateInto(src.subarray(2), out, at, at + b.cbUncomp);
      if (end !== at + b.cbUncomp) throw new OneNoteError('cab-corrupt', 'block size');
    }
    at += b.cbUncomp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inflate (RFC 1951), writing into `out` from `start` and never past `end`.
// Back references may read any byte of `out` before the write position, which
// is how an MSZIP block sees the blocks before it.
// ---------------------------------------------------------------------------

interface Huffman {
  counts: Uint16Array;
  symbols: Uint16Array;
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]!]!++;
  // An over-subscribed code is invalid; an incomplete one is allowed (a single distance code).
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left <<= 1;
    left -= counts[len]!;
    if (left < 0) throw new OneNoteError('cab-corrupt', 'bad huffman code');
  }
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len]! + counts[len]!;
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const l = lengths[i]!;
    if (l === 0) continue;
    symbols[offs[l]!] = i;
    offs[l] = offs[l]! + 1;
  }
  return { counts, symbols };
}

let FIXED: { lit: Huffman; dist: Huffman } | null = null;
function fixedTables(): { lit: Huffman; dist: Huffman } {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  const d = new Uint8Array(30).fill(5);
  FIXED = { lit: buildHuffman(l, 288), dist: buildHuffman(d, 30) };
  return FIXED;
}

class BitReader {
  pos = 0;
  private buf = 0;
  private cnt = 0;
  constructor(private readonly src: Uint8Array) {}

  bits(n: number): number {
    while (this.cnt < n) {
      if (this.pos >= this.src.length) throw new OneNoteError('cab-corrupt', 'deflate past end');
      this.buf |= this.src[this.pos++]! << this.cnt;
      this.cnt += 8;
    }
    const v = this.buf & ((1 << n) - 1);
    this.buf >>>= n;
    this.cnt -= n;
    return v;
  }

  alignByte(): void {
    this.buf = 0;
    this.cnt = 0;
  }

  decode(h: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = h.counts[len]!;
      if (code - count < first) return h.symbols[index + (code - first)]!;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new OneNoteError('cab-corrupt', 'bad huffman symbol');
  }
}

/** Inflates one complete deflate stream into `out[start..end)`; returns the write position. */
export function inflateInto(src: Uint8Array, out: Uint8Array, start: number, end: number): number {
  const br = new BitReader(src);
  let at = start;
  let last = 0;
  while (!last) {
    last = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      br.alignByte();
      if (br.pos + 4 > src.length) throw new OneNoteError('cab-corrupt', 'stored header');
      const len = src[br.pos]! | (src[br.pos + 1]! << 8);
      const nlen = src[br.pos + 2]! | (src[br.pos + 3]! << 8);
      if ((len ^ 0xffff) !== nlen) throw new OneNoteError('cab-corrupt', 'stored length');
      br.pos += 4;
      if (br.pos + len > src.length || at + len > end) throw new OneNoteError('cab-corrupt', 'stored block');
      out.set(src.subarray(br.pos, br.pos + len), at);
      br.pos += len;
      at += len;
      continue;
    }
    let lit: Huffman;
    let dist: Huffman;
    if (type === 1) {
      ({ lit, dist } = fixedTables());
    } else if (type === 2) {
      const nlen = br.bits(5) + 257;
      const ndist = br.bits(5) + 1;
      const ncode = br.bits(4) + 4;
      if (nlen > 286 || ndist > 30) throw new OneNoteError('cab-corrupt', 'bad counts');
      const lengths = new Uint8Array(320);
      for (let i = 0; i < ncode; i++) lengths[CODE_LENGTH_ORDER[i]!] = br.bits(3);
      const lencode = buildHuffman(lengths, 19);
      const all = new Uint8Array(nlen + ndist);
      let i = 0;
      while (i < nlen + ndist) {
        const sym = br.decode(lencode);
        if (sym < 16) {
          all[i++] = sym;
          continue;
        }
        let repeat: number;
        let value = 0;
        if (sym === 16) {
          if (i === 0) throw new OneNoteError('cab-corrupt', 'repeat with no length');
          value = all[i - 1]!;
          repeat = 3 + br.bits(2);
        } else if (sym === 17) {
          repeat = 3 + br.bits(3);
        } else {
          repeat = 11 + br.bits(7);
        }
        if (i + repeat > nlen + ndist) throw new OneNoteError('cab-corrupt', 'too many lengths');
        while (repeat--) all[i++] = value;
      }
      if (all[256] === 0) throw new OneNoteError('cab-corrupt', 'no end code');
      lit = buildHuffman(all.subarray(0, nlen), nlen);
      dist = buildHuffman(all.subarray(nlen), ndist);
    } else {
      throw new OneNoteError('cab-corrupt', 'bad block type');
    }
    for (;;) {
      const sym = br.decode(lit);
      if (sym < 256) {
        if (at >= end) throw new OneNoteError('cab-corrupt', 'block overflows');
        out[at++] = sym;
      } else if (sym === 256) {
        break;
      } else {
        const li = sym - 257;
        if (li >= 29) throw new OneNoteError('cab-corrupt', 'bad length');
        const len = LENGTH_BASE[li]! + br.bits(LENGTH_EXTRA[li]!);
        const di = br.decode(dist);
        if (di >= 30) throw new OneNoteError('cab-corrupt', 'bad distance');
        const d = DIST_BASE[di]! + br.bits(DIST_EXTRA[di]!);
        if (d > at || at + len > end) throw new OneNoteError('cab-corrupt', 'bad back reference');
        for (let k = 0; k < len; k++, at++) out[at] = out[at - d]!;
      }
    }
  }
  return at;
}
