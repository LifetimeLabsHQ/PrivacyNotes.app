/**
 * LZX decompression for one cabinet folder, the method OneNote uses for a
 * `.onepkg` (CFFOLDER typeCompress 0x__03, window bits in bits 8 to 12).
 *
 * Format facts are from [MS-PATCH] section 2 (LZXD), which describes the
 * LZX bitstream with a delta extension. A cabinet uses plain LZX, so this
 * reader differs from LZXD in exactly the places LZXD adds something:
 *
 * - No reference data: a match may not reach before the first output byte.
 * - No chunk-size prefix: the chunks (32 KiB frames of output) are the
 *   cabinet's CFDATA blocks, and the compressed bytes of all blocks of the
 *   folder form one stream. After each frame the bitstream is realigned to
 *   a 16-bit boundary ([MS-PATCH] 2.2.1).
 * - No extra length field after a match length of 257 ([MS-PATCH] 2.6.6);
 *   257 is the longest match.
 * - The window size comes from the folder, 2^15 to 2^21.
 *
 * What stays as written there: the bitstream of little-endian 16-bit words
 * read most significant bit first (2.1.1), the E8 call translation header
 * bit and its reversal on each frame (2.2.2), the three block types (2.3),
 * the pretree-coded path lengths kept as deltas across blocks (2.5), the
 * repeated offsets R0 to R2 starting at 1 (2.1.4), and the match decoding
 * of 2.7 with the aligned offset tree used from three footer bits up.
 *
 * Every read is bounds-checked and every write is bounded by the frame sizes
 * the folder declared, so a crafted stream fails with `cab-corrupt`.
 */

import { OneNoteError } from './oneNoteCab';

const FRAME = 32768;
const MAIN_LITERALS = 256;
const LENGTH_TREE_SIZE = 249;
const ALIGNED_TREE_SIZE = 8;
const PRETREE_SIZE = 20;
const MIN_MATCH = 2;

const BLOCK_VERBATIM = 1;
const BLOCK_ALIGNED = 2;
const BLOCK_UNCOMPRESSED = 3;

function corrupt(detail: string): OneNoteError {
  return new OneNoteError('cab-corrupt', `lzx: ${detail}`);
}

/** Position slots by window size ([MS-PATCH] 2.1.6, extended down to 2^15 for cabinets). */
function positionSlots(windowBits: number): number {
  if (windowBits === 21) return 50;
  if (windowBits === 20) return 42;
  return windowBits * 2;
}

/** Footer bits and base position of each slot ([MS-PATCH] 2.6.2). */
function slotTables(slots: number): { bits: Uint8Array; base: Uint32Array } {
  const bits = new Uint8Array(slots);
  const base = new Uint32Array(slots);
  let b = 0;
  for (let i = 0; i < slots; i++) {
    bits[i] = i < 4 ? 0 : Math.min(17, (i >> 1) - 1);
    base[i] = b;
    b += 1 << bits[i]!;
  }
  return { bits, base };
}

interface Tree {
  counts: Uint16Array;
  symbols: Uint16Array;
  empty: boolean;
}

/** A canonical Huffman code from path lengths ([MS-PATCH] 2.4): shorter codes first, lower elements first. */
function buildTree(lengths: Uint8Array, n: number): Tree {
  const counts = new Uint16Array(17);
  for (let i = 0; i < n; i++) counts[lengths[i]!]!++;
  let left = 1;
  for (let len = 1; len <= 16; len++) {
    left = left * 2 - counts[len]!;
    if (left < 0) throw corrupt('over-subscribed tree');
  }
  const offs = new Uint16Array(18);
  for (let len = 1; len <= 16; len++) offs[len + 1] = offs[len]! + counts[len]!;
  const symbols = new Uint16Array(n);
  let used = 0;
  for (let i = 0; i < n; i++) {
    const l = lengths[i]!;
    if (l === 0) continue;
    symbols[offs[l]!] = i;
    offs[l] = offs[l]! + 1;
    used++;
  }
  return { counts, symbols, empty: used === 0 };
}

class Bits {
  pos = 0;
  private buf = 0;
  private cnt = 0;
  constructor(private readonly src: Uint8Array) {}

  private word(): number {
    if (this.pos + 2 > this.src.length) {
      // The last frame may end inside its final word; reading past the input yields zero bits.
      if (this.pos >= this.src.length + 4) throw corrupt('read past end');
      this.pos += 2;
      return 0;
    }
    const w = this.src[this.pos]! | (this.src[this.pos + 1]! << 8);
    this.pos += 2;
    return w;
  }

