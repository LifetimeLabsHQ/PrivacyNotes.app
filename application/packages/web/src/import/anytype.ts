import type JSZip from 'jszip';
import { mediaTooLargeWarning, zipEntryMedia, zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';
import { normalizeTag } from '../notesRepo';
import { createFolder, type FolderDef } from '../folders';
import { IMPORT_FOLDER_LIMIT } from './folderImport';
import { linkifyMarkdown } from './linkify';
import { noteLinkTarget } from '../noteLinks';
import { isBlobReferenced, mimeFromExt } from './blobImport';
import { detailsToFold } from './detailsFold';
import { parseFrontMatterDate } from './markdown';
import { escapeMarkdownText, guardMarkdownLineStart } from '../markdownEscape';
import { HIGHLIGHT_COLORS, TEXT_COLORS } from '../editorColors';
import type { ImportBlob, ImportedNote, ParsedImport } from './types';
import i18n from '../i18n';
import { num, str } from './importHelpers';

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:anytype.${key}`, options);

/**
 * Anytype importer.
 *
 * Reads the whole-space export Anytype writes from space settings > Export
 * (File > Export), in two of its formats:
 *
 *   Any-Block v1, JSON (the primary input): `objects/<id>.pb.json` per page,
 *   with `types/`, `relations/`, `relationsOptions/`, `templates/`,
 *   `filesObjects/` and `files/` beside it. The writer is
 *   `core/block/export/export.go` in anytype-heart; the snapshot shape is
 *   `pb/protos/snapshot.proto` and `pkg/lib/pb/model/protos/models.proto`.
 *   Enums are written as names. A Windows export names its entries with
 *   BACKSLASHES (`objects\<id>.pb.json`); both separators are read.
 *
 *   Markdown (the second input): `<slug>.md` with YAML front matter keyed by
 *   display name, plus `files/` and `schemas/`. It has already lost
 *   underline, colors, callouts, alignment, code languages and collections,
 *   and the import says so.
 *
 * The binary Any-Block (`.pb`) is refused with a plain message asking for
 * the JSON export. Format facts: the importer lab's app file for Anytype.
 *
 * Mapping of the JSON export:
 *   Page, Task, Note and Bookmark objects -> notes; types, properties,
 *     templates, sets, files, space members and widgets are not notes
 *   details.name                  -> title (a Note, or an empty name: the
 *                                    first line of the text)
 *   the block tree (childrenIds)  -> the body, in order and nesting
 *   text styles and marks         -> Markdown; marks are UTF-16 ranges and
 *                                    nest by start, then length
 *   TextColor / BackgroundColor   -> a palette `<span style>` / highlight
 *   Toggle, ToggleHeader1-3       -> a Fold callout, folded (Anytype keeps
 *                                    the open state on the device only)
 *   Callout                       -> a callout whose type follows its color
 *   Code (fields.lang)            -> fenced code with its language
 *   latex Latex / Mermaid         -> $$math$$ / fenced mermaid
 *   latex embeds (YouTube, ...)   -> a link, or fenced code for an embed
 *                                    that is code, not a URL
 *   table                         -> a pipe table, first header row as header
 *   link block, Mention, Object   -> a note-link to the target's title
 *   bookmark block                -> [title](url)
 *   file blocks                   -> imported images and files
 *   tag                           -> tags
 *   isArchived / isFavorite       -> trashed (Anytype's Bin) / starred
 *   Task done                     -> a checkbox line on top, task type
 *   custom properties             -> a short list at the top of the note
 *   collections                   -> a folder named after the collection
 *   icon, cover                   -> dropped, with a warning
 */

/* ------------------------------------------------------------------ */
/* Loose readers for a stranger's JSON                                 */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: unknown, k: string): unknown => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : []);

/** An enum that arrives as its name, or, from an older writer, as its number. */
function enumName(v: unknown, names: readonly string[], fallback: string): string {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < names.length) return names[v] ?? fallback;
  return fallback;
}

// models.proto: Block.Content.Text.Style and Mark.Type, in enum order.
const TEXT_STYLES = ['Paragraph', 'Header1', 'Header2', 'Header3', 'Header4', 'Quote', 'Code', 'Title', 'Checkbox', 'Marked', 'Numbered', 'Toggle', 'Description', 'Callout', 'ToggleHeader1', 'ToggleHeader2', 'ToggleHeader3'] as const;
const MARK_TYPES = ['Strikethrough', 'Keyboard', 'Italic', 'Bold', 'Underscored', 'Link', 'TextColor', 'BackgroundColor', 'Mention', 'Emoji', 'Object'] as const;
const LAYOUT_STYLES = ['Row', 'Column', 'Div', 'Header', 'TableRows', 'TableColumns'] as const;
const LATEX_PROCESSORS = ['Latex', 'Mermaid', 'Chart', 'Youtube', 'Vimeo', 'Soundcloud', 'GoogleMaps', 'Miro', 'Figma', 'Twitter', 'OpenStreetMap', 'Reddit', 'Facebook', 'Instagram', 'Telegram', 'GithubGist', 'Codepen', 'Bilibili', 'Excalidraw', 'Kroki', 'Graphviz', 'Sketchfab', 'Image', 'Drawio', 'Spotify'] as const;
const FILE_TYPES = ['None', 'File', 'Image', 'Video', 'Audio', 'PDF'] as const;
const ALIGNS = ['AlignLeft', 'AlignCenter', 'AlignRight', 'AlignJustify'] as const;

// models.proto: ObjectType.Layout.
const LAYOUT_BASIC = 0;
const LAYOUT_TODO = 2;
const LAYOUT_SET = 3;
const LAYOUT_NOTE = 9;
const LAYOUT_BOOKMARK = 11;
const LAYOUT_COLLECTION = 14;
const NOTE_LAYOUTS = new Set([LAYOUT_BASIC, LAYOUT_TODO, LAYOUT_NOTE, LAYOUT_BOOKMARK]);

// models.proto: RelationFormat.
const FMT_NUMBER = 2;
const FMT_STATUS = 3;
const FMT_DATE = 4;
const FMT_FILE = 5;
const FMT_CHECKBOX = 6;
const FMT_TAG = 11;
const FMT_OBJECT = 100;

/** A key Anytype makes for a property the person created (a BSON object id). */
const CUSTOM_KEY = /^[0-9a-f]{24}$/;

/** The top-level folders of one space in the export. */
const SPACE_DIRS = /^(?:(.*)\/)?(objects|types|relations|relationsOptions|templates|filesObjects|files)\/([^/]+)$/;

/** A path out of a zip or a file field: forward slashes, no `.` or `..`, no leading slash. */
function normPath(p: string): string {
  const segs: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') segs.pop();
    else segs.push(seg);
  }
  return segs.join('/');
}

/* ------------------------------------------------------------------ */
/* Colors                                                              */
/* ------------------------------------------------------------------ */

/** Anytype's color names (`constant.ts` textColor in anytype-ts) on our palette names. */
const ANYTYPE_COLOR: Record<string, string> = {
  grey: 'Gray', gray: 'Gray', yellow: 'Yellow', orange: 'Orange', red: 'Red', pink: 'Pink',
  purple: 'Purple', blue: 'Blue', ice: 'Blue', teal: 'Teal', lime: 'Green',
};

function paletteName(color: string): string | null {
  const key = color.trim().toLowerCase();
  return Object.hasOwn(ANYTYPE_COLOR, key) ? ANYTYPE_COLOR[key]! : null;
}

/** The callout type a colored Anytype callout lands on (docs/contrib/callouts.md). */
const CALLOUT_BY_COLOR = new Map([
  ['Gray', 'note'], ['Yellow', 'idea'], ['Orange', 'warning'], ['Red', 'danger'], ['Pink', 'caution'],
  ['Purple', 'important'], ['Blue', 'info'], ['Teal', 'tip'], ['Green', 'success'],
]);

/* ------------------------------------------------------------------ */
/* Inline text with marks                                              */
/* ------------------------------------------------------------------ */

interface Mark {
  from: number;
  to: number;
  type: string;
  param: string;
}

type Mode = 'md' | 'html' | 'cell';

/** What the inline renderer asks the importer about the objects a mark names. */
interface InlineCtx {
  /** A note-link, a file link, or null when the target cannot be linked. */
  objectLink(id: string, label: string, mode: Mode): string | null;
  counts: Counts;
}

/** The HTML form of a delimiter mark, which the editor reads the same (Markdown with html on). */
const HTML_EQUIV = new Map<string, [string, string]>([
  ['Bold', ['<strong>', '</strong>']],
  ['Italic', ['<em>', '</em>']],
  ['Strikethrough', ['<s>', '</s>']],
  ['BackgroundColor', ['<mark>', '</mark>']],
]);

const ATOMIC = new Set(['Keyboard', 'Mention', 'Object', 'Emoji']);
const TRIMMED = new Set(['Bold', 'Italic', 'Strikethrough']);
const TYPE_ORDER = ['Link', 'BackgroundColor', 'TextColor', 'Underscored', 'Strikethrough', 'Bold', 'Italic'];

function safeUrl(raw: string, mode: Mode): string | null {
  const url = raw.trim();
  if (!url || /[\s<>"]/.test(url.replace(/ /g, ''))) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme && !['http', 'https', 'mailto', 'tel'].includes(scheme)) return null;
  let out = url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  if (mode === 'cell') out = out.replace(/\|/g, '%7C');
  return out;
}

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function codeSpan(text: string, mode: Mode): string {
  if (mode === 'html') return `<code>${escHtml(text)}</code>`;
  const t = mode === 'cell' ? text.replace(/\|/g, '\\|') : text;
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = t.startsWith('`') || t.endsWith('`') || (t.startsWith(' ') && t.endsWith(' ') && t.trim()) ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

/** The tags one mark opens and closes, or null for a mark that writes nothing here. */
function markTags(m: Mark, mode: Mode, ctx: InlineCtx): [string, string] | null {
  const html = mode === 'html';
  switch (m.type) {
    case 'Bold':
      return html ? ['<strong>', '</strong>'] : ['**', '**'];
    case 'Italic':
      return html ? ['<em>', '</em>'] : ['*', '*'];
    case 'Strikethrough':
      return html ? ['<s>', '</s>'] : ['~~', '~~'];
    case 'Underscored':
      return ['<u>', '</u>'];
    case 'Link': {
      const url = safeUrl(m.param, mode);
      if (!url) return null;
      return html ? [`<a href="${escHtml(url)}">`, '</a>'] : ['[', `](${url})`];
    }
    case 'TextColor': {
      const name = paletteName(m.param);
      const value = name ? TEXT_COLORS.find((c) => c.name === name)?.value : undefined;
      if (!value) return null;
      ctx.counts.colors++;
      return [`<span style="color: ${value}">`, '</span>'];
    }
    case 'BackgroundColor': {
      const name = paletteName(m.param);
      const hl = name ? HIGHLIGHT_COLORS.find((c) => c.name === name) : undefined;
      if (!hl) return null;
      ctx.counts.colors++;
      if (hl.value === null) return html ? ['<mark>', '</mark>'] : ['==', '=='];
      return [`<mark style="background-color: ${hl.value}">`, '</mark>'];
    }
    default:
      return null;
  }
}

function readMarks(raw: unknown, length: number): Mark[] {
  const list = own(raw, 'marks');
  if (!Array.isArray(list)) return [];
  const out: Mark[] = [];
  for (const m of list) {
    const range = own(m, 'range');
    const from = Math.max(0, Math.min(length, num(own(range, 'from')) ?? 0));
    const to = Math.max(0, Math.min(length, num(own(range, 'to')) ?? 0));
    const type = enumName(own(m, 'type'), MARK_TYPES, '');
    if (!type || to <= from) continue;
    out.push({ from, to, type, param: str(own(m, 'param')) });
  }
  return out;
}

/**
 * Text plus its marks as inline Markdown (or HTML, for an aligned block).
 * Ranges are UTF-16 offsets, which is what a JavaScript string indexes.
 */
function renderInline(text: string, rawMarks: Mark[], mode: Mode, ctx: InlineCtx): string {
  let marks = rawMarks.map((m) => ({ ...m }));
  // Emphasis cannot open or close on a space: shrink those ranges past it.
  for (const m of marks) {
    if (!TRIMMED.has(m.type)) continue;
    while (m.from < m.to && /\s/.test(text[m.from]!)) m.from++;
    while (m.to > m.from && /\s/.test(text[m.to - 1]!)) m.to--;
  }
  marks = marks.filter((m) => m.to > m.from);
  // Touching or overlapping marks of one kind are one mark, or `**a****b**` follows.
  marks.sort((a, b) => a.type.localeCompare(b.type) || a.param.localeCompare(b.param) || a.from - b.from);
  const merged: Mark[] = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && !ATOMIC.has(m.type) && last.type === m.type && last.param === m.param && m.from <= last.to) last.to = Math.max(last.to, m.to);
    else merged.push(m);
  }
  // An atomic run (code, a mention, an emoji) is written whole; a later one overlapping it is dropped.
  const atoms = merged.filter((m) => ATOMIC.has(m.type)).sort((a, b) => a.from - b.from || b.to - a.to);
  const keptAtoms: Mark[] = [];
  for (const a of atoms) if (!keptAtoms.some((k) => a.from < k.to && k.from < a.to)) keptAtoms.push(a);
  const spans = merged.filter((m) => !ATOMIC.has(m.type));

  const inAtom = (p: number) => keptAtoms.some((a) => p > a.from && p < a.to);
  const cuts = new Set<number>([0, text.length]);
  for (const m of [...spans, ...keptAtoms]) {
    cuts.add(m.from);
    cuts.add(m.to);
  }
  const points = [...cuts].filter((p) => !inAtom(p)).sort((a, b) => a - b);

  const canonical = (a: Mark, b: Mark) => a.from - b.from || b.to - a.to || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
  const tags = new Map<Mark, [string, string] | null>();
  const tagsOf = (m: Mark) => {
    if (!tags.has(m)) tags.set(m, markTags(m, mode, ctx));
    return tags.get(m)!;
  };
  const plain = (s: string) => {
    if (mode === 'html') return escHtml(s).replace(/\n/g, '<br>');
    const e = escapeMarkdownText(s);
    return mode === 'cell' ? e.replace(/\n/g, '<br>') : e;
  };

  let out = '';
  const stack: Mark[] = [];
  /** The delimiter character the output just closed with, while nothing else followed it. */
  let closedWith = '';
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const active = spans.filter((m) => m.from <= a && m.to >= b && tagsOf(m)).sort(canonical);
    // Close down to the deepest mark that is still open in this run, then open the rest.
    let keep = 0;
    while (keep < stack.length && active.includes(stack[keep]!)) keep++;
    closedWith = '';
    while (stack.length > keep) {
      const close = tagsOf(stack.pop()!)![1];
      out += close;
      closedWith = close[close.length - 1]!;
    }
    for (const m of active) {
      if (stack.includes(m)) continue;
      // `**a *b***` then `*c*` would glue into one delimiter run and parse as
      // neither: an overlap reopens its mark as the HTML tag instead.
      const open = tagsOf(m)![0];
      const html = HTML_EQUIV.get(m.type);
      if (closedWith && open[0] === closedWith && html) tags.set(m, html);
      out += tagsOf(m)![0];
      closedWith = '';
      stack.push(m);
    }
    const atom = keptAtoms.find((x) => x.from === a && x.to === b);
    const segment = text.slice(a, b);
    if (!atom) out += plain(segment);
    else if (atom.type === 'Keyboard') out += codeSpan(segment, mode);
    else if (atom.type === 'Emoji') out += plain(atom.param || segment);
    else out += ctx.objectLink(atom.param, segment, mode) ?? plain(segment);
  }
  while (stack.length) out += tagsOf(stack.pop()!)![1];
  return out;
}

/* ------------------------------------------------------------------ */
/* Counters                                                            */
/* ------------------------------------------------------------------ */

interface Counts {
  noteLinks: number;
  missingLinks: number;
  missingFiles: number;
  tooLarge: number;
  tables: number;
  codeBlocks: number;
  math: number;
  mermaid: number;
  embeds: number;
  callouts: number;
  folds: number;
  checklists: number;
  colors: number;
  aligned: number;
  droppedAlign: number;
  droppedColors: number;
  droppedBlocks: number;
  icons: number;
  covers: number;
  properties: number;
  tasks: number;
}

const newCounts = (): Counts => ({
  noteLinks: 0, missingLinks: 0, missingFiles: 0, tooLarge: 0, tables: 0, codeBlocks: 0, math: 0,
  mermaid: 0, embeds: 0, callouts: 0, folds: 0, checklists: 0, colors: 0, aligned: 0, droppedAlign: 0,
  droppedColors: 0, droppedBlocks: 0, icons: 0, covers: 0, properties: 0, tasks: 0,
});

/* ------------------------------------------------------------------ */
/* The Any-Block JSON export                                           */
/* ------------------------------------------------------------------ */

interface AnyObject {
  id: string;
  sbType: string;
  details: Json;
  blocks: Map<string, Json>;
  objectTypes: string[];
  collection: string[];
}

interface FileObject {
  name: string;
  mime: string;
  /** Normalized path of the bytes inside the zip, or '' when the export has none. */
  path: string;
}

function readSnapshot(raw: unknown): AnyObject | null {
  const snapshot = own(raw, 'snapshot');
  const data = own(snapshot, 'data');
  const details = own(data, 'details');
  if (!isObj(details)) return null;
  const id = str(own(details, 'id'));
  const blocks = new Map<string, Json>();
  const list = own(data, 'blocks');
  if (Array.isArray(list)) for (const b of list) if (isObj(b) && typeof b.id === 'string') blocks.set(b.id, b);
  return {
    id,
    sbType: str(own(raw, 'sbType')),
    details,
    blocks,
    objectTypes: strList(own(data, 'objectTypes')),
    collection: strList(own(own(data, 'collections'), 'objects')),
  };
}

function layoutOf(o: AnyObject): number {
  return num(own(o.details, 'resolvedLayout')) ?? num(own(o.details, 'layout')) ?? LAYOUT_BASIC;
}

/** Unix seconds from the file, or null for a value no real page has. */
function isoFromSeconds(v: unknown, nowMs: number): string | null {
  const s = num(v);
  if (s === null || s <= 0) return null;
  const ms = s * 1000;
  if (ms > nowMs + 366 * 86_400_000) return null;
  return new Date(ms).toISOString();
}

/** The first line of text in a block tree, for a page with no name. */
function firstLine(o: AnyObject): string {
  const seen = new Set<string>();
  const walk = (id: string, depth: number): string => {
    if (seen.has(id) || depth > 64) return '';
    seen.add(id);
    const b = o.blocks.get(id);
    if (!b) return '';
    const text = own(b, 'text');
    if (isObj(text) && id !== 'title') {
      const style = enumName(own(text, 'style'), TEXT_STYLES, 'Paragraph');
      const line = str(own(text, 'text')).split('\n').find((l) => l.trim()) ?? '';
      if (style !== 'Code' && style !== 'Title' && line.trim()) return line.trim().slice(0, 200);
    }
    for (const c of strList(own(b, 'childrenIds'))) {
      const found = walk(c, depth + 1);
      if (found) return found;
    }
    return '';
  };
  return walk(o.id, 0);
}

interface Chunk {
  text: string;
  /** A list item: the next item of the same kind follows on the next line. */
  list?: 'bullet' | 'number' | 'task';
}

function joinChunks(chunks: Chunk[]): string {
  let out = '';
  chunks.forEach((c, i) => {
    if (i > 0) {
      const prev = chunks[i - 1]!;
      out += prev.list && prev.list === c.list ? '\n' : '\n\n';
    }
    out += c.text;
  });
  return out;
}

const indentLines = (text: string, pad: string): string => text.split('\n').map((l) => (l ? pad + l : l)).join('\n');
const quoteLines = (text: string): string[] => text.split('\n').map((l) => (l ? `> ${l}` : '>'));

async function parseAnyBlock(entries: Map<string, JSZip.JSZipObject>, file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(msg('readingObjects'));
  const nowMs = Date.now();
  const objects: AnyObject[] = [];
  const typeKeys = new Map<string, string>();
  const relations = new Map<string, { name: string; format: number }>();
  const options = new Map<string, string>();
  const fileObjects = new Map<string, FileObject>();
  let templates = 0;
  let damaged = 0;

  for (const [path, entry] of entries) {
    const m = SPACE_DIRS.exec(path);
    if (!m || m[2] === 'files' || !m[3]!.endsWith('.pb.json')) continue;
    const root = m[1] ? `${m[1]}/` : '';
    let raw: unknown;
    try {
      raw = JSON.parse(await zipEntryText(entry));
    } catch (err) {
      if (err instanceof SyntaxError) {
        damaged++;
        continue;
      }
      throw err;
    }
    const o = readSnapshot(raw);
    if (!o) {
      damaged++;
      continue;
    }
    const d = o.details;
    switch (m[2]) {
      case 'objects':
        if (o.sbType === 'Template') templates++;
        else if (o.sbType === 'FileObject') fileObjects.set(o.id, fileObjectOf(d, root));
        else objects.push(o);
        break;
      case 'templates':
        templates++;
        break;
      case 'types':
        if (o.id) typeKeys.set(o.id, str(own(d, 'uniqueKey')));
        break;
      case 'relations': {
        const key = str(own(d, 'relationKey'));
        if (key) relations.set(key, { name: str(own(d, 'name')), format: num(own(d, 'relationFormat')) ?? 0 });
        break;
      }
      case 'relationsOptions':
        if (o.id) options.set(o.id, str(own(d, 'name')));
        break;
      case 'filesObjects':
        if (o.id) fileObjects.set(o.id, fileObjectOf(d, root));
        break;
    }
  }

  const typeKey = (o: AnyObject): string => o.objectTypes[0] ?? typeKeys.get(str(own(o.details, 'type'))) ?? '';
  const isNoteObject = (o: AnyObject): boolean =>
    o.sbType === 'Page' && NOTE_LAYOUTS.has(layoutOf(o)) && typeKey(o) !== 'ot-template' && own(o.details, 'isHidden') !== true && own(o.details, 'isDeleted') !== true;

  const pages = objects.filter(isNoteObject);
  const sets = objects.filter((o) => o.sbType === 'Page' && layoutOf(o) === LAYOUT_SET).length;
  const collections = objects.filter((o) => o.sbType === 'Page' && layoutOf(o) === LAYOUT_COLLECTION);
  const byId = new Map(objects.map((o) => [o.id, o]));

  if (pages.length === 0) throw new Error(msg('noPages'));

  // Titles first: every note-link needs its target's title.
  const titles = new Map<string, string>();
  for (const o of pages) {
    const name = str(own(o.details, 'name')).replace(/\s+/g, ' ').trim();
    titles.set(o.id, layoutOf(o) === LAYOUT_NOTE || !name ? firstLine(o) : name);
  }

  const counts = newCounts();
  const blobs = new Map<string, ImportBlob>();
  const blobKeyOf = new Map<string, string | null>();

  /** The blob key of one file object, read on first use; null when the bytes are not in the export. */
  const fileKey = async (id: string): Promise<string | null> => {
    if (blobKeyOf.has(id)) return blobKeyOf.get(id)!;
    const fo = fileObjects.get(id);
    const entry = fo?.path ? entries.get(fo.path) : undefined;
    let key: string | null = null;
    if (fo && entry) {
      const data = await zipEntryMedia(entry);
      if (data) {
        key = `anytype-file:${String(blobs.size + 1).padStart(6, '0')}`;
        const mime = fo.mime.split(';')[0]!.trim().toLowerCase();
        blobs.set(key, { data: new Uint8Array(data), mime: /^[a-z]+\/[\w.+-]+$/.test(mime) ? mime : mimeFromExt(fo.name), name: fo.name });
      } else counts.tooLarge++;
    }
    blobKeyOf.set(id, key);
    return key;
  };
  const fileName = (id: string): string => fileObjects.get(id)?.name ?? '';
  const missingFileMarker = (name: string): string => `\`[file: ${(name || '?').replace(/`/g, "'")} - not in the Anytype export]\``;

  const noteLink = (id: string, label: string, mode: Mode): string | null => {
    const title = titles.get(id);
    if (title === undefined) return null;
    const target = noteLinkTarget(title);
    const clean = label.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!target) return clean ? escapeMarkdownText(clean) : null;
    counts.noteLinks++;
    return mode === 'cell' || !clean || clean === target ? `[[${target}]]` : `[[${target}|${clean}]]`;
  };

  /**
   * A mark that names an object. A file object is linked in a second pass,
   * because reading its bytes is async: the renderer leaves a placeholder.
   */
  const pendingFiles = new Map<string, { id: string; label: string }>();
  const inlineCtx: InlineCtx = {
    counts,
    objectLink(id, label, mode) {
      const link = noteLink(id, label, mode);
      if (link !== null) return link;
      if (fileObjects.has(id) && mode !== 'html') {
        const token = `\u0000anytype-pending-${pendingFiles.size}\u0000`;
        pendingFiles.set(token, { id, label });
        return token;
      }
      if (!byId.has(id)) counts.missingLinks++;
      return null;
    },
  };

  const textOf = (b: Json, mode: Mode, extra: Mark[] = []): string => {
    const t = own(b, 'text');
    const text = str(own(t, 'text'));
    const marks = [...readMarks(own(t, 'marks'), text.length), ...extra];
    return renderInline(text, marks, mode, inlineCtx);
  };

  /** Whole-block colors become marks over the whole text. */
  const blockColorMarks = (b: Json): Mark[] => {
    const t = own(b, 'text');
    const len = str(own(t, 'text')).length;
    const out: Mark[] = [];
    const color = str(own(t, 'color'));
    const bg = str(own(b, 'backgroundColor'));
    if (color && color !== 'default') out.push({ from: 0, to: len, type: 'TextColor', param: color });
    if (bg && bg !== 'default') out.push({ from: 0, to: len, type: 'BackgroundColor', param: bg });
    return out;
  };

  const renderTable = (b: Json, o: AnyObject): string => {
    const kids = strList(own(b, 'childrenIds')).map((id) => o.blocks.get(id));
    const layout = (k: Json | undefined) => enumName(own(own(k, 'layout'), 'style'), LAYOUT_STYLES, '');
    const cols = strList(own(kids.find((k) => layout(k) === 'TableColumns'), 'childrenIds'));
    const rows = strList(own(kids.find((k) => layout(k) === 'TableRows'), 'childrenIds'));
    if (cols.length === 0 || rows.length === 0) return '';
    counts.tables++;
    const cellText = (rowId: string, colId: string) => {
      const cell = o.blocks.get(`${rowId}-${colId}`);
      if (!cell || !isObj(own(cell, 'text'))) return ' ';
      // escapeMarkdownText already escapes a typed pipe; a pipe a link adds is encoded.
      return textOf(cell, 'cell').trim() || ' ';
    };
    const grid = rows.map((r) => ({ header: own(own(o.blocks.get(r), 'tableRow'), 'isHeader') === true, cells: cols.map((c) => cellText(r, c)) }));
    const firstIsHeader = grid[0]!.header;
    const header = firstIsHeader ? grid[0]!.cells : cols.map(() => ' ');
    const body = firstIsHeader ? grid.slice(1) : grid;
    return [
      `| ${header.join(' | ')} |`,
      `| ${cols.map(() => '---').join(' | ')} |`,
      ...body.map((r) => `| ${r.cells.join(' | ')} |`),
    ].join('\n');
  };

  /**
   * Row, Column and Div layout blocks only group their children (Anytype
   * wraps long pages in Divs of 50 blocks), so they are opened in place: a
   * numbered list that runs across two of them keeps counting.
   */
  const expandLayout = (ids: string[], o: AnyObject, seen: Set<string>, depth: number): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      const b = o.blocks.get(id);
      const layout = own(b, 'layout');
      const style = isObj(layout) ? enumName(own(layout, 'style'), LAYOUT_STYLES, 'Div') : '';
      if (b && (style === 'Row' || style === 'Column' || style === 'Div') && !seen.has(id) && depth < 48) {
        seen.add(id);
        if (str(own(b, 'backgroundColor')) && str(own(b, 'backgroundColor')) !== 'default') counts.droppedColors++;
        out.push(...expandLayout(strList(own(b, 'childrenIds')), o, seen, depth + 1));
      } else out.push(id);
    }
    return out;
  };

  const renderBlocks = async (ids: string[], o: AnyObject, seen: Set<string>, depth: number): Promise<Chunk[]> => {
    const chunks: Chunk[] = [];
    let number = 0;
    for (const id of expandLayout(ids, o, seen, depth)) {
      if (seen.has(id) || depth > 48) continue;
      seen.add(id);
      const b = o.blocks.get(id);
      if (!b) continue;
      const kids = strList(own(b, 'childrenIds'));
      const children = () => renderBlocks(kids, o, seen, depth + 1);
      const text = own(b, 'text');
      const style = isObj(text) ? enumName(own(text, 'style'), TEXT_STYLES, 'Paragraph') : '';
      if (style !== 'Numbered') number = 0;
      const align = enumName(own(b, 'align'), ALIGNS, 'AlignLeft');
      const alignCss = align === 'AlignCenter' ? 'center' : align === 'AlignRight' ? 'right' : align === 'AlignJustify' ? 'justify' : '';

      if (isObj(text)) {
        if (style === 'Title' || id === 'title') continue;
        if (style === 'Description' || id === 'description') continue; // written from details
        const raw = str(own(text, 'text'));
        const colors = style === 'Code' || style === 'Callout' ? [] : blockColorMarks(b);
        if (alignCss && !['Paragraph', 'Header1', 'Header2', 'Header3', 'Header4'].includes(style)) counts.droppedAlign++;

        if (style === 'Code') {
          if (blockColorMarks(b).length) counts.droppedColors++;
          counts.codeBlocks++;
          const rawLang = str(own(own(b, 'fields'), 'lang')).trim();
          const lang = /^[\w#+.-]{1,30}$/.test(rawLang) && !/^(plain|plaintext|text|none)$/i.test(rawLang) ? rawLang : '';
          const longest = Math.max(2, ...(raw.match(/`{3,}/g) ?? []).map((r) => r.length));
          const fence = '`'.repeat(longest + 1);
          chunks.push({ text: `${fence}${lang}\n${raw}\n${fence}` });
          chunks.push(...(await children()));
          continue;
        }

        if (style === 'Marked' || style === 'Numbered' || style === 'Checkbox') {
          const kind = style === 'Marked' ? 'bullet' : style === 'Numbered' ? 'number' : 'task';
          if (kind === 'number') number++;
          if (kind === 'task') counts.checklists++;
          const marker = kind === 'bullet' ? '- ' : kind === 'number' ? `${number}. ` : `- [${own(text, 'checked') === true ? 'x' : ' '}] `;
          const pad = kind === 'number' ? ' '.repeat(marker.length) : '  ';
          const lines = textOf(b, 'md', colors).split('\n');
          const own0 = `${marker}${lines.map((l, i) => (i === 0 ? l : `${pad}${l || '&nbsp;'}`)).join('\\\n')}`.trimEnd();
          const sub = await children();
          chunks.push({ text: sub.length ? `${own0}\n${indentLines(joinChunks(sub), pad)}` : own0, list: kind });
          continue;
        }

        if (style === 'Toggle' || style.startsWith('ToggleHeader')) {
          counts.folds++;
          const title = textOf(b, 'md', colors).replace(/\\?\n/g, ' ').trim();
          const body = joinChunks(await children());
          chunks.push({ text: [`> [!fold]- ${title}`.trimEnd(), ...(body ? quoteLines(body) : [])].join('\n') });
          continue;
        }

        if (style === 'Callout') {
          counts.callouts++;
          const name = paletteName(str(own(b, 'backgroundColor'))) ?? paletteName(str(own(text, 'color')));
          const type = (name && CALLOUT_BY_COLOR.get(name)) || 'note';
          const inner = textOf(b, 'md');
          const own0 = inner.trim() ? inner.split('\n').map((l) => guardMarkdownLineStart(l) || '&nbsp;').join('\\\n') : '';
          const body = joinChunks([...(own0 ? [{ text: own0 }] : []), ...(await children())]);
          chunks.push({ text: [`> [!${type}]+`, ...(body ? quoteLines(body) : [])].join('\n') });
          continue;
        }

        if (style === 'Quote') {
          const lines = textOf(b, 'md', colors).split('\n');
          // A blank line inside the text is a paragraph break inside the quote.
          const parts: string[] = [];
          lines.forEach((l, i) => {
            if (!l) {
              parts.push('');
              return;
            }
            const next = lines[i + 1];
            parts.push(guardMarkdownLineStart(l) + (next ? '\\' : ''));
          });
          const sub = joinChunks(await children());
          chunks.push({ text: [...quoteLines(parts.join('\n')), ...(sub ? ['>', ...quoteLines(sub)] : [])].join('\n') });
          continue;
        }

        const heading = /^Header([1-4])$/.exec(style);
        if (heading) {
          const level = Number(heading[1]);
          if (!raw.trim()) {
            chunks.push(...(await children()));
            continue;
          }
          if (alignCss) {
            counts.aligned++;
            chunks.push({ text: `<h${level} style="text-align: ${alignCss}">${textOf(b, 'html', colors).replace(/<br>/g, ' ')}</h${level}>` });
          } else chunks.push({ text: `${'#'.repeat(level)} ${textOf(b, 'md', colors).replace(/\n/g, ' ')}` });
          chunks.push(...(await children()));
          continue;
        }

        // Paragraph, and any style this reader does not know, as a paragraph.
        if (!raw.trim()) chunks.push({ text: '&nbsp;' });
        else if (alignCss) {
          counts.aligned++;
          chunks.push({ text: `<p style="text-align: ${alignCss}">${textOf(b, 'html', colors)}</p>` });
        } else {
          const lines = textOf(b, 'md', colors).split('\n');
          chunks.push({ text: lines.map((l) => guardMarkdownLineStart(l) || '&nbsp;').join('\\\n') });
        }
        chunks.push(...(await children()));
        continue;
      }

      if (str(own(b, 'backgroundColor')) && str(own(b, 'backgroundColor')) !== 'default') counts.droppedColors++;
      if (alignCss) counts.droppedAlign++;

      if (isObj(own(b, 'layout'))) continue; // the header (title, description, featured properties: from details)
      if (isObj(own(b, 'smartblock'))) {
        chunks.push(...(await children()));
        continue;
      }
      if (isObj(own(b, 'div'))) {
        chunks.push({ text: '---' });
        continue;
      }
      if (isObj(own(b, 'table'))) {
        const t = renderTable(b, o);
        if (t) chunks.push({ text: t });
        continue;
      }
      const latex = own(b, 'latex');
      if (isObj(latex)) {
        const src = str(own(latex, 'text')).trim();
        if (!src) continue;
        const proc = enumName(own(latex, 'processor'), LATEX_PROCESSORS, 'Latex');
        if (proc === 'Latex') {
          counts.math++;
          chunks.push({ text: `$$${src}$$` });
        } else if (proc === 'Mermaid') {
          counts.mermaid++;
          chunks.push({ text: `\`\`\`mermaid\n${src}\n\`\`\`` });
        } else {
          counts.embeds++;
          const url = /^https?:\/\/\S+$/i.test(src) ? safeUrl(src, 'md') : null;
          if (url) chunks.push({ text: `[${escapeMarkdownText(src)}](${url})` });
          else {
            const longest = Math.max(2, ...(src.match(/`{3,}/g) ?? []).map((r) => r.length));
            const fence = '`'.repeat(longest + 1);
            chunks.push({ text: `${fence}${proc.toLowerCase()}\n${src}\n${fence}` });
          }
        }
        continue;
      }
      const bookmark = own(b, 'bookmark');
      if (isObj(bookmark)) {
        const url = safeUrl(str(own(bookmark, 'url')), 'md');
        if (!url) continue;
        const title = str(own(bookmark, 'title')).replace(/\s+/g, ' ').trim();
        chunks.push({ text: `[${escapeMarkdownText(title || str(own(bookmark, 'url')).trim())}](${url})` });
        continue;
      }
      const link = own(b, 'link');
      if (isObj(link)) {
        const target = str(own(link, 'targetBlockId'));
        const nl = noteLink(target, '', 'md');
        if (nl) chunks.push({ text: nl });
        else if (fileObjects.has(target)) {
          const key = await fileKey(target);
          if (key) chunks.push({ text: `[${escapeMarkdownText(fileName(target))}](${key})` });
          else {
            counts.missingFiles++;
            chunks.push({ text: missingFileMarker(fileName(target)) });
          }
        } else {
          const other = byId.get(target);
          const name = other ? str(own(other.details, 'name')).trim() : '';
          if (name) chunks.push({ text: escapeMarkdownText(name) });
          else counts.missingLinks++;
        }
        continue;
      }
      const fileBlock = own(b, 'file');
      if (isObj(fileBlock)) {
        const target = str(own(fileBlock, 'targetObjectId'));
        if (!target) {
          if (str(own(fileBlock, 'name'))) {
            counts.missingFiles++;
            chunks.push({ text: missingFileMarker(str(own(fileBlock, 'name'))) });
          }
          continue;
        }
        const name = fileName(target) || str(own(fileBlock, 'name'));
        const key = await fileKey(target);
        if (!key) {
          counts.missingFiles++;
          chunks.push({ text: missingFileMarker(name) });
          continue;
        }
        const image = enumName(own(fileBlock, 'type'), FILE_TYPES, 'File') === 'Image';
        const label = name.replace(/[[\]]/g, '');
        chunks.push({ text: image ? `![${label}](${key})` : `[${label}](${key})` });
        continue;
      }
      if (isObj(own(b, 'featuredRelations'))) continue;
      // Table of contents, a property block, an inline set or collection view, a widget.
      counts.droppedBlocks++;
      if (kids.length) chunks.push(...(await children()));
    }
    return chunks;
  };

  /** A custom property value as text, or '' when it holds nothing. */
  const propertyValue = async (format: number, value: unknown): Promise<string> => {
    if (format === FMT_NUMBER) {
      const n = num(value);
      return n === null ? '' : String(n);
    }
    if (format === FMT_DATE) {
      const iso = isoFromSeconds(value, nowMs);
      if (!iso) return '';
      return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
    }
    if (format === FMT_STATUS || format === FMT_TAG) {
      return strList(value).map((id) => options.get(id) ?? '').filter(Boolean).map(escapeMarkdownText).join(', ');
    }
    if (format === FMT_OBJECT || format === FMT_FILE) {
      const parts: string[] = [];
      for (const id of strList(value)) {
        const nl = noteLink(id, '', 'md');
        if (nl) parts.push(nl);
        else if (fileObjects.has(id)) {
          const key = await fileKey(id);
          if (key) parts.push(`[${escapeMarkdownText(fileName(id))}](${key})`);
          else {
            counts.missingFiles++;
            parts.push(missingFileMarker(fileName(id)));
          }
        } else {
          const name = str(own(byId.get(id)?.details, 'name')).trim();
          if (name) parts.push(escapeMarkdownText(name));
        }
      }
      return parts.join(', ');
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) return strList(value).map((v) => escapeMarkdownText(v.replace(/\s+/g, ' ').trim())).filter(Boolean).join(', ');
    return escapeMarkdownText(str(value).replace(/\s+/g, ' ').trim());
  };

  // Collections become folders; a page in several goes into the first.
  onProgress?.(i18n.t('importLog:shared.buildingNotes'));
  collections.sort((a, b) => str(own(a.details, 'name')).localeCompare(str(own(b.details, 'name'))) || a.id.localeCompare(b.id));
  const pageIds = new Set(pages.map((p) => p.id));
  const memberOf = new Map<string, string>();
  let multiCollection = 0;
  const counted = new Set<string>();
  for (const c of collections) {
    if (own(c.details, 'isArchived') === true) continue;
    for (const id of c.collection) {
      if (!pageIds.has(id)) continue;
      if (!memberOf.has(id)) memberOf.set(id, c.id);
      else if (memberOf.get(id) !== c.id && !counted.has(id)) {
        counted.add(id);
        multiCollection++;
      }
    }
  }
  let folderDefs: FolderDef[] = [];
  const folderOf = new Map<string, { id: string; name: string }>();
  let droppedFolders = 0;
  for (const c of collections) {
    if (![...memberOf.values()].includes(c.id)) continue;
    const name = str(own(c.details, 'name')).replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const res = folderDefs.length < IMPORT_FOLDER_LIMIT ? createFolder(folderDefs, name, null) : null;
    if (!res) {
      droppedFolders++;
      continue;
    }
    folderDefs = res.folders;
    folderOf.set(c.id, { id: res.created.id, name: res.created.name });
  }

  const notes: ImportedNote[] = [];
  let starred = 0;
  let binned = 0;
  let linkified = 0;
  let empty = 0;
  let untagged = 0;
  let tagged = 0;
  const fileTime = file.lastModified && file.lastModified <= nowMs ? new Date(file.lastModified).toISOString() : new Date(nowMs).toISOString();

  for (const o of pages) {
    const d = o.details;
    const layout = layoutOf(o);
    const title = titles.get(o.id) ?? '';
    const top: string[] = [];
    const isTask = layout === LAYOUT_TODO || typeKey(o) === 'ot-task';
    if (isTask) {
      counts.tasks++;
      top.push(`- [${own(d, 'done') === true ? 'x' : ' '}] ${escapeMarkdownText(title)}`.trimEnd());
    }
    if (layout === LAYOUT_BOOKMARK) {
      const url = safeUrl(str(own(d, 'source')), 'md');
      if (url) top.push(`[${escapeMarkdownText(title || str(own(d, 'source')))}](${url})`);
    }
    const props: string[] = [];
    for (const key of Object.keys(d)) {
      if (!CUSTOM_KEY.test(key)) continue;
      const rel = relations.get(key);
      if (!rel) continue;
      const label = escapeMarkdownText(rel.name.replace(/\s+/g, ' ').trim() || key);
      if (rel.format === FMT_CHECKBOX) {
        if (typeof d[key] === 'boolean') props.push(`- [${d[key] ? 'x' : ' '}] ${label}`);
        continue;
      }
      const value = await propertyValue(rel.format, d[key]);
      if (value) props.push(`- ${label}: ${value}`);
    }
    if (props.length) {
      counts.properties++;
      top.push(props.join('\n'));
    }
    const description = str(own(d, 'description')).trim();
    if (description) top.push(description.split('\n').map((l) => guardMarkdownLineStart(escapeMarkdownText(l)) || '&nbsp;').join('\\\n'));

    const root = o.blocks.get(o.id);
    const chunks = root ? await renderBlocks(strList(own(root, 'childrenIds')), o, new Set([o.id]), 0) : [];
    // An empty paragraph at the very end is the cursor line every page has.
    while (chunks.length && chunks[chunks.length - 1]!.text === '&nbsp;') chunks.pop();
    let body = joinChunks([...top.map((t) => ({ text: t })), ...chunks]);

    // File links a mention named, now that their bytes can be read.
    for (const [token, { id, label }] of pendingFiles) {
      if (!body.includes(token)) continue;
      const key = await fileKey(id);
      const text = escapeMarkdownText(label.replace(/[[\]]/g, ''));
      body = body.split(token).join(key ? `[${text}](${key})` : text);
      if (!key) counts.missingFiles++;
    }
    pendingFiles.clear();

    body = detailsToFold(body);
    const linked = linkifyMarkdown(body);
    if (linked !== body) linkified++;

    if (str(own(d, 'iconEmoji')) || str(own(d, 'iconImage'))) counts.icons++;
    if (str(own(d, 'coverId')) || (num(own(d, 'coverType')) ?? 0) > 0) counts.covers++;

    const seen = new Set<string>();
    const tags = strList(own(d, 'tag'))
      .map((id) => normalizeTag(options.get(id) ?? ''))
      .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
    if (tags.length) tagged++;
    else untagged++;
    if (!linked.trim()) empty++;

    const createdAt = isoFromSeconds(own(d, 'createdDate'), nowMs) ?? fileTime;
    const updatedAt = isoFromSeconds(own(d, 'lastModifiedDate'), nowMs) ?? createdAt;
    // Anytype's isArchived is its Bin: the page was moved to the bin.
    const inBin = own(d, 'isArchived') === true;
    const isStarred = own(d, 'isFavorite') === true;
    if (inBin) binned++;
    if (isStarred) starred++;
    const folder = folderOf.get(memberOf.get(o.id) ?? '');
    notes.push({
      title,
      body: linked,
      tags,
      createdAt,
      updatedAt,
      ...(inBin ? { trashed: true } : {}),
      ...(isStarred ? { starred: true } : {}),
      ...(isTask ? { type: 'task' as const } : {}),
      ...(folder ? { folderId: folder.id, folderPath: [folder.name] } : {}),
    });
  }

  for (const [key] of [...blobs]) {
    if (!notes.some((n) => isBlobReferenced(key, n.body))) blobs.delete(key);
  }

  const transforms: string[] = [];
  const warnings: string[] = [];
  const t = (key: string, count: number) => {
    if (count > 0) transforms.push(msg(key, { count }));
  };
  const w = (key: string, count: number) => {
    if (count > 0) warnings.push(msg(key, { count }));
  };
  if (folderDefs.length) transforms.push(msg('collections', { count: folderDefs.length }));
  if (counts.noteLinks) transforms.push(i18n.t('importLog:shared.noteLinks', { count: counts.noteLinks }));
  if (blobs.size) transforms.push(i18n.t('importLog:shared.attachments', { count: blobs.size }));
  if (counts.checklists) transforms.push(i18n.t('importLog:shared.checklists', { count: counts.checklists }));
  if (counts.tables) transforms.push(i18n.t('importLog:shared.tables', { count: counts.tables }));
  if (counts.codeBlocks) transforms.push(i18n.t('importLog:shared.codeBlocks', { count: counts.codeBlocks }));
  if (counts.math) transforms.push(i18n.t('importLog:shared.math', { count: counts.math }));
  t('mermaid', counts.mermaid);
  t('callouts', counts.callouts);
  t('toggles', counts.folds);
  t('embeds', counts.embeds);
  t('tasks', counts.tasks);
  t('properties', counts.properties);
  if (counts.colors) transforms.push(msg('colors'));
  if (counts.aligned) transforms.push(i18n.t('importLog:shared.aligned'));
  if (tagged) transforms.push(i18n.t('importLog:shared.tags', { count: tagged }));
  if (starred) transforms.push(i18n.t('importLog:shared.keptStarred', { count: starred }));
  if (binned) transforms.push(i18n.t('importLog:shared.restoredTrashed', { count: binned }));
  if (linkified) transforms.push(i18n.t('importLog:shared.linkifiedNotes', { count: linkified }));
  if (counts.tooLarge) warnings.push(mediaTooLargeWarning(counts.tooLarge));
  w('missingFiles', counts.missingFiles);
  w('missingLinks', counts.missingLinks);
  w('severalCollections', multiCollection);
  w('droppedFolders', droppedFolders);
  w('sets', sets);
  w('templates', templates);
  w('droppedBlocks', counts.droppedBlocks);
  w('icons', counts.icons);
  w('covers', counts.covers);
  w('droppedColors', counts.droppedColors);
  if (counts.droppedAlign) warnings.push(i18n.t('importLog:shared.droppedAlign'));
  w('damaged', damaged);

  const parsed: ParsedImport = {
    notes,
    warnings,
    transforms,
    stats: {
      totalNotes: notes.length,
      emptyNotes: empty,
      untaggedNotes: untagged,
      uniqueTags: new Set(notes.flatMap((n) => n.tags)).size,
    },
    source: 'anytype',
  };
  if (folderDefs.length) parsed.folders = folderDefs;
  if (blobs.size) {
    parsed.blobs = blobs;
    parsed.blobBytes = [...blobs.values()].reduce((sum, b) => sum + b.data.length, 0);
  }
  return parsed;
}

function fileObjectOf(d: Json, root: string): FileObject {
  const base = str(own(d, 'name')).replace(/[\\/]/g, '-').trim();
  const ext = str(own(d, 'fileExt')).replace(/[^\w]/g, '');
  const name = base && ext && !base.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${base}.${ext}` : base || (ext ? `file.${ext}` : 'file');
  const source = normPath(str(own(d, 'source')));
  return { name, mime: str(own(d, 'fileMimeType')), path: source ? normPath(`${root}${source}`) : '' };
}

/* ------------------------------------------------------------------ */
/* The Markdown export                                                 */
/* ------------------------------------------------------------------ */

/** Front matter keys Anytype writes about the object itself, not its content. */
const MD_SYSTEM_KEYS = new Set(['Object type', 'Backlinks', 'Links', 'Created by', 'Last modified by', 'Last opened date', 'id', 'Creation date', 'Last modified date', 'Tag', 'Done', 'Cover image or color', 'Description', 'Name', 'Emoji', 'Image', 'Source']);

interface FrontMatter {
  values: Map<string, string[]>;
  body: string;
}

function unquoteYaml(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // YAML's \U and \u escapes, which JSON does not have in that form.
    const yaml = s.replace(/\\U([0-9a-fA-F]{8})|\\u([0-9a-fA-F]{4})/g, (whole, long: string | undefined, short: string | undefined) => {
      const cp = parseInt(long ?? short ?? '', 16);
      return cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
    });
    if (yaml !== s) return yaml.slice(1, -1);
    try {
      const parsed: unknown = JSON.parse(s);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* not JSON-shaped: strip the quotes only */
    }
    return s.slice(1, -1);
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** The YAML Anytype writes: `Key: value`, or `Key:` and a list of `- item` lines. */
function splitFrontMatter(text: string): FrontMatter {
  const values = new Map<string, string[]>();
  const t = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return { values, body: t };
  const end = t.indexOf('\n---\n', 3);
  const endAtEof = end < 0 && t.endsWith('\n---') ? t.length - 4 : -1;
  const stop = end >= 0 ? end : endAtEof;
  if (stop < 0) return { values, body: t };
  let key = '';
  for (const line of t.slice(4, stop).split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const item = /^\s+-\s?(.*)$/.exec(line);
    if (item && key) {
      values.get(key)!.push(unquoteYaml(item[1]!));
      continue;
    }
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1]!.trim();
    values.set(key, kv[2]!.trim() ? [unquoteYaml(kv[2]!)] : []);
  }
  return { values, body: t.slice(stop + 5) };
}

/**
 * Anytype ends every block with three spaces and puts no blank line between
 * blocks, so a run of them reads as one paragraph with hard breaks. Each
 * block end becomes a blank line, except between the items of one list and
 * the rows of one table. A child block it indents by four spaces under a
 * block that is not a list item would read as code, so it is outdented.
 */
function anytypeBlocks(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let underList = false;
  const isList = (l: string) => /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/.test(l);
  const isTable = (l: string) => /^\s*\|/.test(l);
  for (const rawLine of body.split('\n')) {
    let line = rawLine;
    // Code and a $$ block are copied as they stand; Anytype writes a Mermaid diagram as $$ too.
    const f = /^\s*(`{3,}|~{3,}|\$\$)\s*$/.exec(line)?.[1] ?? /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (f && f[0] === fence[0] && f.length >= fence.length) {
        fence = null;
        out.push('');
      }
      continue;
    }
    if (f) {
      fence = f;
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(line.trim());
      continue;
    }
    if (/^\S/.test(line)) underList = isList(line);
    else if (line.trim() && !underList && !isList(line)) line = line.trimStart();
    const blockEnd = / {3}$/.test(line) || /^\s*---\s*$/.test(line) || /^\s*<\/details>\s*$/.test(line);
    line = line.replace(/\s+$/, '');
    if (/^\s*---$/.test(line)) {
      line = '---';
      if (out.length && out[out.length - 1] !== '') out.push('');
    }
    if (isTable(line)) line = line.replace(/\s*<br>\s*\|/g, ' |');
    out.push(line);
    if (blockEnd) out.push('');
  }
  // Keep list items and table rows together: drop a blank line between two of them.
  const joined: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const l = out[i]!;
    if (l === '' && i > 0 && i < out.length - 1) {
      const prev = out[i - 1]!;
      const next = out[i + 1]!;
      if ((isList(prev) || /^\s+\S/.test(prev)) && (isList(next) || (/^\s+\S/.test(next) && !isTable(next)))) continue;
      if (isTable(prev) && isTable(next)) continue;
    }
    if (l === '' && joined[joined.length - 1] === '') continue;
    joined.push(l);
  }
  return joined.join('\n').trim();
}

async function parseAnytypeMarkdown(entries: Map<string, JSZip.JSZipObject>, file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  const nowMs = Date.now();
  const fileTime = file.lastModified && file.lastModified <= nowMs ? new Date(file.lastModified).toISOString() : new Date(nowMs).toISOString();
  const mdPaths = [...entries.keys()].filter((p) => /\.md$/i.test(p) && !p.startsWith('schemas/')).sort();
  if (mdPaths.length === 0) throw new Error(msg('noPages'));

  onProgress?.(msg('readingObjects'));
  const parsedFiles: { path: string; fm: FrontMatter; title: string; body: string }[] = [];
  for (const path of mdPaths) {
    const fm = splitFrontMatter(await zipEntryText(entries.get(path)!));
    let body = fm.body;
    let title = '';
    const head = /^#[ \t]*([^\n]*)\n?/.exec(body);
    if (head) {
      title = head[1]!.trim();
      body = body.slice(head[0].length);
    }
    if (!title) title = body.split('\n').map((l) => l.trim()).find(Boolean)?.replace(/^#+\s*/, '').slice(0, 200) ?? '';
    parsedFiles.push({ path, fm, title, body });
  }
  const titleOf = new Map(parsedFiles.map((p) => [p.path, p.title]));

  onProgress?.(i18n.t('importLog:shared.buildingNotes'));
  const counts = newCounts();
  const blobs = new Map<string, ImportBlob>();
  const notes: ImportedNote[] = [];
  let linkified = 0;
  let tagged = 0;

  for (const p of parsedFiles) {
    const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/') + 1) : '';
    let body = anytypeBlocks(p.body);
    // Link targets: backslashes from a Windows export, then .md links to note-links.
    body = body.replace(/(!?)\[([^\]\n]{0,500})\]\(([^)\s]{1,1000})\)/g, (whole, bang: string, label: string, rawTarget: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) return !bang && !label.trim() ? `[${rawTarget}](${rawTarget})` : whole;
      let target = rawTarget;
      try {
        target = decodeURI(rawTarget);
      } catch {
        /* a literal % in a name */
      }
      const path = normPath(`${dir}${target}`);
      if (/\.md$/i.test(path) && !bang) {
        const title = titleOf.get(path);
        if (title === undefined) {
          counts.missingLinks++;
          return label;
        }
        const t = noteLinkTarget(title);
        const clean = label.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
        counts.noteLinks++;
        return !clean || clean === t ? `[[${t}]]` : `[[${t}|${clean}]]`;
      }
      if (entries.has(path) && !/\.md$/i.test(path)) return `${bang}[${label}](${path})`;
      if (path.startsWith('files/') || /\\/.test(rawTarget)) {
        counts.missingFiles++;
        return `\`[file: ${(path.split('/').pop() ?? path).replace(/`/g, "'")} - not in the Anytype export]\``;
      }
      return whole;
    });
    body = detailsToFold(body);

    const v = p.fm.values;
    const first = (k: string) => v.get(k)?.[0] ?? '';
    const top: string[] = [];
    const types = v.get('Object type') ?? [];
    const done = first('Done');
    const isTask = types.includes('Task') || done !== '';
    if (isTask) {
      counts.tasks++;
      top.push(`- [${done === 'true' ? 'x' : ' '}] ${escapeMarkdownText(p.title)}`.trimEnd());
    }
    const props: string[] = [];
    for (const [k, vals] of v) {
      if (MD_SYSTEM_KEYS.has(k)) continue;
      const value = vals.map((x) => escapeMarkdownText(x.replace(/\s+/g, ' ').trim())).filter(Boolean).join(', ');
      if (value) props.push(`- ${escapeMarkdownText(k)}: ${value}`);
    }
    if (props.length) {
      counts.properties++;
      top.push(props.join('\n'));
    }
    const description = first('Description').trim();
    if (description) top.push(guardMarkdownLineStart(escapeMarkdownText(description)));
    if (first('Cover image or color')) counts.covers++;
    if (first('Emoji') || first('Image')) counts.icons++;
    const source = safeUrl(first('Source').replace(/^<(.*)>$/, '$1'), 'md');
    if (source) top.unshift(`[${escapeMarkdownText(p.title || first('Source'))}](${source})`);
    body = [...top, body].filter(Boolean).join('\n\n');

    const linked = linkifyMarkdown(body);
    if (linked !== body) linkified++;
    const seen = new Set<string>();
    const tags = (v.get('Tag') ?? []).map((x) => normalizeTag(x)).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
    if (tags.length) tagged++;
    const createdAt = parseFrontMatterDate(first('Creation date')) ?? fileTime;
    notes.push({
      title: p.title,
      body: linked,
      tags,
      createdAt,
      updatedAt: parseFrontMatterDate(first('Last modified date')) ?? createdAt,
      ...(isTask ? { type: 'task' as const } : {}),
    });
  }

  // Only the files a note links to.
  for (const [path, entry] of entries) {
    if (/\.md$/i.test(path) || path.startsWith('schemas/')) continue;
    if (!notes.some((n) => isBlobReferenced(path, n.body))) continue;
    const data = await zipEntryMedia(entry);
    if (!data) {
      counts.tooLarge++;
      continue;
    }
    const name = path.split('/').pop() ?? path;
    blobs.set(path, { data: new Uint8Array(data), mime: mimeFromExt(name), name });
  }

  const transforms: string[] = [];
  const warnings: string[] = [msg('markdownExport')];
  if (counts.noteLinks) transforms.push(i18n.t('importLog:shared.noteLinks', { count: counts.noteLinks }));
  if (blobs.size) transforms.push(i18n.t('importLog:shared.attachments', { count: blobs.size }));
  if (counts.tasks) transforms.push(msg('tasks', { count: counts.tasks }));
  if (counts.properties) transforms.push(msg('properties', { count: counts.properties }));
  if (tagged) transforms.push(i18n.t('importLog:shared.tags', { count: tagged }));
  if (linkified) transforms.push(i18n.t('importLog:shared.linkifiedNotes', { count: linkified }));
  if (counts.tooLarge) warnings.push(mediaTooLargeWarning(counts.tooLarge));
  if (counts.missingFiles) warnings.push(msg('missingFiles', { count: counts.missingFiles }));
  if (counts.missingLinks) warnings.push(msg('missingLinks', { count: counts.missingLinks }));
  if (counts.covers) warnings.push(msg('covers', { count: counts.covers }));
  if (counts.icons) warnings.push(msg('icons', { count: counts.icons }));

  const parsed: ParsedImport = {
    notes,
    warnings,
    transforms,
    stats: {
      totalNotes: notes.length,
      emptyNotes: notes.filter((n) => !n.title.trim() && !n.body.trim()).length,
      untaggedNotes: notes.filter((n) => n.tags.length === 0).length,
      uniqueTags: new Set(notes.flatMap((n) => n.tags)).size,
    },
    source: 'anytype',
  };
  if (blobs.size) {
    parsed.blobs = blobs;
    parsed.blobBytes = [...blobs.values()].reduce((sum, b) => sum + b.data.length, 0);
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function parseAnytype(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(i18n.t('importLog:shared.readingZip'));
  let zip: JSZip;
  try {
    zip = await openZip(file);
  } catch {
    throw new Error(msg('notAnytype'));
  }
  // Normalized path -> entry. A Windows export writes backslashes.
  const zipEntries = new Map<string, JSZip.JSZipObject>();
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const path = normPath(entry.name);
    if (path && !path.startsWith('__MACOSX/') && !zipEntries.has(path)) zipEntries.set(path, entry);
  }
  const entries = new Map(zipEntries);
  // One folder around everything (a zipped export folder) is not part of the layout.
  const keys = [...entries.keys()];
  const first = keys[0] ?? '';
  const wrap = first.includes('/') ? first.slice(0, first.indexOf('/') + 1) : '';
  if (wrap && !/^(?:objects|types|relations|relationsOptions|templates|filesObjects|files|schemas|spaces)\/$/.test(wrap) && keys.every((p) => p.startsWith(wrap))) {
    entries.clear();
    for (const p of keys) entries.set(p.slice(wrap.length), zipEntries.get(p)!);
  }

  if (entries.size === 0) throw new Error(i18n.t('importLog:shared.zipEmpty'));
  const paths = [...entries.keys()];
  if (paths.some((p) => /(?:^|\/)objects\/[^/]+\.pb\.json$/.test(p))) return parseAnyBlock(entries, file, onProgress);
  if (paths.some((p) => /(?:^|\/)(?:objects|types|relations)\/[^/]+\.pb$/.test(p))) throw new Error(msg('binaryExport'));
  if (paths.some((p) => /^schemas\/[^/]+\.schema\.json$/.test(p))) return parseAnytypeMarkdown(entries, file, onProgress);
  // A Markdown export without schemas still names one in every front matter.
  for (const p of paths.filter((x) => /\.md$/i.test(x)).slice(0, 5)) {
    const head = (await zipEntryText(entries.get(p)!, 64 * 1024 * 1024)).slice(0, 400);
    if (/^---\r?\n# yaml-language-server: \$schema=schemas[\\/]/.test(head)) return parseAnytypeMarkdown(entries, file, onProgress);
  }
  throw new Error(msg('notAnytype'));
}
