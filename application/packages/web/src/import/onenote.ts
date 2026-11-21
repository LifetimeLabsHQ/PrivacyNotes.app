/**
 * OneNote importer.
 *
 * Reads the notebook package OneNote for Windows writes with File > Export >
 * Notebook > OneNote Package (`.onepkg`), a single section file (`.one`), or
 * a zip of a local notebook folder (the `.one` and `.onetoc2` files on disk).
 * The binary layers live in their own files: `oneNoteCab.ts` (the cabinet and
 * its MSZIP or LZX folders), `oneNoteStore.ts` ([MS-ONESTORE]) and
 * `oneNoteModel.ts` ([MS-ONE]), which hand this file a neutral tree of
 * sections, pages and blocks.
 *
 * Mapping (lab run 2026-11-19, the importer lab app file for onenote):
 * - The notebook, its section groups and its sections become nested folders.
 *   A page becomes a note in its section's folder; a subpage too, in the same
 *   order, since a note has no children.
 * - Paragraphs become HTML first and then Markdown through the shared
 *   converter (`htmlNoteToMarkdown`), so marks, palette colors, alignment,
 *   lists, task lists and tables follow the rules every HTML importer uses.
 * - A to-do note tag becomes a task list item with its done state. Every
 *   other note tag (Important, Question, ...) becomes a tag on the note.
 * - A OneNote link to a page in the package becomes a note-link; a link to a
 *   section or another notebook keeps its text.
 * - Pictures and attached files become blobs under fixed-width keys.
 * - Ink, audio and password-protected sections are not readable from the
 *   package and are named in the warnings.
 */

import { openZip } from './zipOpen';
import { zipEntryMedia } from './zipEntry';
import { buildFolderTree } from './folderImport';
import { withBareLinks } from './bareLinks';
import { htmlNoteToMarkdown } from './notesnook';
import { mimeFromExt, isBlobReferenced } from './blobImport';
import { noteLink, normalizeTagList } from './importHelpers';
import { OneNoteError, type CabFile } from './oneNoteCab';
import {
  readOneNote,
  readOneNoteFiles,
  type OneNoteBlock,
  type OneNoteNotebook,
  type OneNotePage,
  type OneNoteParagraph,
  type OneNoteRun,
} from './oneNoteModel';
import type { ImportBlob, ImportedNote, ParsedImport } from './types';
import { escapeHtml as escHtml } from '../escapeHtml';
import i18n from '../i18n';

const msg = (key: string, options: Record<string, unknown> = {}): string => i18n.t(`importLog:onenote.${key}`, options);

/** Fonts that mean "this run is code" in OneNote, which has no code mark. */
const MONO_FONT = /^(consolas|courier( new)?|lucida console|cascadia (code|mono)|menlo|monaco|source code pro)$/i;

