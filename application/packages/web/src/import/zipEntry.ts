/**
 * Bounded reads of the text an importer takes out of a zip.
 *
 * A zip entry declares its uncompressed size in the central directory, and
 * jszip compares that number with the bytes it inflates. The comparison runs
 * at the END of the stream, after every byte has been produced, so a forged
 * small number passes any test made before the inflation, and the work is
 * done by the time the lie is caught. The bound is therefore a running count
 * of the bytes actually produced: the stream is paused and the read refused
 * the moment it passes the limit. The declared size is still read first,
 * because it refuses an honest oversize entry for free.
 *
 * What that bounds is the one place an import can grow without the user
 * seeing it: a few hundred compressed bytes that expand into gigabytes of
 * text. Every text entry is parsed whole on the UI thread, so such an entry
 * freezes the app before any preview appears, and no real export carries a
 * single text file of that size. A picture or file is read through
 * `zipEntryMedia`, bounded at the largest file any plan can upload: a few
 * gigabytes of one inflated attachment took the tab down (#656), and a file
 * past that limit could never sync anyway. It is skipped rather than refused,
 * because one long video in a journal export must not abort the rest of the
 * import; the importer counts it and says so with `mediaTooLargeWarning`.
 *
 * The UpNote snapshot is compressed twice, a gzip member inside the zip, and
 * the inner layer declares no size, so it is counted the same way.
 *
 * A bound per entry does not bound the file: a backup zip of under 100 KB
 * held a few hundred entries that each stayed under it and together came to
 * 48 MiB of note bodies (beta #155 part 2). So each import also carries one
 * `ImportBudget` across the whole file. `openZip` gives every entry of a zip
 * the same budget and refuses a zip that lists more than `IMPORT_ENTRY_LIMIT`
 * entries; every text read of those entries spends from it, and the import
 * stops once it passes `IMPORT_TEXT_LIMIT`. Pictures and files keep their own
 * bound per file and do not spend from it, because a journal export with
 * years of photos is real and is read one file at a time; an importer that
 * holds every file at once (KeePass XML) spends its own budget for them.
 */

import type JSZip from 'jszip';
import { perFileLimit } from '../attachmentValidation';
import { formatBytes } from '../formatBytes';
import i18n from '../i18n';

const msg = (key: string, options: Record<string, unknown> = {}): string => i18n.t(`importLog:zipEntry.${key}`, options);

/** The most text one zip entry may expand to before the import refuses it. */
const ZIP_TEXT_ENTRY_LIMIT = 256 * 1024 * 1024;

/**
 * The most text one import may read across the whole file, and the most
 * entries one zip may list. Both sit far above any real export: the largest
 * real backups in the importer lab hold a few tens of MB of text in a few
 * tens of thousands of entries. They bound a crafted file, not a person's.
 */
const IMPORT_TEXT_LIMIT = 1024 * 1024 * 1024;
export const IMPORT_ENTRY_LIMIT = 500_000;

/** The chunked read jszip's own `async()` is built on; absent from its typings. */
type EntryStream = {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
};

function declaredSize(entry: JSZip.JSZipObject): number | null {
  const internal = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof internal?.uncompressedSize === 'number' ? internal.uncompressedSize : null;
}

/**
 * A zip that cannot be opened, or an entry that cannot be inflated. The
 * message is a plain sentence for the person; `detail` keeps the reader's own
 * text ("End of data reached ... Corrupted zip ?"), which the import screen
 * shows under it as a technical detail for a bug report (#758).
 */
export class ImportFileError extends Error {
  readonly detail: string;
  constructor(cause: unknown) {
    super(msg('unreadable'));
    this.detail = cause instanceof Error ? cause.message : String(cause);
  }
}

/** Thrown before or during an inflation that would exceed the limit; an importer must not swallow it. */
export class ImportTooLargeError extends Error {}

/** The whole file is past its budget. Never a skip: the import stops. */
export class ImportBudgetError extends ImportTooLargeError {}

/** What one import may read across the whole file (see the header). */
export class ImportBudget {
  private spent = 0;
  constructor(private readonly limit = IMPORT_TEXT_LIMIT) {}

  /** Counts `bytes` read; throws once the total passes the limit. */
  spend(bytes: number): void {
    this.spent += bytes;
    if (this.spent > this.limit) throw new ImportBudgetError(msg('importTooLarge', { limit: formatBytes(this.limit) }));
  }
}

/** The budget `openZip` gave each entry of the zip it opened. */
const entryBudgets = new WeakMap<JSZip.JSZipObject, ImportBudget>();

/** One budget for every entry of `zip`, refused past `IMPORT_ENTRY_LIMIT` entries. */
export function budgetZip(zip: JSZip, budget = new ImportBudget()): JSZip {
  const entries = Object.values(zip.files);
  refuseEntryCount(entries.length);
  for (const entry of entries) entryBudgets.set(entry, budget);
  return zip;
}

/** Refuses a zip that lists more entries than any real export. */
export function refuseEntryCount(count: number): void {
  if (count > IMPORT_ENTRY_LIMIT) throw new ImportBudgetError(msg('tooManyEntries', { max: IMPORT_ENTRY_LIMIT }));
}

