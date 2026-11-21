import type JSZip from 'jszip';
import { mapOutsideCode } from './codeSegments';
import { mimeFromExt } from './blobImport';
import { zipEntryMedia } from './zipEntry';
import type { ImportBlob, ImportedNote } from './types';

/**
 * The pictures and files of an import whose notes name them by PATH: the
 * Markdown folder, Obsidian, Apple Notes, Anytype's Markdown export and
 * SiYuan. Each importer resolves a note's reference to one file of the
 * export when it reads the note and writes a fixed-width key in its place
 * (`mdfile:000001`), as Bear and Joplin do. A path as the key failed three
 * ways (beta #152): `icon.png` is inside `favicon.png`, so the swap for one
 * cut the other's reference in half; plain text holding a file name was
 * rewritten; and two folders that each hold `logo.png` shared one picture.
 * A fixed-width key is no other key's prefix, and it only ever stands in a
 * link target this module wrote.
 */

/** Fixed-width keys handed out per file path, in the order notes name them. */
export class FileKeys {
  private readonly byPath = new Map<string, string>();

  constructor(private readonly prefix: string) {}

  /** The key of one file of the export; the same path always gets the same key. */
  keyOf(path: string): string {
    let key = this.byPath.get(path);
    if (!key) {
      key = `${this.prefix}:${String(this.byPath.size + 1).padStart(6, '0')}`;
      this.byPath.set(path, key);
    }
    return key;
  }

  get size(): number {
    return this.byPath.size;
  }

  /** Each named path with its key. */
  entries(): IterableIterator<[string, string]> {
    return this.byPath.entries();
  }
}

/** A path with `.` and `..` resolved, or null when it climbs out of the export. */
function joinPath(dir: string, rel: string): string | null {
  const out: string[] = [];
  for (const seg of `${dir}/${rel}`.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** How many leading folders two directories share. */
function sharedDepth(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] && x[n] === y[n]) n++;
  return n;
}

/** The link as written and, when it differs, percent-decoded. */
function spellings(target: string): string[] {
  try {
    const decoded = decodeURIComponent(target);
    return decoded === target ? [target] : [target, decoded];
  } catch {
    return [target]; // a literal `%` in a file name
  }
}

/**
 * Resolves a link target in a note to one path of `paths`: relative to the
 * note's own folder first, then from the root of the export, then, as the
 * last resort, any file whose path ends with the target (`logo.png` or
 * `media/logo.png`), the one nearest the note winning and, at a tie, the
 * first in the export. A web address or an anchor resolves to nothing.
 */
export function fileResolver(paths: Iterable<string>): (target: string, noteDir: string) => string | null {
  const all = new Set(paths);
  const byName = new Map<string, string[]>();
  for (const path of all) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const list = byName.get(name);
    if (list) list.push(path);
    else byName.set(name, [path]);
  }
  return (target, noteDir) => {
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
    const tries = spellings(target);
    for (const spelling of tries) {
      for (const path of [joinPath(noteDir, spelling), joinPath('', spelling)]) {
        if (path && all.has(path)) return path;
      }
    }
    for (const spelling of tries) {
      const tail = joinPath('', spelling.replace(/^(?:\.{1,2}\/)+/, ''));
      if (!tail) continue;
      const found = (byName.get(tail.slice(tail.lastIndexOf('/') + 1)) ?? [])
        .filter((p) => p === tail || p.endsWith(`/${tail}`));
      let best: string | null = null;
      let depth = -1;
      for (const path of found) {
        const d = sharedDepth(dirOf(path), noteDir);
        if (d > depth) [best, depth] = [path, d];
      }
      if (best) return best;
    }
    return null;
  };
}

/** A Markdown link or picture; the target in angle brackets or bare, an optional title.
 *  A bare target may hold parentheses that pair up, one level deep, as
 *  CommonMark allows: `Screenshot (1).png` is how Windows and browsers name
 *  a second copy, and exports write such a name into a link as it is. */
const LINK = /(!?)\[([^\]\n]{0,1000})\]\((?:<([^>\n]{1,2048})>|((?:[^()\n]|\([^()\n]{0,512}\)){1,2048}))\)/g;

/**
 * The body with every link and picture outside code whose target resolves
 * to a file pointing at that file's key instead. Any other text, a file
 * name in a sentence included, is left as it was.
 */
export function keyFileRefs(
  body: string,
  noteDir: string,
  resolve: (target: string, noteDir: string) => string | null,
  keys: FileKeys,
): string {
  return mapOutsideCode(body, (prose) =>
    prose.replace(LINK, (whole, bang: string, label: string, angled?: string, bare?: string) => {
      // A bare target may end in a ` "title"`, which is not part of the path.
      const target = (angled ?? bare!.replace(/\s+"[^"\n]*"\s*$/, '')).trim();
      const path = resolve(target, noteDir);
      return path ? `${bang}[${label}](${keys.keyOf(path)})` : whole;
    }),
  );
}

/**
 * Reads each file a key was handed out for and returns it as a blob under
 * that key. A file too large to carry gets its path back in every link that
 * named it, so the note shows where it was instead of a key.
 */
export async function readKeyedFiles(
  keys: FileKeys,
  files: Map<string, JSZip.JSZipObject>,
  notes: ImportedNote[],
  onRead?: (done: number, total: number) => void,
  nameOf: (path: string) => string = (path) => path.slice(path.lastIndexOf('/') + 1),
): Promise<{ blobs: Map<string, ImportBlob>; tooLarge: number }> {
  const blobs = new Map<string, ImportBlob>();
  const unread = new Map<string, string>();
  let done = 0;
  for (const [path, key] of keys.entries()) {
    if (done % 10 === 0) onRead?.(done + 1, keys.size);
    done++;
    const entry = files.get(path);
    const data = entry ? await zipEntryMedia(entry) : null;
    if (!data) {
      unread.set(key, /[\s()<>]/.test(path) ? `<${path.replace(/[<>]/g, '')}>` : path);
      continue;
    }
    const name = nameOf(path);
    blobs.set(key, { data, mime: mimeFromExt(name), name });
  }
  if (unread.size) {
    for (const note of notes) {
      for (const [key, target] of unread) {
        if (note.body.includes(key)) note.body = note.body.split(`](${key})`).join(`](${target})`);
      }
    }
  }
  return { blobs, tooLarge: unread.size };
}