/** The `page-id` and `section-id` GUIDs of a `onenote:` link, uppercase with braces. */
function linkIds(href: string): { page: string | null; section: string | null } {
  const page = href.match(/[#&]page-id=(\{[0-9a-f-]{36}\})/i)?.[1]?.toUpperCase() ?? null;
  const section = href.match(/[#&]section-id=(\{[0-9a-f-]{36}\})/i)?.[1]?.toUpperCase() ?? null;
  return { page, section };
}

/** A web, mail or phone link the converter may keep; anything else keeps only its text. */
const SAFE_HREF = /^(https?:|mailto:|tel:)/i;

interface Ctx {
  /** Note-link tokens: token -> Markdown that replaces it after conversion. */
  tokens: Map<string, string>;
  /** Page GUID -> the title its note gets. */
  pageTitles: Map<string, string>;
  /** Section GUID -> the title of its first page. */
  sectionFirst: Map<string, string>;
  /** File id -> blob key. */
  fileKeys: Map<string, string>;
  book: OneNoteNotebook;
  blobs: Map<string, ImportBlob>;
  counts: {
    noteLinks: number;
    deadLinks: number;
    checklists: number;
    tables: number;
    codeBlocks: number;
    missingFiles: number;
  };
  /** Labels of the non-to-do note tags on the page being built. */
  pageTags: Set<string>;
}

function token(ctx: Ctx, markdown: string): string {
  const t = `PNONTOKEN${String(ctx.tokens.size + 1).padStart(6, '0')}X`;
  ctx.tokens.set(t, markdown);
  return t;
}

function blobKey(ctx: Ctx, fileId: string | null, fallbackName: string): { key: string; name: string } | null {
  if (!fileId) return null;
  const file = ctx.book.files.get(fileId);
  if (!file) return null;
  const existing = ctx.fileKeys.get(fileId);
  const name = (file.name || fallbackName).replace(/[\\/[\]()]/g, '-');
  if (existing) return { key: existing, name };
  const key = `onenote-file:${String(ctx.fileKeys.size + 1).padStart(6, '0')}`;
  ctx.fileKeys.set(fileId, key);
  ctx.blobs.set(key, { data: file.bytes, mime: mimeFromExt(name.includes('.') ? name : `${name}${file.ext}`), name });
  return { key, name };
}

function runHtml(ctx: Ctx, r: OneNoteRun, inCode: boolean): string {
  if (!r.text) return '';
  let s = escHtml(r.text).replace(/\v|\r\n|\r|\n/g, '<br>');
  if (!inCode && r.font && MONO_FONT.test(r.font.trim())) s = `<code>${s}</code>`;
  if (r.superscript) s = `<sup>${s}</sup>`;
  if (r.subscript) s = `<sub>${s}</sub>`;
  if (r.strike) s = `<s>${s}</s>`;
  if (r.underline) s = `<u>${s}</u>`;
  if (r.italic) s = `<em>${s}</em>`;
  if (r.bold) s = `<strong>${s}</strong>`;
  const css: string[] = [];
  if (r.color) css.push(`color: ${r.color}`);
  if (r.highlight) css.push(`background-color: ${r.highlight}`);
  if (css.length) s = `<span style="${css.join('; ')}">${s}</span>`;
  if (r.link) {
    const href = r.link.trim();
    if (/^onenote:/i.test(href)) {
      const { page, section } = linkIds(href);
      const target = (page && ctx.pageTitles.get(page)) ?? (!page && section ? ctx.sectionFirst.get(section) : undefined);
      if (target !== undefined && target) {
        ctx.counts.noteLinks++;
        return token(ctx, noteLink(target, r.text));
      }
      ctx.counts.deadLinks++;
    } else if (SAFE_HREF.test(href)) {
      s = `<a href="${escHtml(href)}">${s}</a>`;
    }
  }
  return s;
}

function paragraphInner(ctx: Ctx, p: OneNoteParagraph, inCode = false): string {
  // Runs that link to one target and sit side by side make one link.
  return p.runs.map((r) => runHtml(ctx, r, inCode)).join('');
}

function headingTag(style: string | null): string | null {
  if (!style) return null;
  if (style === 'PageTitle') return 'h1';
  return /^h[1-6]$/.test(style) ? style : null;
}

function alignAttr(p: OneNoteParagraph): string {
  const css: string[] = [];
  if (p.alignment !== 'left' && !(p.rtl && p.alignment === 'right')) css.push(`text-align: ${p.alignment}`);
  return css.length ? ` style="${css.join('; ')}"` : '';
}

/** The blocks of a table cell, as inline HTML: a cell holds lines, not blocks. */
function cellHtml(ctx: Ctx, blocks: OneNoteBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.type === 'paragraph') {
      const inner = paragraphInner(ctx, b);
      const todo = b.tags.find((t) => t.checkable);
      const prefix = todo ? (todo.done ? '[x] ' : '[ ] ') : b.list ? (b.list.ordered ? '1. ' : '• ') : '';
      for (const t of b.tags) if (!t.checkable && t.label) ctx.pageTags.add(t.label);
      lines.push(prefix + inner);
    } else if (b.type === 'image' || b.type === 'file') {
      lines.push(fileHtml(ctx, b));
    } else {
      lines.push(cellHtml(ctx, b.rows.flat().flat()));
    }
  }
  return lines.join(token(ctx, '<br>'));
}

function tableHtml(ctx: Ctx, rows: OneNoteBlock[][][]): string {
  ctx.counts.tables++;
  // A Markdown table always has a header row, and OneNote stores no header
  // flag: the first row is the header, as it is in most OneNote tables.
  const row = (cells: OneNoteBlock[][], tag: 'th' | 'td') => `<tr>${cells.map((cell) => `<${tag}>${cellHtml(ctx, cell)}</${tag}>`).join('')}</tr>`;
  const [head, ...rest] = rows;
  if (!head) return '';
  return `<table><thead>${row(head, 'th')}</thead><tbody>${rest.map((r) => row(r, 'td')).join('')}</tbody></table>`;
}

function fileHtml(ctx: Ctx, b: Extract<OneNoteBlock, { type: 'image' | 'file' }>): string {
  const isImage = b.type === 'image';
  const ref = blobKey(ctx, b.fileId, isImage ? (b.alt || 'image') : b.name);
  if (!ref) {
    ctx.counts.missingFiles++;
    return isImage ? escHtml(b.alt ?? '') : escHtml(b.name);
  }
  if (isImage) {
    const alt = (b.alt ?? '').replace(/[[\]\n]/g, ' ').trim();
    return token(ctx, `![${alt}](${ref.key})`);
  }
  return token(ctx, `[${b.name.replace(/[[\]\n]/g, ' ').trim() || ref.name}](${ref.key})`);
}

/** Blocks with their outline children, built from the flat `indent` depths. */
interface Node {
  block: OneNoteBlock;
  children: Node[];
}

function nest(blocks: OneNoteBlock[]): Node[] {
  const roots: Node[] = [];
  const stack: { depth: number; node: Node }[] = [];
  for (const block of blocks) {
    const node: Node = { block, children: [] };
    while (stack.length && stack[stack.length - 1]!.depth >= block.indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    stack.push({ depth: block.indent, node });
  }
  return roots;
}

type ListKind = 'ul' | 'ol' | 'todo' | null;

function listKind(b: OneNoteBlock): ListKind {
  if (b.tags.some((t) => t.checkable)) return 'todo';
  if (b.list) return b.list.ordered ? 'ol' : 'ul';
  return null;
}

function nodeContent(ctx: Ctx, b: OneNoteBlock): string {
  for (const t of b.tags) if (!t.checkable && t.label) ctx.pageTags.add(t.label);
  if (b.type === 'paragraph') return paragraphInner(ctx, b);
  if (b.type === 'table') return tableHtml(ctx, b.rows);
  return fileHtml(ctx, b);
}

/** Renders sibling nodes, grouping list items of one kind into one list. */
function renderNodes(ctx: Ctx, nodes: Node[]): string {
  let out = '';
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i]!;
    const kind = listKind(node.block);
    if (kind) {
      const items: Node[] = [];
      while (i < nodes.length && listKind(nodes[i]!.block) === kind) items.push(nodes[i++]!);
      if (kind === 'todo') ctx.counts.checklists++;
      const open = kind === 'todo' ? '<ul class="checklist">' : kind === 'ol' ? `<ol${items[0]!.block.list?.restart ? ` start="${items[0]!.block.list.restart}"` : ''}>` : '<ul>';
      const close = kind === 'ol' ? '</ol>' : '</ul>';
      out += open;
      for (const it of items) {
        const done = kind === 'todo' && it.block.tags.some((t) => t.checkable && t.done);
        out += `<li${done ? ' class="checked"' : ''}>${nodeContent(ctx, it.block)}${renderNodes(ctx, it.children)}</li>`;
      }
      out += close;
      continue;
    }
    i++;
    const b = node.block;
    if (b.type === 'paragraph' && b.style === 'code') {
      // Consecutive code paragraphs make one code block.
      const lines = [b.runs.map((r) => r.text).join('')];
      while (i < nodes.length) {
        const nb = nodes[i]!.block;
        if (nb.type !== 'paragraph' || nb.style !== 'code' || listKind(nb) || nodes[i]!.children.length) break;
        lines.push(nb.runs.map((r) => r.text).join(''));
        i++;
      }
      ctx.counts.codeBlocks++;
      out += `<pre><code>${escHtml(lines.join('\n'))}</code></pre>`;
    } else if (b.type === 'paragraph') {
      const inner = nodeContent(ctx, b);
      const h = headingTag(b.style);
      if (h) out += `<${h}${alignAttr(b)}>${inner}</${h}>`;
      else if (b.style === 'quote') out += `<blockquote><p>${inner}</p></blockquote>`;
      else out += `<p${alignAttr(b)}${b.rtl ? ' dir="rtl"' : ''}>${inner || '<br>'}</p>`;
    } else {
      out += `<div>${nodeContent(ctx, b)}</div>`;
    }
    out += renderNodes(ctx, node.children);
  }
  return out;
}

function pageMarkdown(ctx: Ctx, page: OneNotePage): string {
  ctx.pageTags = new Set();
  const html = renderNodes(ctx, nest(page.blocks));
  let md = html ? htmlNoteToMarkdown(html) : '';
  for (const [t, rep] of ctx.tokens) if (md.includes(t)) md = md.split(t).join(rep);
  return md.replace(/\n{3,}/g, '\n\n').trim();
}

function isoOr(ms: number | null, fallback: string, nowMs: number): string {
  // A date before 1980 or in the future is a broken field, not a real page.
  if (ms === null || !Number.isFinite(ms) || ms < Date.UTC(1980, 0, 1) - 366 * 86_400_000 * 20 || ms > nowMs + 86_400_000) return fallback;
  return new Date(ms).toISOString();
}

async function zipNotebook(file: File): Promise<CabFile[]> {
  const zip = await openZip(file);
  const out: CabFile[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !/\.(one|onetoc2)$/i.test(entry.name)) continue;
    const data = await zipEntryMedia(entry);
    if (data) out.push({ name: entry.name, data });
  }
  if (!out.some((f) => /\.one$/i.test(f.name))) throw new Error(msg('notOneNote'));
  return out;
}