  private ensure(n: number): void {
    while (this.cnt < n) {
      this.buf = ((this.buf << 16) | this.word()) >>> 0;
      this.cnt += 16;
    }
  }

  read(n: number): number {
    if (n === 0) return 0;
    if (n > 16) return (this.read(n - 16) << 16) | this.read(16);
    this.ensure(n);
    this.cnt -= n;
    const v = (this.buf >>> this.cnt) & ((1 << n) - 1);
    this.buf &= this.cnt === 0 ? 0 : (1 << this.cnt) - 1;
    return v;
  }

  decode(t: Tree): number {
    if (t.empty) throw corrupt('empty tree used');
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 16; len++) {
      code |= this.read(1);
      const count = t.counts[len]!;
      if (code - count < first) return t.symbols[index + (code - first)]!;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw corrupt('bad code');
  }

  /** Drops the rest of the current 16-bit word (frame end, [MS-PATCH] 2.2.1). */
  realign(): void {
    const drop = this.cnt % 16;
    this.cnt -= drop;
    this.buf &= this.cnt === 0 ? 0 : (1 << this.cnt) - 1;
  }

  /**
   * Switches to the byte stream of an uncompressed block: 1 to 16 bits of
   * padding to the next 16-bit boundary, a whole word when already aligned.
   */
  toBytes(): void {
    if (this.cnt === 0) this.word();
    else if (this.cnt > 16) this.pos -= 2;
    this.cnt = 0;
    this.buf = 0;
  }

  byte(): number {
    if (this.pos >= this.src.length) throw corrupt('read past end');
    return this.src[this.pos++]!;
  }

  u32(): number {
    return (this.byte() | (this.byte() << 8) | (this.byte() << 16) | (this.byte() << 24)) >>> 0;
  }
}

/** Reads path lengths `lens[first..last)` as deltas through a pretree ([MS-PATCH] 2.5). */
function readLengths(bits: Bits, lens: Uint8Array, first: number, last: number): void {
  const pre = new Uint8Array(PRETREE_SIZE);
  for (let i = 0; i < PRETREE_SIZE; i++) pre[i] = bits.read(4);
  const tree = buildTree(pre, PRETREE_SIZE);
  let x = first;
  while (x < last) {
    const code = bits.decode(tree);
    if (code === 17 || code === 18) {
      const run = code === 17 ? 4 + bits.read(4) : 20 + bits.read(5);
      if (x + run > last) throw corrupt('length run too long');
      lens.fill(0, x, x + run);
      x += run;
    } else if (code === 19) {
      const run = 4 + bits.read(1);
      const next = bits.decode(tree);
      if (next > 16) throw corrupt('bad length code');
      if (x + run > last) throw corrupt('length run too long');
      const value = (lens[x]! - next + 17) % 17;
      lens.fill(value, x, x + run);
      x += run;
    } else {
      lens[x] = (lens[x]! - code + 17) % 17;
      x++;
    }
  }
}

/**
 * Inflates the compressed bytes of one folder (its CFDATA payloads joined)
 * into `total` bytes, frame by frame. `frames` is each CFDATA's cbUncomp.
 */
