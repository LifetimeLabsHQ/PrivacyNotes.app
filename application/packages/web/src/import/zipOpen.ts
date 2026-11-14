/**
 * The one way an importer opens a zip (#758).
 *
 * jszip reads every 4-byte number of a zip as a SIGNED 32-bit integer, so an
 * offset at or past 2 GiB comes out negative and the load fails with "End of
 * data reached (data length = ..., asked index = -...). Corrupted zip ?". A
 * Bear backup with many pictures is larger than that. A file below 2 GiB goes
 * to jszip as before. A larger one is read here: this module finds the
 * central directory itself, cuts the entries into parts that each span less
 * than `PART_BYTES`, gives each part to jszip as a small zip of its own (the
 * entries' bytes as they are, plus a central directory whose offsets count
 * from the part's start), and puts every part's entries into one jszip
 * object. The entries are jszip's own objects, so `zipEntryText`,
 * `zipEntryBytes` and `zipEntryMedia` read them unchanged.
 *
 * Every failure to open becomes an `ImportFileError`, which carries a plain
 * sentence and keeps jszip's text as its detail.
 *
 * Limits of the split read: entries go in offset order, which is the central
 * directory order of every zip written front to back; a zip with bytes before
 * its first entry (a self-extracting archive) is refused; and one entry of
 * 2 GiB or more still fails inside jszip.
 */

import JSZip from 'jszip';
import { ImportFileError, ImportTooLargeError } from './zipEntry';

/** jszip reads an offset as a signed 32-bit number, so this is the first offset it gets wrong. */
const SIGNED_LIMIT = 2 ** 31;
/** The span of one part. Each part is copied once while it loads, so this bounds the extra memory. */
const PART_BYTES = 256 * 1024 * 1024;
/** The largest central directory read; a real export of many thousand notes needs a few MB. */
const CENTRAL_DIRECTORY_LIMIT = 256 * 1024 * 1024;

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL_RECORD = 0x02014b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

type Source = Blob | ArrayBuffer | Uint8Array;
type Read = (start: number, end: number) => Promise<Uint8Array>;
type CentralRecord = { bytes: Uint8Array; offset: number };

export async function openZip(input: Source): Promise<JSZip> {
  try {
    const size = input instanceof Blob ? input.size : input.byteLength;
    if (size < SIGNED_LIMIT) return await JSZip.loadAsync(input);
    return await openZipInParts(input, PART_BYTES);
  } catch (err) {
    if (err instanceof ImportTooLargeError || err instanceof ImportFileError) throw err;
    throw new ImportFileError(err);
  }
}

/** Exported for the tests, which split a small zip with a small `partBytes`. */
export async function openZipInParts(input: Source, partBytes: number): Promise<JSZip> {
  const bytes = input instanceof Blob ? null : input instanceof Uint8Array ? input : new Uint8Array(input);
  const size = input instanceof Blob ? input.size : bytes!.byteLength;
  const read: Read = async (start, end) =>
    bytes ? bytes.subarray(start, end) : new Uint8Array(await (input as Blob).slice(start, end).arrayBuffer());

  const { records, centralStart } = await readCentralDirectory(read, size);
  records.sort((a, b) => a.offset - b.offset);
  const parts: JSZip[] = [];
  for (let i = 0; i < records.length; ) {
    const start = records[i]!.offset;
    let j = i + 1;
    // A part ends where the next one starts. A plain zip counts its entries in
    // 16 bits, and jszip takes a full count (0xFFFF) as a sign of ZIP64.
    while (j < records.length && j - i < MAX16 - 1 && nextOffset(records, j + 1, centralStart) - start <= partBytes) j++;
    parts.push(await loadPart(read, records.slice(i, j), start, nextOffset(records, j, centralStart)));
    i = j;
  }
  const zip = parts[0] ?? new JSZip();
  for (const part of parts.slice(1)) Object.assign(zip.files, part.files);
  return zip;
}

function nextOffset(records: CentralRecord[], index: number, centralStart: number): number {
  return index < records.length ? records[index]!.offset : centralStart;
}