function tooLarge(name: string, limit: number, size?: number): ImportTooLargeError {
  return new ImportTooLargeError(
    size === undefined
      ? msg('entryTooLarge', { name, limit: formatBytes(limit) })
      : msg('entryTooLargeKnown', { name, size: formatBytes(size), limit: formatBytes(limit) }),
  );
}

function refuseOverLimit(entry: JSZip.JSZipObject, limit: number): void {
  const size = declaredSize(entry);
  if (size !== null && size > limit) throw tooLarge(entry.name, limit, size);
}

/**
 * The inflated bytes of one entry, refused past `limit` as they are produced.
 * A refusal pauses the stream, which stops the inflater before its next
 * block; the block in flight still arrives and is dropped, so the overshoot
 * is bounded by what one compressed block can expand to.
 */
function inflateBounded(entry: JSZip.JSZipObject, limit: number, budget?: ImportBudget): Promise<Uint8Array<ArrayBuffer>> {
  refuseOverLimit(entry, limit);
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const stream = (entry as unknown as EntryStream).internalStream('uint8array');
    stream
      .on('data', (chunk) => {
        if (settled) return;
        total += chunk.byteLength;
        if (total > limit) {
          settled = true;
          stream.pause();
          reject(tooLarge(entry.name, limit));
          return;
        }
        try {
          budget?.spend(chunk.byteLength);
        } catch (err) {
          settled = true;
          stream.pause();
          reject(err);
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(new ImportFileError(err));
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        const out = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          out.set(chunk, at);
          at += chunk.byteLength;
        }
        resolve(out);
      })
      .resume();
  });
}

/** The text of one entry, refused when it declares or produces more than `limit`. */
export async function zipEntryText(entry: JSZip.JSZipObject, limit = ZIP_TEXT_ENTRY_LIMIT): Promise<string> {
  // A byte-order mark stays in the text, which is how jszip's own decoder reads it.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await inflateBounded(entry, limit, entryBudgets.get(entry)));
}

/**
 * The bytes of one entry that is itself a compressed text container (a gzip
 * member, a zip inside the zip), bounded the same way.
 */
export async function zipEntryBytes(entry: JSZip.JSZipObject, limit = ZIP_TEXT_ENTRY_LIMIT): Promise<Uint8Array<ArrayBuffer>> {
  return inflateBounded(entry, limit, entryBudgets.get(entry));
}

/** The largest picture or file an import reads; nothing past it can upload on any plan. */
const mediaEntryLimit = (): number => perFileLimit(true, true);

/**
 * The bytes of one picture or file, or null when it declares or produces more
 * than the largest upload. Any other failure still throws.
 */
export async function zipEntryMedia(entry: JSZip.JSZipObject): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return await inflateBounded(entry, mediaEntryLimit());
  } catch (err) {
    if (err instanceof ImportTooLargeError && !(err instanceof ImportBudgetError)) return null;
    throw err;
  }
}

/** The import warning for the files `zipEntryMedia` skipped. */
export function mediaTooLargeWarning(count: number): string {
  return msg('mediaTooLarge', { count, size: formatBytes(mediaEntryLimit()) });
}

/**
 * Gunzip through the platform's DecompressionStream, decoding and counting the
 * output and refusing past `limit` (`gunzipBounded`). jsdom and some older embedders lack
 * Blob.stream(), so the source is a hand-rolled ReadableStream rather than
 * blob.stream(). The reader is drained by hand rather than through
 * `new Response(stream).text()`, because a throw inside a piped transform
 * reaches that Response as an opaque "Failed to fetch", losing the typed error
 * the caller needs to tell a refusal from a corrupt file.
 */
export async function gunzipText(
  data: Uint8Array<ArrayBuffer>,
  name: string,
  limit = ZIP_TEXT_ENTRY_LIMIT,
): Promise<string> {
  return new TextDecoder().decode(await gunzipBounded(data, name, limit));
}

/**
 * The bytes of one gzip-compressed picture or file (a KeePass attachment), or
 * null when it produces more than the largest upload, as `zipEntryMedia`.
 * With a `budget`, every byte it produces spends from it, and a spent budget
 * throws instead of skipping.
 */
export async function gunzipMedia(data: Uint8Array<ArrayBuffer>, name: string, budget?: ImportBudget): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return await gunzipBounded(data, name, mediaEntryLimit(), budget);
  } catch (err) {
    if (err instanceof ImportTooLargeError && !(err instanceof ImportBudgetError)) return null;
    throw err;
  }
}

/** True when a file of this many bytes is past the largest upload. */
export function mediaTooLarge(bytes: number): boolean {
  return bytes > mediaEntryLimit();
}

async function gunzipBounded(data: Uint8Array<ArrayBuffer>, name: string, limit: number, budget?: ImportBudget): Promise<Uint8Array<ArrayBuffer>> {
  const src = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const reader = src.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw tooLarge(name, limit);
      budget?.spend(value.byteLength);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