function errorMessage(e: unknown): string {
  if (!(e instanceof OneNoteError)) return e instanceof Error ? e.message : String(e);
  switch (e.code) {
    case 'store-fsshttpb':
      return msg('cloudFormat');
    case 'cab-split':
      return msg('splitPackage');
    case 'cab-too-large':
      return msg('tooLarge');
    case 'cab-not-cabinet':
    case 'store-not-revision-store':
      return msg('notOneNote');
    default:
      return msg('damaged');
  }
}

export const parseOneNote = withBareLinks(readOneNoteExport);

async function readOneNoteExport(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(msg('reading'));
  let book: OneNoteNotebook;
  const isZip = /\.zip$/i.test(file.name);
  try {
    book = isZip ? readOneNoteFiles(await zipNotebook(file)) : readOneNote(new Uint8Array(await file.arrayBuffer()), file.name);
  } catch (e) {
    throw new Error(errorMessage(e));
  }
  const nowMs = Date.now();
  const fileTime = file.lastModified && file.lastModified <= nowMs ? new Date(file.lastModified).toISOString() : new Date(nowMs).toISOString();
  const notebookName = file.name.replace(/\.(onepkg|one|zip)$/i, '').replace(/[\\/]/g, '-').trim() || 'OneNote';

  const live = book.sections.filter((s) => !s.recycled);
  const pages = live.flatMap((s) => s.pages.filter((p) => !p.deleted).map((p) => ({ section: s, page: p })));
  if (pages.length === 0) {
    if (book.skipped.some((s) => s.reason === 'encrypted')) throw new Error(msg('allLocked'));
    throw new Error(msg('noPages'));
  }

  // Titles first, so a link to a later page resolves.
  const pageTitles = new Map<string, string>();
  const sectionFirst = new Map<string, string>();
  const titleOf = (p: OneNotePage): string => (p.untitled ? '' : p.title.replace(/\s+/g, ' ').trim());
  for (const s of live) {
    const first = s.pages.find((p) => !p.deleted && titleOf(p));
    if (s.id && first) sectionFirst.set(s.id, titleOf(first));
    for (const p of s.pages) if (p.id && titleOf(p)) pageTitles.set(p.id, titleOf(p));
  }

  // A lone section file has no notebook around it: its section is the top folder.
  const single = /\.one$/i.test(file.name);
  const dirOf = (folders: string[], name: string): string => [...(single ? [] : [notebookName]), ...folders, name].map((x) => x.replace(/\//g, '-').trim() || '-').join('/');
  const { folders, dirToFolderId } = buildFolderTree(live.map((s) => dirOf(s.folders, s.name)));

  const ctx: Ctx = {
    tokens: new Map(),
    pageTitles,
    sectionFirst,
    fileKeys: new Map(),
    book,
    blobs: new Map(),
    counts: { noteLinks: 0, deadLinks: 0, checklists: 0, tables: 0, codeBlocks: 0, missingFiles: book.missingFiles },
    pageTags: new Set(),
  };

  onProgress?.(i18n.t('importLog:shared.buildingNotes'));
  const notes: ImportedNote[] = [];
  let subpages = 0;
  let tagged = 0;
  for (const { section, page } of pages) {
    const body = pageMarkdown(ctx, page);
    if (page.level > 1) subpages++;
    const tags = normalizeTagList([...ctx.pageTags]);
    if (tags.length) tagged++;
    const createdAt = isoOr(page.createdAt, fileTime, nowMs);
    const updatedAt = isoOr(page.updatedAt, createdAt, nowMs);
    const dir = dirOf(section.folders, section.name);
    const folderId = dirToFolderId.get(dir);
    notes.push({
      title: titleOf(page),
      body,
      tags,
      createdAt,
      updatedAt: updatedAt < createdAt ? createdAt : updatedAt,
      ...(folderId ? { folderId, folderPath: dir.split('/') } : {}),
    });
  }

  for (const key of [...ctx.blobs.keys()]) if (!notes.some((n) => isBlobReferenced(key, n.body))) ctx.blobs.delete(key);

  const transforms: string[] = [];
  const warnings: string[] = [];
  if (folders.length) transforms.push(i18n.t('importLog:shared.foldersFromNotebooks', { count: folders.length, filed: i18n.t('importLog:shared.filedNotes', { count: notes.length }) }));
  if (subpages) transforms.push(msg('subpages', { count: subpages }));
  if (ctx.counts.noteLinks) transforms.push(i18n.t('importLog:shared.noteLinks', { count: ctx.counts.noteLinks }));
  if (ctx.counts.checklists) transforms.push(i18n.t('importLog:shared.checklists', { count: ctx.counts.checklists }));
  if (ctx.counts.tables) transforms.push(i18n.t('importLog:shared.tables', { count: ctx.counts.tables }));
  if (ctx.counts.codeBlocks) transforms.push(i18n.t('importLog:shared.codeBlocks', { count: ctx.counts.codeBlocks }));
  if (ctx.blobs.size) transforms.push(i18n.t('importLog:shared.attachments', { count: ctx.blobs.size }));
  if (tagged) transforms.push(msg('noteTags', { count: tagged }));

  const locked = book.skipped.filter((s) => s.reason === 'encrypted').length;
  const unreadable = book.skipped.length - locked;
  const ink = [...book.unsupported.values()].reduce((a, b) => a + b, 0);
  const recycled = book.sections.filter((s) => s.recycled).reduce((n, s) => n + s.pages.length, 0) + book.sections.reduce((n, s) => n + s.pages.filter((p) => p.deleted).length, 0);
  if (locked) warnings.push(msg('lockedSections', { count: locked }));
  if (unreadable) warnings.push(msg('unreadableSections', { count: unreadable }));
  if (ink) warnings.push(msg('unsupported', { count: ink }));
  if (ctx.counts.missingFiles) warnings.push(msg('missingFiles', { count: ctx.counts.missingFiles }));
  if (ctx.counts.deadLinks) warnings.push(msg('deadLinks', { count: ctx.counts.deadLinks }));
  if (recycled) warnings.push(msg('recycleBin', { count: recycled }));

  const parsed: ParsedImport = {
    notes,
    warnings,
    transforms,
    source: 'onenote',
  };
  if (folders.length) parsed.folders = folders;
  if (ctx.blobs.size) {
    parsed.blobs = ctx.blobs;
    parsed.blobBytes = [...ctx.blobs.values()].reduce((sum, b) => sum + b.data.length, 0);
  }
  return parsed;
}