function broken(what: string): Error {
  return new Error(`Corrupted zip: ${what}`);
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function u64(v: DataView, at: number): number {
  const n = v.getBigUint64(at, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw broken('64-bit value out of range');
  return Number(n);
}

async function readCentralDirectory(read: Read, size: number): Promise<{ records: CentralRecord[]; centralStart: number }> {
  const tailStart = Math.max(0, size - 22 - MAX16 - 20);
  const tail = await read(tailStart, size);
  const tv = view(tail);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw broken('no end of central directory');
  let count = tv.getUint16(at + 10, true);
  let centralSize = tv.getUint32(at + 12, true);
  let centralStart = tv.getUint32(at + 16, true);
  if (count === MAX16 || centralSize === MAX32 || centralStart === MAX32) {
    const loc = at - 20;
    if (loc < 0 || tv.getUint32(loc, true) !== ZIP64_LOCATOR) throw broken('no ZIP64 locator');
    const recordAt = u64(tv, loc + 8);
    if (recordAt + 56 > size) throw broken('ZIP64 end record out of range');
    const rv = view(await read(recordAt, recordAt + 56));
    if (rv.getUint32(0, true) !== ZIP64_EOCD) throw broken('no ZIP64 end record');
    count = u64(rv, 32);
    centralSize = u64(rv, 40);
    centralStart = u64(rv, 48);
  }
  if (centralSize > CENTRAL_DIRECTORY_LIMIT || centralStart + centralSize > size) throw broken('central directory out of range');

  const central = await read(centralStart, centralStart + centralSize);
  const cv = view(central);
  const records: CentralRecord[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > central.length || cv.getUint32(p, true) !== CENTRAL_RECORD) throw broken('bad central directory record');
    const compressedMax = cv.getUint32(p + 20, true) === MAX32;
    const uncompressedMax = cv.getUint32(p + 24, true) === MAX32;
    const nameLength = cv.getUint16(p + 28, true);
    const extraLength = cv.getUint16(p + 30, true);
    const length = 46 + nameLength + extraLength + cv.getUint16(p + 32, true);
    if (p + length > central.length) throw broken('central directory record out of range');
    let offset = cv.getUint32(p + 42, true);
    if (offset === MAX32) offset = zip64Offset(cv, p + 46 + nameLength, extraLength, uncompressedMax, compressedMax);
    if (offset >= centralStart) throw broken('entry offset out of range');
    records.push({ bytes: central.subarray(p, p + length), offset });
    p += length;
  }
  return { records, centralStart };
}

/** The local header offset from a ZIP64 extra field, which lists only the values whose 32-bit field is full. */
function zip64Offset(v: DataView, start: number, length: number, uncompressedMax: boolean, compressedMax: boolean): number {
  for (let q = start; q + 4 <= start + length; ) {
    const id = v.getUint16(q, true);
    const fieldLength = v.getUint16(q + 2, true);
    if (id === 0x0001) {
      const at = q + 4 + (uncompressedMax ? 8 : 0) + (compressedMax ? 8 : 0);
      if (at + 8 > q + 4 + fieldLength) break;
      return u64(v, at);
    }
    q += 4 + fieldLength;
  }
  throw broken('no ZIP64 offset');
}

async function loadPart(read: Read, records: CentralRecord[], start: number, end: number): Promise<JSZip> {
  const centralLength = records.reduce((sum, r) => sum + r.bytes.length, 0);
  const out = new Uint8Array(end - start + centralLength + 22);
  out.set(await read(start, end), 0);
  const ov = view(out);
  let at = end - start;
  for (const r of records) {
    out.set(r.bytes, at);
    // The entry's offset inside this part; a full ZIP64 field becomes a plain one, so jszip skips the extra.
    ov.setUint32(at + 42, r.offset - start, true);
    at += r.bytes.length;
  }
  ov.setUint32(at, EOCD, true);
  ov.setUint16(at + 8, records.length, true);
  ov.setUint16(at + 10, records.length, true);
  ov.setUint32(at + 12, centralLength, true);
  ov.setUint32(at + 16, end - start, true);
  return JSZip.loadAsync(out);
}
