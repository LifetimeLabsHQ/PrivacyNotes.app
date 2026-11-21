/**
 * Turns the object graph of OneNote revision store files into a neutral tree
 * of sections, pages and blocks, with no Markdown in it yet.
 *
 * Format facts are from [MS-ONE] (OneNote File Format); the section of each
 * structure is named where it is read. A section file's root object space
 * holds a jcidSectionNode, whose page series name the object spaces of their
 * pages (ChildGraphSpaceElementNodes). A page object space has a page
 * manifest (content root) and page metadata (metadata root: cached title,
 * page level, creation time). The page holds a title and outlines; an
 * outline holds outline elements, nested by their own child lists; an
 * outline element holds one content node: rich text, a table, an image or an
 * embedded file, plus its list marker and note tags.
 *
 * A `.onepkg` is a cabinet of a notebook folder: one `.one` per section,
 * section groups as subfolders, the table of contents `.onetoc2`, and the
 * notebook's recycle bin as `OneNote_RecycleBin/`. Sections come back in the
 * order the cabinet lists them, each with its folder path.
 */

import { readCab, isCabinet, OneNoteError, type CabFile, type OneNoteErrorCode } from './oneNoteCab';
import { exKey, fileDataGuid, readGuid, readRevisionStore, type ExGuid, type ObjectSpace, type OneObject, type PropSet, type PropValue, type RevisionStore } from './oneNoteStore';

// ---------------------------------------------------------------------------
// The neutral tree
// ---------------------------------------------------------------------------

export interface OneNoteRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  superscript: boolean;
  subscript: boolean;
  /** `#rrggbb`, or null for the automatic color. */
  color: string | null;
  highlight: string | null;
  link: string | null;
  math: boolean;
  /** The font name when the run or its paragraph style sets one. */
  font: string | null;
  /** The font size in points when set. */
  fontSize: number | null;
}

interface OneNoteTag {
  /** NoteTagShape ([MS-ONE] 2.3.86). */
  shape: number;
  checkable: boolean;
  done: boolean;
  label: string | null;
}

interface OneNoteList {
  ordered: boolean;
  /** The raw NumberListFormat without its length character. */
  format: string;
  restart: number | null;
}

interface BlockBase {
  /** Outline depth, 0 for a top-level outline element. */
  indent: number;
  tags: OneNoteTag[];
  list: OneNoteList | null;
}

export interface OneNoteParagraph extends BlockBase {
  type: 'paragraph';
  runs: OneNoteRun[];
  /** ParagraphStyleId ([MS-ONE] 2.2.83): `p`, `h1`..`h6`, `PageTitle`, `cite`, `code`, ... */
  style: string | null;
  /** ParagraphAlignment, else the node's own layout alignment ([MS-ONE] 2.3.94, 2.3.2). */
  alignment: 'left' | 'center' | 'right';
  /** ReadingOrderRTL ([MS-ONE] 2.3.93). */
  rtl: boolean;
}

interface OneNoteTable extends BlockBase {
  type: 'table';
  /** Rows of cells; each cell is its own list of blocks. */
  rows: OneNoteBlock[][][];
  bordersVisible: boolean;
}

interface OneNoteImage extends BlockBase {
  type: 'image';
  fileId: string | null;
  alt: string | null;
  name: string | null;
  /** Display size in points (LayoutMaxWidth and LayoutMaxHeight, half-inches times 36), as OneNote's own XML gives it. */
  width: number | null;
  height: number | null;
  /** IsLayoutSizeSetByUser: the person resized the picture. */
  sizeSetByUser: boolean;
  link: string | null;
}

interface OneNoteEmbeddedFile extends BlockBase {
  type: 'file';
  fileId: string | null;
  name: string;
}

export type OneNoteBlock = OneNoteParagraph | OneNoteTable | OneNoteImage | OneNoteEmbeddedFile;

