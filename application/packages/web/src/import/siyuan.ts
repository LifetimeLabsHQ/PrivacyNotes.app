import JSZip from 'jszip';
import i18n from '../i18n';
import { mediaTooLargeWarning, zipEntryBytes, zipEntryMedia, zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';
import { extractInlineTags, normalizeTag } from '../notesRepo';
import { createFolder, type FolderDef } from '../folders';
import { IMPORT_FOLDER_LIMIT, commonRootPrefix } from './folderImport';
import { linkifyLiteralText } from './linkify';
import { noteLinkTarget } from '../noteLinks';
import { ATTACHMENT_EXT, mimeFromExt } from './blobImport';
import { escapeMarkdownText, guardMarkdownLineStart } from '../markdownEscape';
import { markdownCodeSpan } from './standardNotesSuper';
import { nearestHighlight, nearestTextColor } from './paletteColor';
import { mapOutsideCode } from './codeSegments';
import { parseMarkdown } from './markdown';
import { toLocalIso } from '../notesViewUtils';
import type { ImportBlob, ImportedNote, ParsedImport } from './types';
import { escapeHtml } from '../escapeHtml';

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:siyuan.${key}`, options);

/**
 * SiYuan importer.
 *
 * Reads the three exports SiYuan 3.x writes (format facts from the SiYuan and
 * Lute sources, checked against a real 3.8.10 export by the importer lab):
 *
 *   Data.zip      the whole workspace `data/` folder under `data-<time>/`:
 *                 `<boxId>/.siyuan/conf.json` per notebook, documents as
 *                 `<boxId>/<id>.sy`, children in `<boxId>/<id>/<child>.sy`,
 *                 and `assets/`, `storage/av/` beside the notebooks
 *   .sy.zip       one notebook (top folder = its name, with `.siyuan/conf.json`)
 *                 or one document (top folder = its title, no conf), plus the
 *                 assets and databases it uses
 *   Markdown zip  one `.md` per document; read by the Markdown importer, then
 *                 SiYuan's own syntax is cleaned up (`#tag#`, `[a](Doc.md#id)`)
 *
 * A `.sy` file is Lute's JSON node tree (`json.Marshal`, so `[]byte` fields such
 * as `CodeBlockInfo` are base64). Mapping:
 *
 *   notebook                   -> a top folder
 *   document with children     -> a folder of its name; its own text, when it
 *                                 has any, is a note inside that folder
 *   Properties.title / tags    -> title (plain; DocumentTitle formatting is
 *                                 dropped) and tags
 *   id (YYYYMMDDHHmmss-xxxxxxx)-> created date, local time; `updated` likewise
 *   bookmark attribute         -> starred
 *   block-ref                  -> note-link to the document, `#Heading` when
 *                                 the target is a heading; plain anchor text
 *                                 when the target is not in the export
 *   tabs / mindmap             -> folds / a nested list, with a warning
 *   attribute view (database)  -> a table from storage/av/<id>.json
 *   HTML, iframe, audio, video,
 *   widget, query embed        -> a link or a code block, never live HTML
 *   encrypted notebook         -> skipped with a warning naming it; its key
 *                                 material is never read
 */

/** A SiYuan block id: the creation time, then seven random characters. */
const ID_RE = /^\d{14}-[0-9a-z]{7}$/;
const SY_PATH_RE = /^(?:\d{14}-[0-9a-z]{7}\/)*\d{14}-[0-9a-z]{7}\.sy$/;
/** Recursion bound for a stranger's node tree. */
const MAX_DEPTH = 64;
const ALIGNED = new Set(['center', 'right', 'justify']);

type Props = Record<string, unknown>;