export function lzxDecompress(src: Uint8Array, frames: number[], windowBits: number): Uint8Array {
  if (windowBits < 15 || windowBits > 21) throw new OneNoteError('cab-unsupported-compression', `lzx window ${windowBits}`);
  const windowSize = 1 << windowBits;
  const slots = positionSlots(windowBits);
  const { bits: footerBits, base: basePosition } = slotTables(slots);
  const mainSize = MAIN_LITERALS + slots * 8;

  let total = 0;
  for (const f of frames) {
    if (f > FRAME) throw corrupt('frame too large');
    total += f;
  }
  const win = new Uint8Array(total);
  const bits = new Bits(src);

  const mainLens = new Uint8Array(mainSize);
  const lengthLens = new Uint8Array(LENGTH_TREE_SIZE);
  const alignedLens = new Uint8Array(ALIGNED_TREE_SIZE);
  let mainTree: Tree | null = null;
  let lengthTree: Tree | null = null;
  let alignedTree: Tree | null = null;
  let r0 = 1;
  let r1 = 1;
  let r2 = 1;

  // E8 call translation header: one bit, then the 32-bit translation size as two 16-bit fields.
  let e8Size = 0;
  if (bits.read(1)) {
    const hi = bits.read(16);
    const lo = bits.read(16);
    e8Size = ((hi << 16) | lo) >>> 0;
  }

  let blockType = 0;
  let blockLength = 0;
  let blockRemaining = 0;
  let at = 0;
  let frameStart = 0;

  for (const frameLen of frames) {
    const frameEnd = frameStart + frameLen;
    while (at < frameEnd) {
      if (blockRemaining === 0) {
        if (blockType === BLOCK_UNCOMPRESSED && blockLength & 1) bits.byte();
        blockType = bits.read(3);
        blockLength = (bits.read(8) << 16) | (bits.read(8) << 8) | bits.read(8);
        blockRemaining = blockLength;
        if (blockLength === 0) throw corrupt('empty block');
        if (blockType === BLOCK_ALIGNED) {
          for (let i = 0; i < ALIGNED_TREE_SIZE; i++) alignedLens[i] = bits.read(3);
          alignedTree = buildTree(alignedLens, ALIGNED_TREE_SIZE);
        }
        if (blockType === BLOCK_ALIGNED || blockType === BLOCK_VERBATIM) {
          readLengths(bits, mainLens, 0, MAIN_LITERALS);
          readLengths(bits, mainLens, MAIN_LITERALS, mainSize);
          mainTree = buildTree(mainLens, mainSize);
          readLengths(bits, lengthLens, 0, LENGTH_TREE_SIZE);
          lengthTree = buildTree(lengthLens, LENGTH_TREE_SIZE);
        } else if (blockType === BLOCK_UNCOMPRESSED) {
          bits.toBytes();
          r0 = bits.u32();
          r1 = bits.u32();
          r2 = bits.u32();
        } else {
          throw corrupt(`block type ${blockType}`);
        }
      }

      const run = Math.min(blockRemaining, frameEnd - at);
      if (blockType === BLOCK_UNCOMPRESSED) {
        if (bits.pos + run > src.length) throw corrupt('raw block past end');
        win.set(src.subarray(bits.pos, bits.pos + run), at);
        bits.pos += run;
        at += run;
        blockRemaining -= run;
        continue;
      }

      const stop = at + run;
      while (at < stop) {
        const main = bits.decode(mainTree!);
        if (main < MAIN_LITERALS) {
          win[at++] = main;
          continue;
        }
        const lengthHeader = (main - MAIN_LITERALS) & 7;
        const matchLength = (lengthHeader === 7 ? bits.decode(lengthTree!) + 7 : lengthHeader) + MIN_MATCH;
        const slot = (main - MAIN_LITERALS) >> 3;
        let offset: number;
        if (slot === 0) {
          offset = r0;
        } else if (slot === 1) {
          offset = r1;
          r1 = r0;
          r0 = offset;
        } else if (slot === 2) {
          offset = r2;
          r2 = r0;
          r0 = offset;
        } else {
          const extra = footerBits[slot]!;
          let formatted = basePosition[slot]!;
          if (blockType === BLOCK_ALIGNED && extra >= 3) {
            formatted += bits.read(extra - 3) << 3;
            formatted += bits.decode(alignedTree!);
          } else {
            formatted += bits.read(extra);
          }
          offset = formatted - 2;
          r2 = r1;
          r1 = r0;
          r0 = offset;
        }
        if (offset <= 0 || offset > at || offset > windowSize) throw corrupt('match before the start');
        // A match may run past the frame end; it may not run past the folder.
        if (at + matchLength > total) throw corrupt('match past the end');
        for (let k = 0; k < matchLength; k++, at++) win[at] = win[at - offset]!;
      }
      // A match that ran over the run's end counts against the block.
      blockRemaining -= run + (at - stop);
      if (blockRemaining < 0) throw corrupt('match past the block');
    }
    bits.realign();
    frameStart = frameEnd;
  }

  if (!e8Size) return win;
  const out = win.slice();
  let offset = 0;
  for (const frameLen of frames) {
    translateE8(out, offset, frameLen, e8Size);
    offset += frameLen;
  }
  return out;
}

/** Reverses E8 call translation on one frame ([MS-PATCH] 2.2.2). */
function translateE8(out: Uint8Array, frameOffset: number, size: number, e8Size: number): void {
  if (frameOffset >= 0x40000000 || size <= 10) return;
  for (let i = 0; i < size - 10; i++) {
    const p = frameOffset + i;
    if (out[p] !== 0xe8) continue;
    const value = out[p + 1]! | (out[p + 2]! << 8) | (out[p + 3]! << 16) | (out[p + 4]! << 24);
    const current = p;
    if (value >= -current && value < e8Size) {
      const displacement = value >= 0 ? value - current : value + e8Size;
      out[p + 1] = displacement & 0xff;
      out[p + 2] = (displacement >>> 8) & 0xff;
      out[p + 3] = (displacement >>> 16) & 0xff;
      out[p + 4] = (displacement >>> 24) & 0xff;
    }
    i += 4;
  }
}