export interface OneNotePage {
  /**
   * The page id OneNote puts in a page link (`onenote:...&page-id={...}`):
   * NotebookManagementEntityGuid on the page metadata ([MS-ONE] 2.2.58), as
   * `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`. Checked against the links of the
   * lab export of 2026-11-19.
   */
  id: string | null;
  /** The title text, else OneNote's cached name for the page (its first line when the title is empty). */
  title: string;
  /** True when the page's own title is empty and `title` is only the cached name. */
  untitled: boolean;
  /** PageLevel: 1 for a page, 2 and 3 for subpages ([MS-ONE] 2.3.74). */
  level: number;
  /** Milliseconds since the epoch, or null when the file does not say. */
  createdAt: number | null;
  updatedAt: number | null;
  /** IsDeletedGraphSpaceContent on the page metadata. */
  deleted: boolean;
  blocks: OneNoteBlock[];
}

interface OneNoteSection {
  /** The section id OneNote puts in a link (`section-id={...}`): the section file's Header.guidFile, braced and uppercase. */
  id: string;
  name: string;
  /** Section group folders from the package root down, never containing `..`. */
  folders: string[];
  /** True for a section in the notebook's recycle bin. */
  recycled: boolean;
  pages: OneNotePage[];
}

interface OneNoteFile {
  name: string;
  /** The extension the file data object declares, with its dot, lowercase. */
  ext: string;
  bytes: Uint8Array;
}

interface OneNoteSkipped {
  name: string;
  folders: string[];
  /** `encrypted` for a password-protected section, else the read error. */
  reason: 'encrypted' | OneNoteErrorCode;
}

export interface OneNoteNotebook {
  sections: OneNoteSection[];
  /** Embedded files and pictures by file id (the FileDataStoreObject GUID). */
  files: Map<string, OneNoteFile>;
  skipped: OneNoteSkipped[];
  /** Content nodes of a type this reader does not map (ink, audio, math objects), by JCID. */
  unsupported: Map<number, number>;
  /** Pictures and files whose bytes are not in the package. */
  missingFiles: number;
}

// ---------------------------------------------------------------------------
// Property IDs and JCIDs ([MS-ONE] 2.1.12, 2.1.13), as PropertyID.id
// ---------------------------------------------------------------------------

const P = {
  OutlineElementChildLevel: 0x1c03,
  Bold: 0x1c04,
  Italic: 0x1c05,
  Underline: 0x1c06,
  Strikethrough: 0x1c07,
  Superscript: 0x1c08,
  Subscript: 0x1c09,
  Font: 0x1c0a,
  FontSize: 0x1c0b,
  FontColor: 0x1c0c,
  Highlight: 0x1c0d,
  OffsetFromParentHoriz: 0x1c14,
  OffsetFromParentVert: 0x1c15,
  NumberListFormat: 0x1c1a,
  LayoutMaxWidth: 0x1c1b,
  LayoutMaxHeight: 0x1c1c,
  ContentChildNodes: 0x1c1f,
  ElementChildNodes: 0x1c20,
  RichEditTextUnicode: 0x1c22,
  ListNodes: 0x1c26,
  PictureContainer: 0x1c3f,
  TopologyCreationTimeStamp: 0x1c65,
  IsTitleTime: 0x1c87,
  IsTitleText: 0x1cb4,
  IsTitleDate: 0x1cb5,
  ListRestart: 0x1cb7,
  IsLayoutSizeSetByUser: 0x1cbd,
  LayoutAlignmentInParent: 0x1c3e,
  LayoutAlignmentSelf: 0x1c84,
  NotebookManagementEntityGuid: 0x1c30,
  CachedTitleString: 0x1cf3,
  CachedTitleStringFromPage: 0x1d3c,
  TableBordersVisible: 0x1d5e,
  StructureElementChildNodes: 0x1d5f,
  ChildGraphSpaceElementNodes: 0x1d63,
  LastModifiedTime: 0x1d7a,
  EmbeddedFileContainer: 0x1d9b,
  EmbeddedFileName: 0x1d9c,
  ImageFilename: 0x1dd7,
  IsDeletedGraphSpaceContent: 0x1de9,
  PageLevel: 0x1dff,
  TextRunIndex: 0x1e12,
  TextRunFormatting: 0x1e13,
  Hyperlink: 0x1e14,
  Hidden: 0x1e16,
  HyperlinkProtected: 0x1e19,
  WzHyperlinkUrl: 0x1e20,
  ImageAltText: 0x1e58,
  MathFormatting: 0x3401,
  ParagraphStyle: 0x342c,
  ParagraphStyleId: 0x345a,
  ReadingOrderRTL: 0x3476,
  ParagraphAlignment: 0x3477,
  NoteTagShape: 0x3464,
  NoteTagLabel: 0x3468,
  ActionItemStatus: 0x3470,
  NoteTagDefinitionOid: 0x3488,
  NoteTagStates: 0x3489,
  TextExtendedAscii: 0x3498,
  SectionDisplayName: 0x349b,
} as const;