interface SyNode {
  ID?: unknown;
  Type?: unknown;
  Data?: unknown;
  Properties?: unknown;
  Children?: unknown;
  HeadingLevel?: unknown;
  ListData?: unknown;
  TaskListItemChecked?: unknown;
  IsFencedCodeBlock?: unknown;
  CodeBlockInfo?: unknown;
  TableAligns?: unknown;
  TableCellAlign?: unknown;
  TextMarkType?: unknown;
  TextMarkTextContent?: unknown;
  TextMarkAHref?: unknown;
  TextMarkATitle?: unknown;
  TextMarkBlockRefID?: unknown;
  TextMarkInlineMathContent?: unknown;
  TextMarkInlineMemoContent?: unknown;
  TextMarkFileAnnotationRefID?: unknown;
  CalloutType?: unknown;
  CalloutTitle?: unknown;
  TabItemTitle?: unknown;
  AttributeViewID?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const typeOf = (n: SyNode): string => str(n.Type);
const kids = (n: SyNode): SyNode[] =>
  Array.isArray(n.Children) ? (n.Children as unknown[]).filter((c): c is SyNode => !!c && typeof c === 'object') : [];
const props = (n: SyNode): Props =>
  n.Properties && typeof n.Properties === 'object' && !Array.isArray(n.Properties) ? (n.Properties as Props) : {};
const prop = (n: SyNode, key: string): string => {
  const p = props(n);
  return Object.hasOwn(p, key) ? str(p[key]) : '';
};

function startsWithSenc(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x53 && data[1] === 0x45 && data[2] === 0x4e && data[3] === 0x43;
}

/** Lute stores TextMark content HTML-escaped. */
function unescapeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function base64Text(b64: string): string {
  try {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

/** `YYYYMMDDHHmmss` at the start of a string, as local time; null when impossible. */
function stampDate(raw: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, s);
  if (
    date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d ||
    date.getHours() !== h || date.getMinutes() !== mi || date.getSeconds() !== s
  ) return null;
  if (y < 1900 || date.getTime() > Date.now() + 86_400_000) return null;
  return date.toISOString();
}

/** A link destination our markdown reads back whole. */
function linkTarget(url: string): string {
  return url.trim().replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\|/g, '%7C')
    .replace(/[\x00-\x1f\x7f<>]/g, (c) => encodeURIComponent(c));
}

/**
 * The `assets/...` path a destination names, normalized, or null when it is
 * not a workspace asset. `..`, absolute and backslash paths never become a key.
 */
function assetPath(dest: string): string | null {
  let p = dest.trim().replace(/\\/g, '/').replace(/[?#].*$/, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep the raw spelling */
  }
  p = p.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  if (!p.startsWith('assets/')) return null;
  const segs = p.split('/');
  if (segs.some((s) => s === '..' || s === '.' || s === '')) return null;
  return p;
}

/** SiYuan appends `-<id>` to every uploaded file name; the file keeps its own name. */
function assetDisplayName(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/-\d{14}-[0-9a-z]{7}(?=\.[^.]+$|$)/, '');
}

/** A tag our inline grammar reads back as a tag (`notesRepo.extractInlineTags`). */
const INLINE_TAG_RE = /^[\p{L}_][\p{L}\p{N}_/-]*$/u;

/* ------------------------------------------------------------------ */
/* Workspace model                                                     */
/* ------------------------------------------------------------------ */

interface SyDoc {
  id: string;
  parentId: string | null;
  root: SyNode;
  title: string;
  box: SyBox;
}

interface SyBox {
  name: string | null;
  sortMode: number;
  sort: Map<string, number>;
  docs: SyDoc[];
}

interface BlockInfo {
  docId: string;
  heading?: string;
}

interface Flags {
  embeds: number;
  queries: number;
  tabs: number;
  mindmaps: number;
  databases: number;
  avFailed: number;
  flashcards: number;
  memos: number;
  droppedColors: number;
  droppedAlign: number;
  missingAssets: number;
  unknownRefs: number;
  noteLinks: number;
  tooDeep: number;
}

/** Plain text of an inline run, for heading anchors. */
function plainText(nodes: SyNode[]): string {
  let out = '';
  for (const n of nodes) {
    const t = typeOf(n);
    if (t === 'NodeText') out += str(n.Data);
    else if (t === 'NodeTextMark') out += unescapeEntities(str(n.TextMarkTextContent) || str(n.TextMarkInlineMathContent));
    else if (t === 'NodeKramdownSpanIAL') continue;
    else out += plainText(kids(n));
  }
  return out.replace(/​/g, '').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* .sy tree -> markdown                                                */
/* ------------------------------------------------------------------ */

interface RenderEnv {
  docs: Map<string, SyDoc>;
  blocks: Map<string, BlockInfo>;
  assets: Map<string, JSZip.JSZipObject>;
  avs: Map<string, unknown>;
  usedAssets: Set<string>;
  flags: Flags;
}

interface DocResult {
  markdown: string;
  tags: string[];
  links: number;
}

function renderDoc(doc: SyDoc, env: RenderEnv): DocResult {
  const { flags } = env;
  const tags: string[] = [];
  let links = 0;
  let linkDepth = 0;
  let cellDepth = 0;

  function autolink(url: string): string {
    return `<${cellDepth > 0 ? url.replace(/\|/g, '\\|') : url}>`;
  }

  function literal(s: string): string {
    if (!s) return '';
    if (linkDepth > 0) return escapeMarkdownText(s);
    const res = linkifyLiteralText(s, escapeMarkdownText, autolink);
    links += res.links;
    return res.markdown;
  }

  function assetLink(label: string, dest: string, image: boolean): string | null {
    const path = assetPath(dest);
    if (!path) return null;
    const name = assetDisplayName(path);
    if (!env.assets.has(path)) {
      flags.missingAssets++;
      return `\`[${image ? 'image' : 'file'}: ${name.replace(/`/g, "'")} - not in the SiYuan export]\``;
    }
    env.usedAssets.add(path);
    const text = (label || name).replace(/[[\]]/g, '');
    return `${image ? '!' : ''}[${escapeMarkdownText(text)}](${linkTarget(path)})`;
  }

  /** A block-ref as a note-link, or plain anchor text when the target is not in the export. */
  function blockRef(id: string, anchor: string): string {
    const label = anchor.replace(/[[\]]/g, '').trim();
    const info = env.blocks.get(id);
    const target = info ? env.docs.get(info.docId) : undefined;
    if (!info || !target) {
      flags.unknownRefs++;
      return escapeMarkdownText(anchor.trim());
    }
    const heading = info.heading ? noteLinkTarget(info.heading) : '';
    let link: string;
    if (target.id === doc.id) {
      // A ref inside its own document: a heading is a same-note link, anything else plain text.
      if (!heading) return escapeMarkdownText(anchor.trim());
      link = `#${heading}`;
    } else {
      const title = noteLinkTarget(target.title);
      if (!title) return escapeMarkdownText(label);
      link = title + (heading && info.docId !== id ? `#${heading}` : '');
    }
    flags.noteLinks++;
    // In a table cell the bar would split the row, so the link keeps its target only.
    if (!label || label === link || cellDepth > 0) return `[[${link}]]`;
    return `[[${link}|${label}]]`;
  }

  function colorRun(inner: string, style: string, html: boolean): string {
    const colorCss = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim();
    const bgCss = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim();
    const color = colorCss ? nearestTextColor(colorCss) : null;
    const highlight = bgCss ? nearestHighlight(bgCss) : null;
    if ((colorCss && !color) || (bgCss && !highlight)) flags.droppedColors++;
    let out = inner;
    if (highlight) {
      out = highlight.value
        ? `<mark style="background-color: ${highlight.value}">${out}</mark>`
        : html ? `<mark>${out}</mark>` : `==${out}==`;
    }
    if (color) out = `<span style="color: ${color}">${out}</span>`;
    return out;
  }

  type Mode = 'md' | 'html' | 'cell';

  function textMark(n: SyNode, mode: Mode): string {
    const types = new Set(str(n.TextMarkType).split(/\s+/).filter(Boolean));
    const raw = unescapeEntities(str(n.TextMarkTextContent));
    const html = mode === 'html';

    if (types.has('inline-math')) {
      const latex = unescapeEntities(str(n.TextMarkInlineMathContent)).trim();
      return latex ? `$${latex}$` : '';
    }

    let core: string;
    let lead = '';
    let trail = '';
    if (types.has('code')) {
      const code = html ? `<code>${escapeHtml(raw)}</code>` : markdownCodeSpan(raw);
      core = mode === 'cell' ? code.replace(/\|/g, '\\|') : code;
    } else {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw)!;
      lead = m[1]!;
      trail = m[3]!;
      const text = m[2]!;
      if (!text) return raw;
      if (types.has('block-ref')) {
        core = blockRef(str(n.TextMarkBlockRefID), text);
      } else if (types.has('tag')) {
        tags.push(text);
        core = html ? escapeHtml(`#${text}`) : INLINE_TAG_RE.test(text) ? `#${text}` : escapeMarkdownText(text);
      } else if (types.has('a')) {
        const href = unescapeEntities(str(n.TextMarkAHref)).trim();
        const title = unescapeEntities(str(n.TextMarkATitle)).trim();
        linkDepth++;
        const label = html ? escapeHtml(text) : escapeMarkdownText(text);
        linkDepth--;
        const asset = href ? assetLink(text, href, false) : null;
        if (asset) core = asset;
        else if (!href) core = label;
        else if (html) core = `<a href="${escapeHtml(href)}">${label}</a>`;
        else if (text === href && !title && !/[\s<>\x00-\x1f\x7f]/.test(href)) {
          links++;
          core = autolink(href);
        } else core = `[${label}](${linkTarget(href)}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
      } else if (types.has('file-annotation-ref')) {
        const file = str(n.TextMarkFileAnnotationRefID).replace(/\/[^/]*$/, '');
        core = (env.assets.has(assetPath(file) ?? '') ? assetLink(text, file, false) : null) ?? escapeMarkdownText(text);
      } else {
        core = html ? escapeHtml(text) : linkDepth > 0 ? escapeMarkdownText(text) : literal(text);
      }
      if (types.has('inline-memo')) {
        const memo = unescapeEntities(str(n.TextMarkInlineMemoContent)).trim();
        if (memo) {
          flags.memos++;
          core += ` (${html ? escapeHtml(memo) : escapeMarkdownText(memo)})`;
        }
      }
    }

    if (types.has('sub')) core = `<sub>${core}</sub>`;
    if (types.has('sup')) core = `<sup>${core}</sup>`;
    if (types.has('u')) core = `<u>${core}</u>`;
    if (types.has('kbd')) core = `<kbd>${core}</kbd>`;
    if (types.has('mark')) core = html ? `<mark>${core}</mark>` : `==${core}==`;
    if (types.has('s')) core = html ? `<s>${core}</s>` : `~~${core}~~`;
    if (types.has('em')) core = html ? `<em>${core}</em>` : `*${core}*`;
    if (types.has('strong')) core = html ? `<strong>${core}</strong>` : `**${core}**`;
    const style = prop(n, 'style');
    if (style) core = colorRun(core, style, html);
    return lead + core + trail;
  }

  function image(n: SyNode): string {
    const children = kids(n);
    const alt = str(children.find((c) => typeOf(c) === 'NodeLinkText')?.Data);
    const dest = str(children.find((c) => typeOf(c) === 'NodeLinkDest')?.Data);
    if (!dest) return '';
    const asset = assetLink(alt, dest, true);
    if (asset) return asset;
    return `![${escapeMarkdownText(alt.replace(/[[\]]/g, ''))}](${linkTarget(dest)})`;
  }

  function inline(nodes: SyNode[], mode: Mode, depth: number): string {
    if (depth > MAX_DEPTH) {
      flags.tooDeep++;
      return '';
    }
    let out = '';
    nodes.forEach((n, i) => {
      switch (typeOf(n)) {
        case 'NodeText': {
          // SiYuan pads a mark with zero-width spaces; one inside the text is the writer's.
          let t = str(n.Data);
          if (i === 0 || typeOf(nodes[i - 1]!) !== 'NodeText') t = t.replace(/^​+/, '');
          if (i === nodes.length - 1 || typeOf(nodes[i + 1]!) !== 'NodeText') t = t.replace(/​+$/, '');
          out += mode === 'html' ? escapeHtml(t).replace(/\n/g, '<br>') : literal(t);
          break;
        }
        case 'NodeTextMark':
          out += textMark(n, mode);
          break;
        case 'NodeBackslash': {
          const t = kids(n).map((c) => str(c.Data)).join('');
          out += mode === 'html' ? escapeHtml(t) : escapeMarkdownText(t);
          break;
        }
        case 'NodeImage':
          out += image(n);
          break;
        case 'NodeBr':
        case 'NodeHardBreak':
        case 'NodeSoftBreak':
          out += mode === 'html' ? '<br>' : '\n';
          break;
        case 'NodeKramdownSpanIAL':
          break;
        default: {
          const children = kids(n);
          if (children.length > 0) out += inline(children, mode, depth + 1);
          else if (typeof n.Data === 'string') out += mode === 'html' ? escapeHtml(n.Data) : literal(n.Data);
        }
      }
    });
    return out;
  }

  /** Inline content only SiYuan's simple marks: the aligned HTML form can hold it. */
  function htmlSafe(nodes: SyNode[]): boolean {
    return nodes.every((n) => {
      const t = typeOf(n);
      if (t === 'NodeText' || t === 'NodeKramdownSpanIAL' || t === 'NodeBackslash') return true;
      if (t !== 'NodeTextMark') return false;
      return !/inline-math|block-ref|tag|file-annotation-ref/.test(str(n.TextMarkType));
    });
  }

  /** Paragraph markdown: each line kept as a line, none mistaken for block syntax. */
  function lines(md: string): string {
    return md
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (/^=+$/.test(l) ? `\\${l}` : guardMarkdownLineStart(l)))
      .join('\\\n');
  }

  function quote(body: string): string {
    return body
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
  }

  function indentRest(body: string, pad: string): string {
    return body
      .split('\n')
      .map((l, i) => (i === 0 || !l ? l : pad + l))
      .join('\n');
  }

  function list(n: SyNode, depth: number): string {
    const listData = (n.ListData && typeof n.ListData === 'object' ? n.ListData : {}) as Props;
    const typ = Number(listData['Typ']) || 0;
    const items = kids(n).filter((c) => typeOf(c) === 'NodeListItem' || typeOf(c) === 'NodeMindmapItem');
    const first = (items[0]?.ListData && typeof items[0].ListData === 'object' ? items[0].ListData : {}) as Props;
    let num = typ === 1 && Number.isInteger(Number(first['Num'])) && Number(first['Num']) >= 0 ? Number(first['Num']) : 1;
    const out: string[] = [];
    for (const item of items) {
      const children = kids(item);
      const checked = children.some((c) => typeOf(c) === 'NodeTaskListItemMarker' && c.TaskListItemChecked === true);
      const marker = typ === 1 ? `${num++}. ` : typ === 3 ? `- [${checked ? 'x' : ' '}] ` : '- ';
      let body = '';
      for (const c of children) {
        if (typeOf(c) === 'NodeTaskListItemMarker') continue;
        const isList = typeOf(c) === 'NodeList' || typeOf(c) === 'NodeMindmap';
        let part = block(c, depth + 1);
        if (part === '&nbsp;') part = '';
        if (!part) continue;
        if (isList && typeOf(c) === 'NodeMindmap') flags.mindmaps--; // counted once, at the outer map
        body += body ? (isList ? '\n' : '\n\n') + part : part;
      }
      const pad = ' '.repeat(typ === 1 ? marker.length : 2);
      out.push(body ? marker + indentRest(body, pad) : marker.trimEnd());
    }
    return out.join('\n');
  }

  function table(n: SyNode, depth: number): string {
    const head = kids(n).find((c) => typeOf(c) === 'NodeTableHead');
    const rows = [
      ...(head ? kids(head).filter((c) => typeOf(c) === 'NodeTableRow') : []),
      ...kids(n).filter((c) => typeOf(c) === 'NodeTableRow'),
    ];
    if (rows.length === 0) return '';
    cellDepth++;
    const cells = rows.map((r) =>
      kids(r)
        .filter((c) => typeOf(c) === 'NodeTableCell')
        .map((c) => inline(kids(c), 'cell', depth + 1).replace(/\n/g, '<br>').trim()),
    );
    cellDepth--;
    const width = Math.max(1, ...cells.map((r) => r.length));
    let aligns = Array.isArray(n.TableAligns) ? (n.TableAligns as unknown[]).map(Number) : [];
    if (!aligns.some((a) => a > 0)) {
      const headCells = rows[0] ? kids(rows[0]).filter((c) => typeOf(c) === 'NodeTableCell') : [];
      aligns = headCells.map((c) => Number(c.TableCellAlign) || 0);
    }
    const delim = Array.from({ length: width }, (_, i) =>
      aligns[i] === 1 ? ':---' : aligns[i] === 2 ? ':---:' : aligns[i] === 3 ? '---:' : '---',
    );
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
    return [line(cells[0]!), `| ${delim.join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
  }

  function fence(code: string, info: string): string {
    const run = Math.max(2, ...(code.match(/`{3,}/g) ?? []).map((r) => r.length));
    const f = '`'.repeat(run + 1);
    return `${f}${info}\n${code}\n${f}`;
  }

  function codeBlock(n: SyNode): string {
    const children = kids(n);
    const infoNode = children.find((c) => typeOf(c) === 'NodeCodeBlockFenceInfoMarker');
    const info = base64Text(str(infoNode?.CodeBlockInfo)).trim().split(/\s+/)[0] ?? '';
    const lang = /^[\w+#.-]{1,40}$/.test(info) ? info : '';
    const code = str(children.find((c) => typeOf(c) === 'NodeCodeBlockCode')?.Data)
      .replace(/\n$/, '')
      // SiYuan guards a fence line inside code with a zero-width joiner.
      .replace(/^‍(?=`{3,}|~{3,})/gm, '');
    return fence(code, lang);
  }

  /** An HTML-holding block: an asset or a web page becomes a link, anything else code. */
  function embed(n: SyNode): string {
    flags.embeds++;
    const html = str(n.Data).trim();
    if (!html) return '';
    const type = typeOf(n);
    if (type !== 'NodeHTMLBlock') {
      const src = unescapeEntities(/\bsrc\s*=\s*"([^"]*)"/i.exec(html)?.[1] ?? /\bsrc\s*=\s*'([^']*)'/i.exec(html)?.[1] ?? '').trim();
      if (src) {
        const asset = assetLink('', src, false);
        if (asset) return asset;
        if (/^https?:\/\/[^\s<>]+$/i.test(src)) {
          links++;
          return `<${src}>`;
        }
      }
    }
    return fence(html, 'html');
  }

  function avCell(value: Props | undefined): string {
    if (!value) return '';
    const content = (k: string): string => {
      const v = value[k];
      return v && typeof v === 'object' ? String((v as Props)['content'] ?? '') : '';
    };
    const formatted = (k: string): string => {
      const v = value[k];
      if (!v || typeof v !== 'object') return '';
      const o = v as Props;
      if (typeof o['formattedContent'] === 'string' && o['formattedContent']) return o['formattedContent'];
      if (o['isNotEmpty'] === false) return '';
      const c = Number(o['content']);
      return Number.isFinite(c) && c > 0 ? toLocalIso(new Date(c)) : '';
    };
    switch (str(value['type'])) {
      case 'block': return content('block');
      case 'text': return content('text');
      case 'url': return content('url');
      case 'email': return content('email');
      case 'phone': return content('phone');
      case 'number': {
        const v = value['number'];
        if (!v || typeof v !== 'object') return '';
        const o = v as Props;
        if (o['isNotEmpty'] === false) return '';
        return str(o['formattedContent']) || String(o['content'] ?? '');
      }
      case 'select':
      case 'mSelect': {
        const v = value['mSelect'];
        return Array.isArray(v) ? v.map((s) => (s && typeof s === 'object' ? str((s as Props)['content']) : '')).filter(Boolean).join(', ') : '';
      }
      case 'mAsset': {
        const v = value['mAsset'];
        return Array.isArray(v) ? v.map((s) => (s && typeof s === 'object' ? str((s as Props)['name']) || str((s as Props)['content']) : '')).filter(Boolean).join(', ') : '';
      }
      case 'checkbox': {
        const v = value['checkbox'];
        return v && typeof v === 'object' && (v as Props)['checked'] === true ? '✓' : '';
      }
      case 'date': return formatted('date');
      case 'created': return formatted('created');
      case 'updated': return formatted('updated');
      default: return '';
    }
  }

  /** A database block as a table, read from storage/av/<id>.json. */
  function attributeView(n: SyNode): string {
    const id = str(n.AttributeViewID);
    const av = ID_RE.test(id) ? env.avs.get(id) : undefined;
    if (!av || typeof av !== 'object') {
      flags.avFailed++;
      return '';
    }
    const a = av as Props;
    const keyValues = Array.isArray(a['keyValues']) ? (a['keyValues'] as unknown[]).filter((k): k is Props => !!k && typeof k === 'object') : [];
    const keyOf = (kv: Props): Props => (kv['key'] && typeof kv['key'] === 'object' ? (kv['key'] as Props) : {});
    const views = Array.isArray(a['views']) ? (a['views'] as unknown[]).filter((v): v is Props => !!v && typeof v === 'object') : [];
    const wanted = prop(n, 'custom-sy-av-view');
    const view = views.find((v) => v['id'] === wanted) ?? views[0];
    const viewBody = view && view['table'] && typeof view['table'] === 'object' ? (view['table'] as Props) : null;
    const viewCols = viewBody && Array.isArray(viewBody['columns']) ? (viewBody['columns'] as unknown[]).filter((c): c is Props => !!c && typeof c === 'object') : [];
    const columns = (viewCols.length > 0
      ? viewCols.filter((c) => c['hidden'] !== true).map((c) => keyValues.find((kv) => keyOf(kv)['id'] === c['id']))
      : keyValues
    ).filter((kv): kv is Props => !!kv);
    if (columns.length === 0) {
      flags.avFailed++;
      return '';
    }
    let itemIds = view && Array.isArray(view['itemIds']) ? (view['itemIds'] as unknown[]).map(str).filter(Boolean) : [];
    if (itemIds.length === 0) {
      const primary = keyValues.find((kv) => keyOf(kv)['type'] === 'block');
      const values = primary && Array.isArray(primary['values']) ? (primary['values'] as Props[]) : [];
      itemIds = values.map((v) => str(v?.['blockID'])).filter(Boolean);
    }
    const cell = (s: string) => escapeMarkdownText(s.replace(/\s*\n\s*/g, ' ').trim());
    const valueFor = (kv: Props, item: string): Props | undefined => {
      const values = Array.isArray(kv['values']) ? (kv['values'] as unknown[]) : [];
      return values.find((v): v is Props => !!v && typeof v === 'object' && (v as Props)['blockID'] === item);
    };
    const header = columns.map((kv) => cell(str(keyOf(kv)['name'])));
    const rows = itemIds.map((item) => columns.map((kv) => cell(avCell(valueFor(kv, item)))));
    const line = (r: string[]) => `| ${r.join(' | ')} |`;
    flags.databases++;
    const name = str(a['name']).trim();
    const tableMd = [line(header), `| ${columns.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
    return name ? `**${escapeMarkdownText(name)}**\n\n${tableMd}` : tableMd;
  }

  function block(n: SyNode, depth: number): string {
    if (depth > MAX_DEPTH) {
      flags.tooDeep++;
      return '';
    }
    if (prop(n, 'custom-riff-decks')) flags.flashcards++;
    const type = typeOf(n);
    switch (type) {
      case 'NodeParagraph': {
        const children = kids(n);
        const align = /text-align\s*:\s*(\w+)/i.exec(prop(n, 'style'))?.[1]?.toLowerCase();
        if (align && ALIGNED.has(align)) {
          if (htmlSafe(children)) {
            const html = inline(children, 'html', depth + 1).trim();
            return html ? `<p style="text-align: ${align}">${html}</p>` : '&nbsp;';
          }
          flags.droppedAlign++;
        }
        const md = lines(inline(children, 'md', depth + 1));
        return md || '&nbsp;';
      }
      case 'NodeHeading': {
        const level = Math.min(6, Math.max(1, Number(n.HeadingLevel) || 1));
        const children = kids(n);
        const align = /text-align\s*:\s*(\w+)/i.exec(prop(n, 'style'))?.[1]?.toLowerCase();
        if (align && ALIGNED.has(align) && htmlSafe(children)) {
          return `<h${level} style="text-align: ${align}">${inline(children, 'html', depth + 1).trim()}</h${level}>`;
        }
        return `${'#'.repeat(level)} ${inline(children, 'md', depth + 1).replace(/\s*\n\s*/g, ' ').trim()}`.trimEnd();
      }
      case 'NodeList':
        return list(n, depth);
      case 'NodeMindmap':
        flags.mindmaps++;
        return list(n, depth);
      case 'NodeBlockquote': {
        const body = blocks(kids(n), depth + 1);
        return body ? quote(body) : '';
      }
      case 'NodeSuperBlock':
        return blocks(kids(n), depth + 1);
      case 'NodeCodeBlock':
        return codeBlock(n);
      case 'NodeMathBlock': {
        const latex = str(kids(n).find((c) => typeOf(c) === 'NodeMathBlockContent')?.Data).trim();
        return latex ? `$$${latex}$$` : '';
      }
      case 'NodeTable':
        return table(n, depth);
      case 'NodeThematicBreak':
        return '---';
      case 'NodeCallout': {
        const raw = str(n.CalloutType).trim().toLowerCase();
        const keyword = /^[\w-]{1,30}$/.test(raw) ? raw : 'note';
        const title = str(n.CalloutTitle).replace(/\s+/g, ' ').trim();
        const head = `> [!${keyword}]+${title && title.toLowerCase() !== keyword ? ` ${title}` : ''}`;
        const body = blocks(kids(n), depth + 1);
        return body ? `${head}\n${quote(body)}` : head;
      }
      case 'NodeTabs': {
        flags.tabs++;
        return kids(n)
          .filter((c) => typeOf(c) === 'NodeTabItem')
          .map((tab) => {
            const title = str(tab.TabItemTitle).replace(/\s+/g, ' ').trim();
            const head = `> [!fold]+${title ? ` ${title}` : ''}`;
            const body = blocks(kids(tab), depth + 1);
            return body ? `${head}\n${quote(body)}` : head;
          })
          .join('\n\n');
      }
      case 'NodeHTMLBlock':
      case 'NodeIFrame':
      case 'NodeVideo':
      case 'NodeAudio':
      case 'NodeWidget':
        return embed(n);
      case 'NodeAttributeView':
        return attributeView(n);
      case 'NodeBlockQueryEmbed': {
        flags.queries++;
        const script = str(kids(n).find((c) => typeOf(c) === 'NodeBlockQueryEmbedScript')?.Data).trim();
        return script ? fence(unescapeEntities(script), 'sql') : '';
      }
      case 'NodeKramdownBlockIAL':
      case 'NodeYamlFrontMatter':
      case 'NodeBlockquoteMarker':
      case 'NodeSuperBlockOpenMarker':
      case 'NodeSuperBlockLayoutMarker':
      case 'NodeSuperBlockCloseMarker':
        return '';
      default: {
        const children = kids(n);
        if (children.length === 0) return typeof n.Data === 'string' ? lines(literal(n.Data)) : '';
        const blockish = children.some((c) => /^Node(Paragraph|Heading|List|Blockquote|CodeBlock|Table|SuperBlock|Callout|MathBlock)/.test(typeOf(c)));
        return blockish ? blocks(children, depth + 1) : lines(inline(children, 'md', depth + 1));
      }
    }
  }

  function blocks(nodes: SyNode[], depth: number): string {
    const out = nodes.map((n) => block(n, depth)).filter((b) => b !== '');
    while (out.length > 0 && out[out.length - 1] === '&nbsp;') out.pop();
    while (out.length > 0 && out[0] === '&nbsp;') out.shift();
    return out.join('\n\n');
  }

  return { markdown: blocks(kids(doc.root), 0), tags, links };
}

/* ------------------------------------------------------------------ */
/* Zip reading                                                         */
/* ------------------------------------------------------------------ */

interface Entry {
  path: string;
  file: JSZip.JSZipObject;
}

function safePath(name: string): string | null {
  const p = name.replace(/\\/g, '/');
  if (p.startsWith('/') || p.startsWith('__MACOSX/')) return null;
  if (p.split('/').some((s) => s === '..')) return null;
  return p;
}

async function readJson(entry: JSZip.JSZipObject): Promise<{ value: unknown; encrypted: boolean } | null> {
  const bytes = await zipEntryBytes(entry);
  if (startsWithSenc(bytes)) return { value: null, encrypted: true };
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown, encrypted: false };
  } catch {
    return null;
  }
}

export async function parseSiyuan(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(i18n.t('importLog:shared.readingZip'));
  let zip: JSZip;
  try {
    zip = await openZip(file);
  } catch {
    throw new Error(msg('notSiyuan'));
  }
  const entries: Entry[] = [];
  for (const f of Object.values(zip.files)) {
    if (f.dir) continue;
    const path = safePath(f.name);
    if (path) entries.push({ path, file: f });
  }
  if (entries.length === 0) throw new Error(i18n.t('importLog:shared.zipEmpty'));

  const confs = entries.filter((e) => /(?:^|\/)\.siyuan\/conf\.json$/.test(e.path));
  const syFiles = entries.filter((e) => e.path.endsWith('.sy'));
  if (confs.length === 0 && syFiles.length === 0) {
    if (entries.some((e) => /\.md$/i.test(e.path))) return parseSiyuanMarkdown(zip, file, onProgress);
    throw new Error(msg('notSiyuan'));
  }

  onProgress?.(msg('readingDocs'));
  const warnings: string[] = [];
  const boxes: SyBox[] = [];
  let encryptedDocs = 0;
  let damagedDocs = 0;
  let encryptedBoxes = 0;

  // Each notebook root, longest first so a .sy belongs to its nearest notebook.
  const roots: Array<{ root: string; box: SyBox | null }> = [];
  for (const conf of confs) {
    const root = conf.path.slice(0, conf.path.length - '.siyuan/conf.json'.length);
    const boxId = root.replace(/\/$/, '').split('/').pop() ?? '';
    const parsed = await readJson(conf.file);
    const c = parsed?.value && typeof parsed.value === 'object' ? (parsed.value as Props) : {};
    // Only these fields are read: an encrypted notebook's key material stays untouched.
    const name = typeof c['name'] === 'string' && c['name'].trim() ? c['name'].trim() : null;
    if (parsed?.encrypted || c['encrypted'] === true) {
      encryptedBoxes++;
      warnings.push(msg('encryptedNotebook', { name: name ?? boxId }));
      roots.push({ root, box: null });
      continue;
    }
    const box: SyBox = { name: name ?? (ID_RE.test(boxId) ? boxId : boxId || null), sortMode: Number(c['sortMode']) || 0, sort: new Map(), docs: [] };
    if (box.sortMode === 6) {
      const sortEntry = entries.find((e) => e.path === `${root}.siyuan/sort.json`);
      const sort = sortEntry ? await readJson(sortEntry.file) : null;
      if (sort?.value && typeof sort.value === 'object') {
        for (const [k, v] of Object.entries(sort.value as Props)) if (typeof v === 'number') box.sort.set(k, v);
      }
    }
    boxes.push(box);
    roots.push({ root, box });
  }
  if (confs.length === 0) {
    // A document .sy.zip: no notebook conf, the top folder is the document's title.
    const box: SyBox = { name: null, sortMode: 0, sort: new Map(), docs: [] };
    boxes.push(box);
    roots.push({ root: commonRootPrefix(syFiles.map((e) => e.path)), box });
  }
  roots.sort((a, b) => b.root.length - a.root.length);

  const docs = new Map<string, SyDoc>();
  const avIds = new Set<string>();
  for (const e of syFiles) {
    const owner = roots.find((r) => e.path.startsWith(r.root));
    if (!owner?.box) continue;
    const rel = e.path.slice(owner.root.length);
    if (!SY_PATH_RE.test(rel)) continue;
    const parsed = await readJson(e.file);
    if (parsed?.encrypted) {
      encryptedDocs++;
      continue;
    }
    const root = parsed?.value as SyNode | undefined;
    if (!root || typeof root !== 'object' || typeOf(root) !== 'NodeDocument') {
      damagedDocs++;
      continue;
    }
    const segs = rel.slice(0, -3).split('/');
    const id = segs[segs.length - 1]!;
    if (docs.has(id)) continue;
    const titleEmpty = prop(root, 'custom-sy-title-empty') === 'true';
    const doc: SyDoc = {
      id,
      parentId: segs.length > 1 ? segs[segs.length - 2]! : null,
      root,
      title: titleEmpty ? '' : prop(root, 'title').replace(/\s+/g, ' ').trim(),
      box: owner.box,
    };
    docs.set(id, doc);
    owner.box.docs.push(doc);
  }

  // Every block id to its document, and a heading's text, for block refs.
  const blockIndex = new Map<string, BlockInfo>();
  for (const doc of docs.values()) {
    blockIndex.set(doc.id, { docId: doc.id });
    const walk = (n: SyNode, depth: number) => {
      if (depth > MAX_DEPTH) return;
      const id = str(n.ID);
      const type = typeOf(n);
      if (id && !blockIndex.has(id)) {
        blockIndex.set(id, type === 'NodeHeading' ? { docId: doc.id, heading: plainText(kids(n)) } : { docId: doc.id });
      }
      if (type === 'NodeAttributeView') avIds.add(str(n.AttributeViewID));
      for (const c of kids(n)) walk(c, depth + 1);
    };
    walk(doc.root, 0);
  }

  // Workspace assets by their `assets/...` path, wherever the export put them.
  const assets = new Map<string, JSZip.JSZipObject>();
  const avs = new Map<string, unknown>();
  for (const e of entries) {
    if (e.path.includes('/.siyuan/') || e.path.startsWith('.siyuan/')) continue;
    const at = e.path.startsWith('assets/') ? 0 : e.path.indexOf('/assets/') + 1;
    if (at > 0 || e.path.startsWith('assets/')) {
      const key = assetPath(e.path.slice(at));
      if (key && !assets.has(key)) assets.set(key, e.file);
      continue;
    }
    const av = /(?:^|\/)storage\/av\/(\d{14}-[0-9a-z]{7})\.json$/.exec(e.path);
    if (av && avIds.has(av[1]!) && !avs.has(av[1]!)) {
      const parsed = await readJson(e.file);
      if (parsed && !parsed.encrypted) avs.set(av[1]!, parsed.value);
    }
  }

  onProgress?.(i18n.t('importLog:shared.buildingNotes'));
  const flags: Flags = {
    embeds: 0, queries: 0, tabs: 0, mindmaps: 0, databases: 0, avFailed: 0, flashcards: 0, memos: 0,
    droppedColors: 0, droppedAlign: 0, missingAssets: 0, unknownRefs: 0, noteLinks: 0, tooDeep: 0,
  };
  const env: RenderEnv = { docs, blocks: blockIndex, assets, avs, usedAssets: new Set(), flags };
  const now = new Date().toISOString();
  const notes: ImportedNote[] = [];
  let folderDefs: FolderDef[] = [];
  let droppedFolders = 0;
  let droppedAttrs = 0;
  let starredCount = 0;
  let linkifiedCount = 0;

  const addFolder = (name: string, parent: string | null): string | null => {
    if (folderDefs.length >= IMPORT_FOLDER_LIMIT) return null;
    const res = createFolder(folderDefs, name, parent);
    if (!res) return null;
    folderDefs = res.folders;
    return res.created.id;
  };

  const pushNote = (doc: SyDoc, folderId: string | null, folderPath: string[], hasChildren: boolean) => {
    const result = renderDoc(doc, env);
    const p = props(doc.root);
    const seen = new Set<string>();
    const tags = [...str(p['tags']).split(','), ...result.tags]
      .map((t) => normalizeTag(t))
      .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
    if (hasChildren && !result.markdown.trim() && tags.length === 0) return;
    if (Object.keys(p).some((k) => k === 'icon' || k === 'alias' || k === 'memo' || k === 'title-img' || (k.startsWith('custom-') && !k.startsWith('custom-sy-') && k !== 'custom-riff-decks'))) {
      droppedAttrs++;
    }
    const starred = str(p['bookmark']).trim() !== '';
    if (starred) starredCount++;
    if (result.links > 0) linkifiedCount++;
    const createdAt = stampDate(doc.id) ?? now;
    notes.push({
      title: doc.title,
      body: result.markdown,
      tags,
      createdAt,
      updatedAt: stampDate(str(p['updated'])) ?? createdAt,
      ...(starred ? { starred: true } : {}),
      folderId,
      ...(folderPath.length > 0 ? { folderPath } : {}),
    });
  };

  for (const box of boxes) {
    const byParent = new Map<string | null, SyDoc[]>();
    for (const doc of box.docs) {
      // A child whose parent document is missing sits at the notebook's top.
      const parent = doc.parentId && docs.get(doc.parentId)?.box === box ? doc.parentId : null;
      const list = byParent.get(parent) ?? [];
      list.push(doc);
      byParent.set(parent, list);
    }
    const ordered = (parent: string | null): SyDoc[] =>
      (byParent.get(parent) ?? []).sort((a, b) =>
        box.sortMode === 6
          ? (box.sort.get(a.id) ?? Infinity) - (box.sort.get(b.id) ?? Infinity) || a.title.localeCompare(b.title)
          : a.title.localeCompare(b.title),
      );
    let boxFolder: string | null = null;
    const boxPath = box.name ? [box.name] : [];
    if (box.name) {
      boxFolder = addFolder(box.name, null);
      if (!boxFolder) droppedFolders++;
    }
    const walk = (parent: string | null, folderId: string | null, path: string[], depth: number) => {
      for (const doc of ordered(parent)) {
        const hasChildren = (byParent.get(doc.id)?.length ?? 0) > 0 && depth < MAX_DEPTH;
        if (!hasChildren) {
          pushNote(doc, folderId, path, false);
          continue;
        }
        const name = doc.title || 'Untitled';
        const own = addFolder(name, folderId);
        if (!own) droppedFolders++;
        const ownPath = [...path, name];
        pushNote(doc, own ?? folderId, ownPath, true);
        walk(doc.id, own ?? folderId, ownPath, depth + 1);
      }
    };
    walk(null, boxFolder, boxPath, 0);
  }

  if (notes.length === 0 && folderDefs.length === 0) {
    throw new Error(encryptedBoxes > 0 || encryptedDocs > 0 ? msg('allEncrypted') : msg('noNotes'));
  }

  const blobs = new Map<string, ImportBlob>();
  let tooLarge = 0;
  for (const path of env.usedAssets) {
    const entry = assets.get(path);
    if (!entry) continue;
    const data = await zipEntryMedia(entry);
    if (!data) {
      tooLarge++;
      continue;
    }
    const name = assetDisplayName(path);
    blobs.set(path, { data, mime: mimeFromExt(name), name });
  }

  const transforms: string[] = [];
  if (folderDefs.length > 0) transforms.push(msg('rebuiltNotebooks', { count: folderDefs.length }));
  if (blobs.size > 0) transforms.push(i18n.t('importLog:shared.attachments', { count: blobs.size }));
  if (flags.noteLinks > 0) transforms.push(i18n.t('importLog:shared.noteLinks', { count: flags.noteLinks }));
  if (flags.databases > 0) transforms.push(msg('databases', { count: flags.databases }));
  if (starredCount > 0) transforms.push(msg('bookmarks', { count: starredCount }));
  if (linkifiedCount > 0) transforms.push(i18n.t('importLog:shared.linkifiedNotes', { count: linkifiedCount }));

  if (encryptedDocs > 0) warnings.push(msg('encryptedDocs', { count: encryptedDocs }));
  if (damagedDocs > 0) warnings.push(msg('damagedDocs', { count: damagedDocs }));
  if (tooLarge > 0) warnings.push(mediaTooLargeWarning(tooLarge));
  if (flags.missingAssets > 0) warnings.push(msg('missingAssets', { count: flags.missingAssets }));
  if (flags.unknownRefs > 0) warnings.push(msg('unknownRefs', { count: flags.unknownRefs }));
  if (flags.embeds > 0) warnings.push(msg('embeds', { count: flags.embeds }));
  if (flags.queries > 0) warnings.push(msg('queries', { count: flags.queries }));
  if (flags.tabs > 0) warnings.push(msg('tabs', { count: flags.tabs }));
  if (flags.mindmaps > 0) warnings.push(msg('mindmaps', { count: flags.mindmaps }));
  if (flags.avFailed > 0) warnings.push(msg('databasesFailed', { count: flags.avFailed }));
  if (flags.flashcards > 0) warnings.push(msg('flashcards', { count: flags.flashcards }));
  if (flags.memos > 0) warnings.push(msg('memos', { count: flags.memos }));
  if (droppedAttrs > 0) warnings.push(msg('droppedAttributes', { count: droppedAttrs }));
  if (flags.droppedColors > 0) warnings.push(msg('droppedColors', { count: flags.droppedColors }));
  if (flags.droppedAlign > 0) warnings.push(i18n.t('importLog:shared.droppedAlign'));
  if (droppedFolders > 0) warnings.push(msg('droppedFolders', { count: droppedFolders }));
  if (flags.tooDeep > 0) warnings.push(msg('tooDeep'));

  const uniqueTags = new Set(notes.flatMap((n) => n.tags));
  const parsed: ParsedImport = {
    notes,
    warnings,
    transforms,
    stats: {
      totalNotes: notes.length,
      emptyNotes: notes.filter((n) => !n.body.trim()).length,
      untaggedNotes: notes.filter((n) => n.tags.length === 0).length,
      uniqueTags: uniqueTags.size,
    },
    source: 'siyuan',
  };
  if (folderDefs.length > 0) parsed.folders = folderDefs;
  if (blobs.size > 0) {
    parsed.blobs = blobs;
    parsed.blobBytes = [...blobs.values()].reduce((sum, b) => sum + b.data.length, 0);
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Markdown export                                                     */
/* ------------------------------------------------------------------ */

/** A heading's text without its inline markers, as a title. */
function plainTitle(md: string): string {
  return md
    .replace(/\\([\\`*_[\]{}()#+\-.!|~=<>$])/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|==|`)/g, '')
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/[​‍]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * SiYuan's Markdown export. Its own syntax is rewritten first, in a copy of the
 * zip: the `# Title` line it writes at the top (`addTitle`, on by default),
 * `#tag#` tags, links between exported documents, colored spans, media HTML
 * and missing assets. The copy then goes through the Markdown importer, which
 * rebuilds the folders and brings the referenced files across.
 */
async function parseSiyuanMarkdown(zip: JSZip, file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  let noteLinks = 0;
  let embeds = 0;
  let missing = 0;
  let droppedColors = 0;
  let tooLarge = 0;
  let unsupported = 0;

  const files: Array<[string, JSZip.JSZipObject]> = [];
  zip.forEach((name, entry) => {
    const path = safePath(name);
    if (!entry.dir && path) files.push([path, entry]);
  });
  const assetSet = new Set<string>();
  for (const [path] of files) {
    const at = path.startsWith('assets/') ? 0 : path.indexOf('/assets/') + 1;
    const key = at > 0 || path.startsWith('assets/') ? assetPath(path.slice(at)) : null;
    if (key) assetSet.add(key);
  }

  const fileLink = (path: string, image: boolean, alt = ''): string => {
    const name = assetDisplayName(path);
    if (!assetSet.has(path)) {
      missing++;
      return `\`[${image ? 'image' : 'file'}: ${name.replace(/`/g, "'")} - not in the SiYuan export]\``;
    }
    if (!ATTACHMENT_EXT.test(path)) {
      // The Markdown importer carries only the file types it knows; the name stays.
      unsupported++;
      return escapeMarkdownText(name);
    }
    return `${image ? '!' : ''}[${escapeMarkdownText((image ? alt : '') || name)}](${linkTarget(path)})`;
  };

  const fix = (prose: string, tags: string[]): string =>
    prose
      // SiYuan pads marks and tags with zero-width spaces; a code span ends a segment here.
      .replace(/^\u200b|\u200b$/g, '')
      .replace(/\u200b(?=[`<#!*~=[]|$)/gm, '')
      .replace(/([`>#*~=\])])\u200b/g, '$1')
      .replace(/^\u200d$/gm, '')
      // The hidden anchor SiYuan writes before a referenced block.
      .replace(/<span id="\d{14}-[0-9a-z]{7}" style="display: none;"><\/span>/g, '')
      // `#tag#` is a SiYuan tag; a bare `#word` is text in SiYuan and stays text.
      .replace(/(^|[\s(])#(?:([^\s#](?:[^#\n]{0,200}?[^\s#])?)#(?=$|[\s.,;:!?)])|(?=[\p{L}_]))/gmu, (_w, pre: string, tag: string | undefined) => {
        if (tag === undefined) return `${pre}\\#`;
        tags.push(tag);
        return INLINE_TAG_RE.test(tag) ? `${pre}#${tag}` : `${pre}${escapeMarkdownText(tag)}`;
      })
      .replace(/(?<!!)\[([^\]\n]{0,500})\]\((?:\.\.\/|\.\/)*([^()\s]{1,500}?)\.md(?:#[^)\s]*)?\)/g, (whole, label: string, target: string) => {
        if (/^[a-z][\w+.-]*:/i.test(target)) return whole;
        let name: string;
        try {
          name = decodeURIComponent(target);
        } catch {
          name = target;
        }
        // SiYuan names a file after its title, with `-<id>` when two titles collide.
        const title = noteLinkTarget((name.split('/').pop() ?? name).replace(/-\d{14}-[0-9a-z]{7}$/, ''));
        if (!title) return whole;
        noteLinks++;
        const clean = label.replace(/[[\]|]/g, '').trim();
        return !clean || clean === title ? `[[${title}]]` : `[[${title}|${clean}]]`;
      })
      .replace(/<span data-type="text" style="([^"\n]{0,300})">([^<\n]{0,2000})<\/span>/g, (_w, style: string, text: string) => {
        const colorCss = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim();
        const bgCss = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim();
        const color = colorCss ? nearestTextColor(colorCss) : null;
        const highlight = bgCss ? nearestHighlight(bgCss) : null;
        if ((colorCss && !color) || (bgCss && !highlight)) droppedColors++;
        let out = text;
        if (highlight) out = highlight.value ? `<mark style="background-color: ${highlight.value}">${out}</mark>` : `==${out}==`;
        if (color) out = `<span style="color: ${color}">${out}</span>`;
        return out;
      })
      .replace(/^[ \t]*<(audio|video|iframe)\b[^>\n]{0,2000}?\bsrc="([^"\n]{1,2000})"[^>\n]{0,2000}>(?:[ \t]*<\/\1>)?[ \t]*$/gim, (_w, _tag: string, src: string) => {
        embeds++;
        const url = unescapeEntities(src).trim();
        const path = assetPath(url);
        if (path) return fileLink(path, false);
        return /^https?:\/\/[^\s<>]+$/i.test(url) ? `<${url}>` : `\`\`\`html\n${url}\n\`\`\``;
      })
      .replace(/^[ \t]*(<(div|section|table|details|script|style|object|embed|iframe|audio|video)\b[^\n]{0,5000})$/gim, (_w, html: string) => {
        embeds++;
        return `\`\`\`html\n${html}\n\`\`\``;
      })
      .replace(/(!?)\[([^\]\n]{0,500})\]\((assets\/[^)\s]{1,500})(?:\s+"[^"\n]*")?\)/g, (whole, bang: string, label: string, dest: string) => {
        const path = assetPath(dest);
        if (!path) return whole;
        if (bang) return fileLink(path, true, label);
        const link = fileLink(path, false);
        return link.startsWith('[') ? `[${label}](${linkTarget(path)})` : link;
      });

  onProgress?.(msg('readingDocs'));
  const meta: Array<{ title: string; tags: string[] }> = [];
  const copy = new JSZip();
  for (const [path, entry] of files) {
    if (!/\.md$/i.test(path)) {
      // Only files the Markdown importer carries; a `.txt` asset would become a note.
      if (!ATTACHMENT_EXT.test(path)) continue;
      const data = await zipEntryMedia(entry);
      if (data) copy.file(path, data);
      else tooLarge++;
      continue;
    }
    let body = (await zipEntryText(entry)).replace(/\r\n?/g, '\n');
    let title: string | null = null;
    const head = /^#[ \t]+([^\n]*)(?:\n|$)|^#[ \t]*(?:\n|$)/.exec(body);
    if (head) {
      title = plainTitle(head[1] ?? '');
      body = body.slice(head[0].length).replace(/^\n+/, '');
    }
    const tags: string[] = [];
    body = mapOutsideCode(body, (prose) => fix(prose, tags)).replace(/\n{3,}/g, '\n\n').trim();
    const index = meta.push({ title: title ?? '', tags }) - 1;
    // The copy's note carries its index, so its title and tags find it again.
    copy.file(path, `<!-- pnsy:${index}${title === null ? ':file' : ''} -->\n${body}\n`);
  }
  const rebuilt = await copy.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
  const md = await parseMarkdown(new File([rebuilt], file.name, { type: 'application/zip' }), onProgress);
  const folders = md.folders ?? [];

  const notes = md.notes.map((note) => {
    const m = /^<!-- pnsy:(\d+)(:file)? -->\n?/.exec(note.body);
    if (!m) return note;
    const info = meta[Number(m[1])];
    const seen = new Set<string>();
    const tags = [...note.tags, ...(info?.tags ?? [])]
      .map((t) => normalizeTag(t))
      .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
    return { ...note, title: m[2] || !info ? note.title : info.title, body: note.body.slice(m[0].length), tags };
  });

  // A document with children is a file beside a folder of the same name; it goes inside.
  const folderAt = (path: string[]): FolderDef | undefined => {
    let parent: string | null = null;
    let found: FolderDef | undefined;
    for (const seg of path) {
      found = folders.find((f) => f.parentId === parent && f.name === seg);
      if (!found) return undefined;
      parent = found.id;
    }
    return found;
  };
  for (const note of notes) {
    if (!note.title) continue;
    const own = folderAt([...(note.folderPath ?? []), note.title]);
    if (own) {
      note.folderPath = [...(note.folderPath ?? []), note.title];
      note.folderId = own.id;
    }
  }

  const warnings = [...md.warnings];
  const transforms = [...md.transforms];
  if (noteLinks > 0) transforms.push(i18n.t('importLog:shared.noteLinks', { count: noteLinks }));
  if (tooLarge > 0) warnings.push(mediaTooLargeWarning(tooLarge));
  if (missing > 0) warnings.push(msg('missingAssets', { count: missing }));
  if (unsupported > 0) warnings.push(msg('unsupportedFiles', { count: unsupported }));
  if (embeds > 0) warnings.push(msg('embeds', { count: embeds }));
  if (droppedColors > 0) warnings.push(msg('droppedColors', { count: droppedColors }));

  return {
    ...md,
    notes,
    warnings,
    transforms,
    stats: {
      totalNotes: notes.length,
      emptyNotes: notes.filter((n) => !n.title.trim() && !n.body.trim()).length,
      untaggedNotes: notes.filter((n) => n.tags.length === 0).length,
      uniqueTags: new Set(notes.flatMap((n) => n.tags)).size,
    },
    source: 'siyuan',
  };
}