const J = {
  SectionNode: 0x00060007,
  PageSeriesNode: 0x00060008,
  PageNode: 0x0006000b,
  OutlineNode: 0x0006000c,
  OutlineElementNode: 0x0006000d,
  RichTextOENode: 0x0006000e,
  ImageNode: 0x00060011,
  NumberListNode: 0x00060012,
  OutlineGroup: 0x00060019,
  TableNode: 0x00060022,
  TableRowNode: 0x00060023,
  TableCellNode: 0x00060024,
  TitleNode: 0x0006002c,
  EmbeddedFileNode: 0x00060035,
  PageManifestNode: 0x00060037,
} as const;

/** NoteTagShape values whose icon is a check box ([MS-ONE] 2.3.86). */
const CHECKABLE_SHAPES = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 28, 30, 32, 48, 50, 52, 69, 71, 73, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

const ROLE_CONTENT = 1;
const ROLE_METADATA = 2;

/** Limits on a stranger's graph: no real page nests this deep or holds this many blocks. */
const DEPTH_LIMIT = 64;
const BLOCK_LIMIT = 200_000;

// ---------------------------------------------------------------------------
// Property helpers
// ---------------------------------------------------------------------------

function prop(set: PropSet | null, id: number): PropValue | undefined {
  return set ? set.get(id) : undefined;
}

function bool(set: PropSet | null, id: number): boolean {
  const v = prop(set, id);
  return v?.kind === 'bool' ? v.v : false;
}

function uint(set: PropSet | null, id: number): number | null {
  const v = prop(set, id);
  return v?.kind === 'uint' ? v.v : null;
}

function float(set: PropSet | null, id: number): number | null {
  const v = prop(set, id);
  if (v?.kind !== 'uint' || v.size !== 4) return null;
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, v.v, true);
  const f = view.getFloat32(0, true);
  return Number.isFinite(f) ? f : null;
}

function bytes(set: PropSet | null, id: number): Uint8Array | null {
  const v = prop(set, id);
  return v?.kind === 'bytes' ? v.v : null;
}

const UTF16 = new TextDecoder('utf-16le');
const ANSI = new TextDecoder('windows-1252');

/** WzInAtom ([MS-ONE] 2.2.9): UTF-16LE, null-terminated. */
function wz(set: PropSet | null, id: number): string | null {
  const b = bytes(set, id);
  if (!b) return null;
  return UTF16.decode(b.length % 2 ? b.subarray(0, b.length - 1) : b).replace(/\0+$/, '');
}

function oids(set: PropSet | null, id: number): string[] {
  const v = prop(set, id);
  if (v?.kind === 'oids') return v.v.filter((x): x is ExGuid => x !== null).map(exKey);
  if (v?.kind === 'oid' && v.v) return [exKey(v.v)];
  return [];
}

function osids(set: PropSet | null, id: number): string[] {
  const v = prop(set, id);
  if (v?.kind === 'osids') return v.v.filter((x): x is ExGuid => x !== null).map(exKey);
  if (v?.kind === 'osid' && v.v) return [exKey(v.v)];
  return [];
}

function uint32s(b: Uint8Array | null): number[] {
  if (!b) return [];
  const out: number[] = [];
  for (let i = 0; i + 4 <= b.length; i += 4) out.push((b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0);
  return out;
}

/** COLORREF ([MS-ONE] 2.2.8): 0x00bbggrr, or 0xFF000000 for automatic. */
function colorRef(set: PropSet | null, id: number): string | null {
  const v = uint(set, id);
  if (v === null || v >>> 24 !== 0) return null;
  const r = v & 0xff;
  const g = (v >>> 8) & 0xff;
  const b = (v >>> 16) & 0xff;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** A GUID the way OneNote writes it in a link: braced and uppercase. */
function bracedGuid(guid: string): string {
  return `{${guid.toUpperCase()}}`;
}

/** Half-inch units ([MS-ONE] 2.3.21) to points, rounded to a hundredth. */
function points(halfInches: number | null): number | null {
  return halfInches === null || halfInches <= 0 ? null : Math.round(halfInches * 3600) / 100;
}

/** Time32 ([MS-ONE] 2.3.1): seconds since 1980-01-01 UTC. */
function time32(set: PropSet | null, id: number): number | null {
  const v = uint(set, id);
  if (v === null || v === 0) return null;
  return (315532800 + v) * 1000;
}

/** FILETIME: 100-nanosecond intervals since 1601-01-01 UTC. */
function fileTime(set: PropSet | null, id: number): number | null {
  const v = prop(set, id);
  if (v?.kind !== 'u64') return null;
  const ms = (v.hi * 0x100000000 + v.lo) / 10000 - 11644473600000;
  return ms > 0 && ms < 8.64e15 ? Math.round(ms) : null;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

interface Ctx {
  space: ObjectSpace;
  store: RevisionStore;
  book: OneNoteNotebook;
  blocks: number;
  /** Tag definitions of the page in order of first use, which is how OneNote orders the tags of one paragraph. */
  tagOrder: Map<string, number>;
}

function obj(ctx: Ctx, key: string): OneObject | undefined {
  return ctx.space.objects.get(key);
}

function readRuns(ctx: Ctx, node: PropSet): OneNoteRun[] {
  let text = wz(node, P.RichEditTextUnicode);
  if (text === null) {
    const ascii = bytes(node, P.TextExtendedAscii);
    text = ascii ? ANSI.decode(ascii).replace(/\0+$/, '') : '';
  }
  const paraStyle = oids(node, P.ParagraphStyle)[0];
  const base = paraStyle ? (obj(ctx, paraStyle)?.props ?? null) : null;
  const ends = uint32s(bytes(node, P.TextRunIndex));
  const formats = oids(node, P.TextRunFormatting);
  const raw: { text: string; set: PropSet | null }[] = [];
  let start = 0;
  const count = Math.max(1, ends.length + 1);
  for (let i = 0; i < count; i++) {
    const end = i < ends.length ? Math.min(Math.max(ends[i]!, start), text.length) : text.length;
    const fmtKey = formats[i];
    const fmt = fmtKey ? (obj(ctx, fmtKey)?.props ?? null) : null;
    raw.push({ text: text.slice(start, end), set: fmt });
    start = end;
  }

  const flag = (set: PropSet | null, id: number): boolean => (set && set.has(id) ? bool(set, id) : bool(base, id));
  const runs: OneNoteRun[] = [];
  let pendingLink: string | null = null;
  for (const r of raw) {
    // A hyperlink is a hidden field code run, U+FDDF then `HYPERLINK "url"`, before its display text.
    const field = /^\uFDDF?HYPERLINK\s+"([^"]*)"/.exec(r.text);
    if (field && (flag(r.set, P.Hidden) || r.text.startsWith('\uFDDF'))) {
      pendingLink = field[1] ?? null;
      continue;
    }
    const isLink = flag(r.set, P.Hyperlink) || flag(r.set, P.HyperlinkProtected);
    if (!isLink) pendingLink = null;
    const t = r.text.replace(/\uFDDF/g, '');
    if (!t) continue;
    // A URL OneNote linked as it was typed has the Hyperlink flag and no field code: the text is the target.
    const link = isLink ? (pendingLink ?? (/^(https?:\/\/|mailto:|onenote:)\S+$/i.test(t.trim()) ? t.trim() : null)) : null;
    const size = uint(r.set, P.FontSize) ?? uint(base, P.FontSize);
    runs.push({
      text: t,
      bold: flag(r.set, P.Bold),
      italic: flag(r.set, P.Italic),
      underline: flag(r.set, P.Underline),
      strike: flag(r.set, P.Strikethrough),
      superscript: flag(r.set, P.Superscript),
      subscript: flag(r.set, P.Subscript),
      color: colorRef(r.set, P.FontColor) ?? colorRef(base, P.FontColor),
      highlight: colorRef(r.set, P.Highlight) ?? colorRef(base, P.Highlight),
      link,
      math: flag(r.set, P.MathFormatting),
      font: wz(r.set, P.Font) ?? wz(base, P.Font),
      fontSize: size ? size / 2 : null,
    });
  }
  return runs;
}

function readTags(ctx: Ctx, node: PropSet | null): OneNoteTag[] {
  const v = prop(node, P.NoteTagStates);
  if (v?.kind !== 'sets') return [];
  const tags: { tag: OneNoteTag; order: number }[] = [];
  for (const state of v.v) {
    const defKey = oids(state, P.NoteTagDefinitionOid)[0];
    const def = defKey ? (obj(ctx, defKey)?.props ?? null) : null;
    const shape = uint(state, P.NoteTagShape) ?? uint(def, P.NoteTagShape) ?? 0;
    const status = uint(state, P.ActionItemStatus) ?? 0;
    const checkable = CHECKABLE_SHAPES.has(shape);
    // A task tag has no definition object; its shape stands for it.
    const orderKey = defKey ?? `shape:${shape}`;
    if (!ctx.tagOrder.has(orderKey)) ctx.tagOrder.set(orderKey, ctx.tagOrder.size);
    tags.push({
      tag: { shape, checkable, done: checkable && (status & 1) === 1, label: wz(def, P.NoteTagLabel) },
      order: ctx.tagOrder.get(orderKey)!,
    });
  }
  return tags.sort((a, b) => a.order - b.order).map((t) => t.tag);
}

function readList(ctx: Ctx, oe: PropSet): OneNoteList | null {
  const key = oids(oe, P.ListNodes)[0];
  const list = key ? (obj(ctx, key)?.props ?? null) : null;
  if (!list) return null;
  const raw = wz(list, P.NumberListFormat) ?? '';
  const format = raw.slice(1);
  const restart = uint(list, P.ListRestart);
  return { ordered: format.includes('\uFFFD'), format, restart };
}

function fileFor(ctx: Ctx, key: string | undefined, name: string | null): string | null {
  const o = key ? obj(ctx, key) : undefined;
  if (!o?.file) {
    if (key) ctx.book.missingFiles++;
    return null;
  }
  const guid = fileDataGuid(o.file.ref);
  const data = guid ? ctx.store.fileData.get(guid) : undefined;
  if (!guid || !data) {
    ctx.book.missingFiles++;
    return null;
  }
  if (!ctx.book.files.has(guid)) {
    const ext = o.file.ext.toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
    ctx.book.files.set(guid, { name: name || `${guid}${ext}`, ext, bytes: data });
  }
  return guid;
}

function alignmentOf(node: PropSet, style: PropSet | null): 'left' | 'center' | 'right' {
  const para = uint(node, P.ParagraphAlignment) ?? uint(style, P.ParagraphAlignment);
  if (para === 1) return 'center';
  if (para === 2) return 'right';
  if (para === 0) return 'left';
  // LayoutAlignment: horizontal alignment in the low three bits, laNil in the top bit.
  const layout = uint(node, P.LayoutAlignmentSelf) ?? uint(node, P.LayoutAlignmentInParent);
  if (layout === null || layout >>> 31 === 1) return 'left';
  const lha = layout & 7;
  if (lha === 2) return 'center';
  if (lha === 3 || lha === 5) return 'right';
  return 'left';
}

/** Appends the blocks of one content node at `indent`. */
function readContent(ctx: Ctx, key: string, indent: number, list: OneNoteList | null, out: OneNoteBlock[], depth: number): void {
  const o = obj(ctx, key);
  if (!o?.props) return;
  if (++ctx.blocks > BLOCK_LIMIT) throw new OneNoteError('store-corrupt', 'too many blocks');
  const node = o.props;
  const tags = readTags(ctx, node);
  switch (o.jcid) {
    case J.RichTextOENode: {
      const styleKey = oids(node, P.ParagraphStyle)[0];
      const style = styleKey ? wz(obj(ctx, styleKey)?.props ?? null, P.ParagraphStyleId) : null;
      const styleProps = styleKey ? (obj(ctx, styleKey)?.props ?? null) : null;
      out.push({
        type: 'paragraph',
        runs: readRuns(ctx, node),
        style,
        alignment: alignmentOf(node, styleProps),
        rtl: bool(node, P.ReadingOrderRTL),
        indent,
        tags,
        list,
      });
      return;
    }
    case J.TableNode: {
      const rows: OneNoteBlock[][][] = [];
      for (const rowKey of oids(node, P.ElementChildNodes)) {
        const row = obj(ctx, rowKey);
        if (row?.jcid !== J.TableRowNode) continue;
        const cells: OneNoteBlock[][] = [];
        for (const cellKey of oids(row.props, P.ElementChildNodes)) {
          const cell = obj(ctx, cellKey);
          const blocks: OneNoteBlock[] = [];
          if (cell?.jcid === J.TableCellNode) readElements(ctx, oids(cell.props, P.ElementChildNodes), 0, blocks, depth + 1);
          cells.push(blocks);
        }
        rows.push(cells);
      }
      out.push({ type: 'table', rows, bordersVisible: bool(node, P.TableBordersVisible), indent, tags, list });
      return;
    }
    case J.ImageNode: {
      const name = wz(node, P.ImageFilename);
      out.push({
        type: 'image',
        fileId: fileFor(ctx, oids(node, P.PictureContainer)[0], name),
        alt: wz(node, P.ImageAltText),
        name,
        width: points(float(node, P.LayoutMaxWidth)),
        height: points(float(node, P.LayoutMaxHeight)),
        sizeSetByUser: bool(node, P.IsLayoutSizeSetByUser),
        link: wz(node, P.WzHyperlinkUrl),
        indent,
        tags,
        list,
      });
      return;
    }
    case J.EmbeddedFileNode: {
      const name = wz(node, P.EmbeddedFileName) ?? wz(node, P.RichEditTextUnicode) ?? '';
      out.push({ type: 'file', fileId: fileFor(ctx, oids(node, P.EmbeddedFileContainer)[0], name), name, indent, tags, list });
      return;
    }
    default:
      ctx.book.unsupported.set(o.jcid, (ctx.book.unsupported.get(o.jcid) ?? 0) + 1);
  }
}

/** Appends outline elements and outline groups, depth first, in document order. */
function readElements(ctx: Ctx, keys: string[], indent: number, out: OneNoteBlock[], depth: number): void {
  if (depth > DEPTH_LIMIT) throw new OneNoteError('store-corrupt', 'outline too deep');
  for (const key of keys) {
    const o = obj(ctx, key);
    if (!o?.props) continue;
    if (o.jcid === J.OutlineGroup) {
      readElements(ctx, oids(o.props, P.ElementChildNodes), indent + 1, out, depth + 1);
      continue;
    }
    if (o.jcid !== J.OutlineElementNode) continue;
    const list = readList(ctx, o.props);
    for (const content of oids(o.props, P.ContentChildNodes)) readContent(ctx, content, indent, list, out, depth);
    readElements(ctx, oids(o.props, P.ElementChildNodes), indent + 1, out, depth + 1);
  }
}

function plainText(blocks: OneNoteBlock[]): string {
  return blocks
    .map((b) => (b.type === 'paragraph' ? b.runs.map((r) => r.text).join('') : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Page-level nodes sorted top to bottom, then left to right, as they sit on the page. */
function byPosition(ctx: Ctx, keys: string[]): string[] {
  const pos = keys.map((key, i) => {
    const p = obj(ctx, key)?.props ?? null;
    return { key, i, y: float(p, P.OffsetFromParentVert) ?? 0, x: float(p, P.OffsetFromParentHoriz) ?? 0 };
  });
  pos.sort((a, b) => a.y - b.y || a.x - b.x || a.i - b.i);
  return pos.map((p) => p.key);
}

function readPage(store: RevisionStore, space: ObjectSpace, book: OneNoteNotebook): OneNotePage | null {
  const ctx: Ctx = { space, store, book, blocks: 0, tagOrder: new Map() };
  const manifestKey = space.roots.get(ROLE_CONTENT);
  const manifest = manifestKey ? obj(ctx, manifestKey) : undefined;
  if (manifest?.jcid !== J.PageManifestNode) return null;
  const pageKey = oids(manifest.props, P.ContentChildNodes)[0];
  const page = pageKey ? obj(ctx, pageKey) : undefined;
  if (page?.jcid !== J.PageNode || !page.props) return null;
  const metaKey = space.roots.get(ROLE_METADATA);
  const meta = metaKey ? (obj(ctx, metaKey)?.props ?? null) : null;

  // The title: the outlines under the title node whose IsTitleText is set ([MS-ONE] 2.1.16).
  let title = '';
  const titleKey = oids(page.props, P.StructureElementChildNodes)[0];
  const titleNode = titleKey ? obj(ctx, titleKey) : undefined;
  if (titleNode?.jcid === J.TitleNode) {
    for (const outlineKey of oids(titleNode.props, P.ElementChildNodes)) {
      const outline = obj(ctx, outlineKey);
      if (!outline?.props || bool(outline.props, P.IsTitleDate)) continue;
      const blocks: OneNoteBlock[] = [];
      readElements(ctx, oids(outline.props, P.ElementChildNodes), 0, blocks, 0);
      title = plainText(blocks);
      if (title) break;
    }
  }
  const untitled = !title;
  if (!title) title = wz(meta, P.CachedTitleString) ?? wz(page.props, P.CachedTitleStringFromPage) ?? '';

  const blocks: OneNoteBlock[] = [];
  for (const key of byPosition(ctx, oids(page.props, P.ElementChildNodes))) {
    const o = obj(ctx, key);
    if (!o?.props) continue;
    if (o.jcid === J.OutlineNode) {
      if (bool(o.props, P.IsTitleText) || bool(o.props, P.IsTitleDate)) continue;
      readElements(ctx, oids(o.props, P.ElementChildNodes), 0, blocks, 0);
    } else {
      readContent(ctx, key, 0, null, blocks, 0);
    }
  }
  const level = uint(meta, P.PageLevel);
  const entity = bytes(meta, P.NotebookManagementEntityGuid);
  return {
    id: entity && entity.length >= 16 ? bracedGuid(readGuid(entity, 0)) : null,
    title,
    untitled,
    level: level !== null && level >= 1 && level <= 3 ? level : 1,
    createdAt: fileTime(meta, P.TopologyCreationTimeStamp),
    updatedAt: time32(page.props, P.LastModifiedTime),
    deleted: bool(meta, P.IsDeletedGraphSpaceContent),
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Sections and packages
// ---------------------------------------------------------------------------

function emptyBook(): OneNoteNotebook {
  return { sections: [], files: new Map(), skipped: [], unsupported: new Map(), missingFiles: 0 };
}

/** Reads one section file into `book`. A file it cannot read is listed in `book.skipped`. */
function addSectionFile(book: OneNoteNotebook, data: Uint8Array, name: string, folders: string[], recycled: boolean): void {
  let store: RevisionStore;
  try {
    store = readRevisionStore(data);
  } catch (err) {
    if (err instanceof OneNoteError) {
      book.skipped.push({ name, folders, reason: err.code });
      return;
    }
    throw err;
  }
  if (store.fileType === 'one') addSection(book, store, name, folders, recycled);
}

function addSection(book: OneNoteNotebook, store: RevisionStore, name: string, folders: string[], recycled: boolean): void {
  const root = store.spaces.get(store.rootSpace);
  if (!root || root.encrypted) {
    book.skipped.push({ name, folders, reason: root?.encrypted ? 'encrypted' : 'store-corrupt' });
    return;
  }
  const sectionKey = root.roots.get(ROLE_CONTENT);
  const sectionNode = sectionKey ? root.objects.get(sectionKey) : undefined;
  const metaKey = root.roots.get(ROLE_METADATA);
  const displayName = wz(metaKey ? (root.objects.get(metaKey)?.props ?? null) : null, P.SectionDisplayName);
  const section: OneNoteSection = { id: bracedGuid(store.guidFile), name: displayName || name, folders, recycled, pages: [] };
  if (sectionNode?.jcid === J.SectionNode) {
    for (const seriesKey of oids(sectionNode.props, P.ElementChildNodes)) {
      const series = root.objects.get(seriesKey);
      if (series?.jcid !== J.PageSeriesNode) continue;
      for (const spaceKey of osids(series.props, P.ChildGraphSpaceElementNodes)) {
        const space = store.spaces.get(spaceKey);
        if (!space || space.encrypted) continue;
        try {
          const page = readPage(store, space, book);
          if (page) section.pages.push(page);
        } catch (err) {
          if (!(err instanceof OneNoteError)) throw err;
          book.skipped.push({ name: `${section.name}`, folders, reason: err.code });
        }
      }
    }
  }
  book.sections.push(section);
}

/** Splits a path from the file into safe folder names: no empty, `.` or `..` parts. */
function safeParts(path: string): string[] {
  return path
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== '.' && p !== '..');
}

const RECYCLE_BIN = 'OneNote_RecycleBin';

/**
 * The order of the children of one notebook folder, from its `.onetoc2`:
 * child file or folder name (lowercase) to NotebookElementOrderingID. The
 * three property IDs are not in the [MS-ONE] property table; they were read
 * from the lab export of 2026-11-19, whose order they reproduce.
 */
const TOC_ENTRIES = 0x1cf6;
const TOC_CHILD_NAME = 0x1d6b;
const TOC_ORDER = 0x1cb9;

function readTocOrder(data: Uint8Array): Map<string, number> {
  const order = new Map<string, number>();
  let store: RevisionStore;
  try {
    store = readRevisionStore(data);
  } catch (err) {
    if (err instanceof OneNoteError) return order;
    throw err;
  }
  const space = store.spaces.get(store.rootSpace);
  const rootKey = space?.roots.get(ROLE_CONTENT);
  const root = rootKey ? space?.objects.get(rootKey) : undefined;
  if (!space || !root?.props) return order;
  for (const key of oids(root.props, TOC_ENTRIES)) {
    const entry = space.objects.get(key)?.props ?? null;
    const name = wz(entry, TOC_CHILD_NAME);
    const position = uint(entry, TOC_ORDER);
    if (name && position !== null) order.set(name.toLowerCase(), position);
  }
  return order;
}

/** Reads every section of a `.onepkg` (a cabinet) or of the files already taken out of one. */
export function readOneNoteFiles(files: CabFile[]): OneNoteNotebook {
  const book = emptyBook();
  const tocs = new Map<string, Map<string, number>>();
  const sections: { data: Uint8Array; parts: string[]; base: string; index: number }[] = [];
  files.forEach((f, index) => {
    const parts = safeParts(f.name);
    const base = parts.pop() ?? '';
    if (/\.onetoc2$/i.test(base)) tocs.set(parts.join('/').toLowerCase(), readTocOrder(f.data));
    else if (/\.one$/i.test(base)) sections.push({ data: f.data, parts, base, index });
  });
  // Sort by the table of contents at each level of the path, then by cabinet order.
  const rank = (parts: string[], leaf: string): number[] =>
    [...parts, leaf].map((name, i) => tocs.get(parts.slice(0, i).join('/').toLowerCase())?.get(name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER);
  const ranked = sections.map((sct) => ({ ...sct, rank: rank(sct.parts, sct.base) }));
  ranked.sort((a, b) => {
    for (let i = 0; i < Math.min(a.rank.length, b.rank.length); i++) if (a.rank[i] !== b.rank[i]) return a.rank[i]! - b.rank[i]!;
    return a.rank.length - b.rank.length || a.index - b.index;
  });
  for (const sct of ranked) {
    const recycled = sct.parts.includes(RECYCLE_BIN);
    const folders = sct.parts.filter((p) => p !== RECYCLE_BIN);
    addSectionFile(book, sct.data, sct.base.replace(/\.one$/i, ''), folders, recycled);
  }
  return book;
}

/**
 * Reads a `.onepkg` package or a single `.one` section file. Throws
 * `OneNoteError` when the file is neither; a section inside a package that
 * cannot be read is listed in `skipped` instead.
 */
export function readOneNote(bytes: Uint8Array, fileName: string): OneNoteNotebook {
  if (isCabinet(bytes)) return readOneNoteFiles(readCab(bytes));
  const book = emptyBook();
  const name = (safeParts(fileName).pop() ?? '').replace(/\.one$/i, '');
  const store = readRevisionStore(bytes);
  if (store.fileType !== 'one') throw new OneNoteError('store-not-revision-store', 'table of contents only');
  addSection(book, store, name, [], false);
  return book;
}
