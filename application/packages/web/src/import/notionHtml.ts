/**
 * Notion HTML export page -> PrivacyNotes Markdown converter.
 *
 * Verified against real Notion Web HTML exports (2026-11-25,
 * `.agents/skills/importer-lab/apps/notion.md`). Unlike Notion's "Markdown & CSV"
 * export (which flattens columns and drops text colors/highlights), the HTML
 * export carries explicit `data-notion-*` attributes for columns, column ratios,
 * callouts, text colors, background highlights, inline/block equations, code
 * languages, images, files, and page IDs.
 */

import { DEFAULT_HIGHLIGHT, HIGHLIGHT_COLORS, TEXT_COLORS } from '../editorColors';
import { effectiveWidths } from '../tableColumnWidths';
import { escapeMarkdownText, guardMarkdownLineStart, markdownCodeSpan } from './standardNotesSuper';
import {
  appendMathSafe,
  containsMarkdownBlock,
  escapePipeCell,
  formatMarkdownLinkTarget,
  isUnsafeUrl,
  joinMathSafe,
  normalizeTagList,
  orderedListStart,
  sanitizeBlockLatex,
  sanitizeInlineLatex,
  shouldUseHtmlMark,
  sublistNeedsBlankLine,
} from './importHelpers';

const MAX_HTML_DEPTH = 64;
const MAX_COLUMNS = 5;

const SKIP_TAGS = new Set(['script', 'style', 'link', 'noscript', 'template', 'head', 'meta']);

const NOTION_COLOR_NAME: Readonly<Record<string, string>> = {
  gray: 'Gray',
  brown: 'Orange',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  red: 'Red',
};

const TEXT_COLOR_BY_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  TEXT_COLORS.map((c) => [c.name, c.value]),
);

const HIGHLIGHT_BY_NAME: Readonly<Record<string, { name: string; value: string | null }>> = Object.fromEntries(
  HIGHLIGHT_COLORS.map((c) => [c.name, c]),
);

export interface NotionHtmlOptions {
  /** Turn an `<a href>` (and optional Notion page UUID) into Markdown (note-link, link, or plain text). */
  resolveLink: (href: string, label: string, plainText: string, pageId: string | null) => string;
  /** Map a callout emoji to a PrivacyNotes callout keyword. */
  resolveCalloutType: (emoji: string) => string;
}

export interface NotionHtmlResult {
  title: string;
  body: string;
  tags: string[];
  callouts: number;
  columns: number;
  colors: number;
}

/** Normalize a Notion UUID (with or without hyphens) to 32 lowercase hex chars, or null. */
function normalizeUuid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.replace(/-/g, '').trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
}

function inlineOnly(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim();
}

/** Extract the filename from a relative or URL-encoded asset path for default alt text. */
function fileBasename(raw: string): string {
  const noQuery = raw.split(/[?#]/)[0] ?? raw;
  const last = noQuery.slice(noQuery.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last) || last;
  } catch {
    return last;
  }
}

/** Convert positive numeric column ratios into integer weights summing to 100, or null when equal. */
function columnWeightsFromRatios(ratios: number[]): number[] | null {
  return ratios.every((r) => Number.isFinite(r) && r > 0) ? effectiveWidths(ratios) : null;
}

/** Extract a Notion column's numeric width ratio from `data-notion-column-ratio` or `style="width:N%"`. */
function readColumnRatio(col: Element): number {
  const attr = parseFloat(col.getAttribute('data-notion-column-ratio') ?? '');
  if (Number.isFinite(attr) && attr > 0) return attr;
  const style = col.getAttribute('style') ?? '';
  const m = /(?:^|;)\s*width\s*:\s*([\d.]+)\s*%/i.exec(style);
  const pct = m ? parseFloat(m[1]!) : NaN;
  if (Number.isFinite(pct) && pct > 0) return pct / 100;
  return 1;
}

/** Parse a `<mark class="highlight-...">` color name (`red` or `yellow_background`). */
function readNotionHighlight(el: Element): string | null {
  const attr = el.getAttribute('data-notion-highlight')?.trim().toLowerCase();
  if (attr) return attr;
  const m = /(?:^|\s)highlight-([a-z]+(?:_background)?)(?:\s|$)/i.exec(el.getAttribute('class') ?? '');
  return m ? m[1]!.toLowerCase() : null;
}

/** Wrap an inline run with a Markdown/HTML delimiter while keeping leading/trailing spaces outside. */
function wrapRun(inner: string, open: string, close: string): string {
  if (!inner.trim()) return inner;
  const [, lead = '', core = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner) ?? [];
  if (!core || containsMarkdownBlock(core)) return inner;
  return `${lead}${open}${core}${close}${trail}`;
}

/** True when a span carries Notion's inline underline style (`border-bottom:0.05em solid`). */
function isUnderlineSpan(el: Element): boolean {
  const style = (el.getAttribute('style') ?? '').toLowerCase();
  return /border-bottom\s*:/i.test(style) || /text-decoration[^;]*underline/i.test(style);
}

/** Longest backtick run in `code`, so a fence can use one more. */
function fenceFor(code: string): string {
  let max = 2;
  for (const m of code.matchAll(/`+/g)) {
    if (m[0].length > max) max = m[0].length;
  }
  return '`'.repeat(max + 1);
}

/** Extract a lowercase fence language from a Notion code block, collapsing plain text to ''. */
function readCodeLanguage(pre: Element, figure: Element | null): string {
  const codeEl = pre.querySelector('code');
  const raw =
    pre.getAttribute('data-notion-code-syntax') ??
    figure?.getAttribute('data-notion-code-syntax') ??
    (/(?:^|\s)language-([A-Za-z0-9+#_-]+)/.exec(codeEl?.getAttribute('class') ?? '')?.[1] ?? '');
  const lang = raw.trim().toLowerCase();
  if (!lang || lang === 'plain text' || lang === 'plaintext' || lang === 'text' || lang === 'none') return '';
  return lang;
}

/** Read Notion's `<table class="properties">` header on database row pages. */
function readPropertiesTable(table: Element): { lines: string[]; tags: string[] } {
  const lines: string[] = [];
  const rawTags: string[] = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const th = tr.querySelector('th');
    const td = tr.querySelector('td');
    if (!th || !td) continue;
    const key = inlineOnly(th.textContent ?? '');
    if (!key) continue;
    const pills = Array.from(td.querySelectorAll('.selected-value'))
      .map((s) => inlineOnly(s.textContent ?? ''))
      .filter(Boolean);
    let value = '';
    if (pills.length > 0) {
      value = pills.map((p) => escapeMarkdownText(p)).join(', ');
      if (/^tags?$/i.test(key)) rawTags.push(...pills);
    } else {
      const cb = td.querySelector('input[type="checkbox"]');
      if (cb) {
        value = cb.hasAttribute('checked') || cb.classList.contains('checkbox-on') ? 'Yes' : 'No';
      } else {
        const a = td.querySelector('a[href]');
        const href = a?.getAttribute('href')?.trim() ?? '';
        const text = inlineOnly(td.textContent ?? '');
        value =
          href && /^(?:https?:\/\/|mailto:)/i.test(href) && !/[\s<>`\x00-\x1f\x7f]/.test(href) && href === text
            ? `<${href}>`
            : escapeMarkdownText(text);
      }
    }
    if (value) lines.push(`${guardMarkdownLineStart(escapeMarkdownText(key))}: ${value}`);
  }
  return { lines, tags: normalizeTagList(rawTags) };
}

/** Convert one Notion HTML export file into title, Markdown body, extracted DB tags, and feature counts. */
export function parseNotionHtml(html: string, opts: NotionHtmlOptions): NotionHtmlResult {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const article = doc.querySelector('article.page') ?? doc.querySelector('article') ?? doc.body;
  const header = article?.querySelector(':scope > header') ?? null;

  const titleEl = header?.querySelector('h1.page-title') ?? article?.querySelector('h1.page-title');
  const title = inlineOnly(titleEl?.textContent ?? '');

  const propTable = header?.querySelector('table.properties') ?? null;
  const { lines: propLines, tags } = propTable ? readPropertiesTable(propTable) : { lines: [], tags: [] };

  const descEl = header?.querySelector('p.page-description') ?? null;
  const description = inlineOnly(descEl?.textContent ?? '');

  const bodyEl = article?.querySelector(':scope > .page-body') ?? article ?? doc.body;

  let callouts = 0;
  let columns = 0;
  let colors = 0;
  let inColumn = false;
  let inlineDepth = 0;
  let linkDepth = 0;

  /** Plain text of an anchor with any leading `.icon` emoji span removed. */
  function anchorPlainText(a: Element): string {
    let out = '';
    for (const child of Array.from(a.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && (child as Element).classList.contains('icon')) continue;
      out += child.textContent ?? '';
    }
    return inlineOnly(out);
  }

  function walkChildren(el: Element, depth: number): string {
    return joinMathSafe(Array.from(el.childNodes).map((c) => walk(c, depth + 1)));
  }

  function walkInline(node: Node, depth: number): string {
    inlineDepth++;
    try {
      return walk(node, depth);
    } finally {
      inlineDepth--;
    }
  }

  function walkChildrenInline(el: Element, depth: number): string {
    inlineDepth++;
    try {
      return walkChildren(el, depth);
    } finally {
      inlineDepth--;
    }
  }

  function resolveFormattedLink(
    href: string,
    label: string,
    plain: string,
    pageId: string | null,
  ): string {
    const safeHref = /^[a-z][a-z0-9+.-]*:/i.test(href) ? formatMarkdownLinkTarget(href) : href;
    if (!safeHref) return label;
    const resolved = opts.resolveLink(safeHref, label, plain, pageId);
    if (safeHref === href && resolved.endsWith(`](${href})`)) {
      const formatted = formatMarkdownLinkTarget(href);
      return formatted ? `${resolved.slice(0, -href.length - 1)}${formatted})` : label;
    }
    return resolved;
  }

  function renderParagraph(el: Element, depth: number): string {
    const inner = walkChildren(el, depth)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!inner) return '';
    const first = Array.from(el.childNodes).find(
      (c) => c.nodeType === Node.ELEMENT_NODE || (c.textContent ?? '').trim(),
    );
    const startsPlain =
      first?.nodeType === Node.TEXT_NODE ||
      (first?.nodeType === Node.ELEMENT_NODE &&
        (first as Element).tagName.toLowerCase() === 'a' &&
        !inner.startsWith('['));
    const guarded = startsPlain ? guardMarkdownLineStart(inner) : inner;
    return `\n\n${guarded}\n\n`;
  }

  function renderCodeBlock(pre: Element, figure: Element | null, depth: number): string {
    const codeEl = pre.querySelector('code') ?? pre;
    const raw = (codeEl.textContent ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '');
    const lang = readCodeLanguage(pre, figure);
    const fence = fenceFor(raw);
    const capEl = figure?.querySelector(':scope > figcaption') ?? null;
    const cap = capEl ? inlineOnly(walkChildrenInline(capEl, depth)) : '';
    const block = `${fence}${lang}\n${raw}\n${fence}`;
    return cap ? `\n${block}\n\n${cap}\n\n` : `\n${block}\n\n`;
  }

  function renderEquationBlock(el: Element): string {
    const raw =
      el.getAttribute('data-notion-equation') ??
      el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ??
      '';
    if (inlineDepth > 0) {
      const inline = sanitizeInlineLatex(raw);
      return inline ? `$${inline}$` : '';
    }
    const latex = sanitizeBlockLatex(raw);
    if (!latex) return '';
    return `\n\n$$\n${latex}\n$$\n\n`;
  }

  function renderTable(table: Element, depth: number): string {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return '';

    const cellsOf = (tr: Element) =>
      Array.from(tr.children)
        .filter((c) => /^(?:td|th)$/i.test(c.tagName))
        .map((c) => {
          const cb = c.querySelector('input[type="checkbox"]');
          if (cb && !inlineOnly(c.textContent ?? '')) {
            return cb.hasAttribute('checked') || cb.classList.contains('checkbox-on') ? 'Yes' : 'No';
          }
          const pills = Array.from(c.querySelectorAll('.selected-value'))
            .map((s) => inlineOnly(s.textContent ?? ''))
            .filter(Boolean);
          const cellText = pills.length > 0
            ? pills.map((p) => escapeMarkdownText(p)).join(', ')
            : inlineOnly(walkChildrenInline(c, depth));
          return escapePipeCell(cellText);
        });

    const grid = rows.map(cellsOf).filter((r) => r.length > 0);
    if (grid.length === 0) return '';
    const width = Math.max(...grid.map((r) => r.length));
    const pad = (r: string[]) => {
      const copy = [...r];
      while (copy.length < width) copy.push(' ');
      return copy;
    };

    const firstIsHeader = rows[0]!.querySelector('th') !== null || table.querySelector('thead') !== null;
    const headerRow = firstIsHeader ? pad(grid[0]!) : new Array<string>(width).fill(' ');
    const bodyRows = (firstIsHeader ? grid.slice(1) : grid).map(pad);

    const lines = [
      `| ${headerRow.join(' | ')} |`,
      `| ${new Array<string>(width).fill('---').join(' | ')} |`,
      ...bodyRows.map((r) => `| ${r.join(' | ')} |`),
    ];
    return `\n${lines.join('\n')}\n\n`;
  }

  function renderCallout(el: Element, depth: number): string {
    const iconAttr = el.getAttribute('data-notion-callout-icon')?.trim() ?? '';
    const iconSpan = el.querySelector('.icon[data-emoji]');
    const emoji = iconAttr || iconSpan?.getAttribute('data-emoji')?.trim() || '';
    const keyword = opts.resolveCalloutType(emoji);
    callouts++;

    const children = Array.from(el.children);
    // Notion HTML callouts have two flex divs: [0] icon wrapper, [1] content wrapper.
    const bodyContainer = children.length >= 2 && children[0]!.querySelector('.icon')
      ? children[1]!
      : el;

    // Collect leading inline nodes (before the first block child) as the first paragraph.
    const parts: string[] = [];
    let inlineBuf = '';
    const flushInline = () => {
      const t = inlineBuf.replace(/[ \t]+\n/g, '\n').trim();
      inlineBuf = '';
      if (t) parts.push(t);
    };
    for (const child of Array.from(bodyContainer.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const cEl = child as Element;
        const cTag = cEl.tagName.toLowerCase();
        if (cEl.classList.contains('icon')) continue;
        if (/^(?:p|div|ul|ol|blockquote|pre|figure|table|hr|aside|details|h[1-6])$/.test(cTag)) {
          flushInline();
          const b = walk(cEl, depth + 1).replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
          if (b) parts.push(b);
          continue;
        }
      }
      inlineBuf = appendMathSafe(inlineBuf, walk(child, depth + 1));
    }
    flushInline();

    const content = parts.join('\n\n').trim();
    if (!content) return `\n> [!${keyword}]+\n\n`;
    const quoted = content.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
    return `\n> [!${keyword}]+\n${quoted}\n\n`;
  }

  function renderDetails(el: Element, depth: number): string {
    const summary = el.querySelector(':scope > summary');
    const summaryHeading = summary?.querySelector('h1, h2, h3, h4, h5, h6') ?? null;

    const restNodes = Array.from(el.childNodes).filter((n) => n !== summary);
    const innerBody = joinMathSafe(restNodes.map((n) => walk(n, depth + 1)))
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Toggle heading (`<details><summary><h2>...</h2></summary>...`): emit heading + body.
    if (summaryHeading) {
      const level = Number(summaryHeading.tagName.slice(1));
      const hText = inlineOnly(walkChildrenInline(summaryHeading, depth + 1));
      const head = `${'#'.repeat(level)} ${hText}`;
      return innerBody ? `\n${head}\n\n${innerBody}\n\n` : `\n${head}\n\n`;
    }

    const titleText = summary ? inlineOnly(walkChildrenInline(summary, depth + 1)) : '';
    const marker = el.hasAttribute('open') ? '+' : '-';
    const head = `> [!fold]${marker}${titleText ? ` ${titleText}` : ''}`;
    if (!innerBody) return `\n${head}\n\n`;
    const quoted = innerBody.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
    return `\n${head}\n${quoted}\n\n`;
  }

  function onlyWhitespaceBetween(a: Element, b: Element): boolean {
    for (let cur = a.nextSibling; cur && cur !== b; cur = cur.nextSibling) {
      if (cur.nodeType === Node.ELEMENT_NODE) return false;
      if (cur.nodeType === Node.TEXT_NODE && (cur.textContent ?? '').trim()) return false;
    }
    return true;
  }

  function hasListItems(listEl: Element): boolean {
    return Array.from(listEl.children).some((c) => c.tagName.toLowerCase() === 'li');
  }

  function renderList(el: Element, indent: string, depth: number): string {
    const isTodo = el.classList.contains('to-do-list');
    const ordered = el.tagName.toLowerCase() === 'ol';
    const items = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'li');
    if (items.length === 0) return '';

    let n = orderedListStart(el.getAttribute('start'), items.length);

    const lines: string[] = [];
    for (const li of items) {
      let marker: string;
      if (isTodo) {
        const cb = li.querySelector(':scope > input[type="checkbox"]');
        const checked = cb ? cb.hasAttribute('checked') || cb.classList.contains('checkbox-on') : false;
        marker = checked ? '- [x] ' : '- [ ] ';
      } else if (ordered) {
        marker = `${n++}. `;
      } else {
        marker = '- ';
      }

      const subIndent = indent + (!isTodo && ordered ? ' '.repeat(Math.max(4, marker.length)) : '    ');
      const nested: string[] = [];
      let inline = '';

      const collectLiNodes = (nodes: Node[]) => {
        for (const child of nodes) {
          if (child.nodeType === Node.ELEMENT_NODE) {
            const cEl = child as Element;
            const cTag = cEl.tagName.toLowerCase();
            if (cTag === 'input' && cEl.getAttribute('type') === 'checkbox') continue;
            if (cTag === 'ul' || cTag === 'ol') {
              const sub = renderList(cEl, subIndent, depth + 1).replace(/\n+$/, '');
              if (sub) {
                const hasPreceding = Boolean(inlineOnly(inline)) || nested.length > 0;
                nested.push(hasPreceding && sublistNeedsBlankLine(sub) ? `\n${sub}` : sub);
              }
              continue;
            }
            if (cTag === 'div' && cEl.classList.contains('indented')) {
              collectLiNodes(Array.from(cEl.childNodes));
              continue;
            }
            if (/^(?:p|blockquote|pre|figure|table|aside|details|div)$/.test(cTag)) {
              const block = walk(cEl, depth + 1).replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
              if (block) {
                nested.push(block.split('\n').map((l) => (l ? subIndent + l : l)).join('\n'));
              }
              continue;
            }
          }
          inline = appendMathSafe(inline, walkInline(child, depth + 1));
        }
      };

      collectLiNodes(Array.from(li.childNodes));
      lines.push(`${indent}${marker}${inlineOnly(inline)}`);
      for (const b of nested) lines.push(b);
    }

    // Notion emits each top-level numbered or to-do item as its own sibling <ol>/<ul>.
    // Join consecutive same-kind sibling lists with a single newline so they stay one list.
    const prev = el.previousElementSibling;
    const sameKindPrev =
      indent === '' &&
      prev !== null &&
      prev.tagName === el.tagName &&
      prev.classList.contains('to-do-list') === isTodo &&
      hasListItems(prev) &&
      onlyWhitespaceBetween(prev, el);
    const next = el.nextElementSibling;
    const sameKindNext =
      indent === '' &&
      next !== null &&
      next.tagName === el.tagName &&
      next.classList.contains('to-do-list') === isTodo &&
      hasListItems(next) &&
      onlyWhitespaceBetween(el, next);
    const prefix = indent === '' && !sameKindPrev ? (sublistNeedsBlankLine(lines[0]!) ? '\n\n' : '\n') : '';
    return `${prefix}${lines.join('\n')}${sameKindNext ? '\n' : '\n\n'}`;
  }

  function renderColumnList(el: Element, depth: number): string {
    const colEls = Array.from(el.children).filter((c) => c.classList.contains('column'));
    if (colEls.length < 2 || inColumn) {
      // Nested column-list or degenerate 1-column wrapper: flatten in reading order so no text is lost.
      const flat = joinMathSafe(colEls.map((c) => walkChildren(c, depth))).replace(/\n{3,}/g, '\n\n').trim();
      return flat ? `\n\n${flat}\n\n` : '';
    }

    const prevInColumn = inColumn;
    inColumn = true;
    const rendered: { body: string; ratio: number }[] = [];
    try {
      for (const colEl of colEls) {
        const colBody = walkChildren(colEl, depth).replace(/\n{3,}/g, '\n\n').trim();
        rendered.push({ body: colBody, ratio: readColumnRatio(colEl) });
      }
    } finally {
      inColumn = prevInColumn;
    }

    // Cap at MAX_COLUMNS (5): append any overflow columns' content into column 5 so zero text is lost.
    let kept = rendered;
    let wasEqualBeforeCap = columnWeightsFromRatios(rendered.map((c) => c.ratio)) === null;
    if (rendered.length > MAX_COLUMNS) {
      const head = rendered.slice(0, MAX_COLUMNS).map((c) => ({ ...c }));
      const tail = rendered.slice(MAX_COLUMNS);
      const extraBodies = tail.map((c) => c.body).filter(Boolean);
      if (extraBodies.length > 0) {
        head[MAX_COLUMNS - 1]!.body = [head[MAX_COLUMNS - 1]!.body, ...extraBodies].filter(Boolean).join('\n\n');
      }
      if (!wasEqualBeforeCap) {
        head[MAX_COLUMNS - 1]!.ratio += tail.reduce((s, c) => s + c.ratio, 0);
      }
      kept = head;
    }

    const weights = wasEqualBeforeCap ? null : columnWeightsFromRatios(kept.map((c) => c.ratio));
    const blocks = kept.map((col, idx) => {
      const w = weights ? weights[idx]! : null;
      const colHead = w !== null ? `> > [!col|${w}]+` : '> > [!col]+';
      const inner = col.body || '&nbsp;';
      const lines = inner.split('\n').map((l) => (l.length > 0 ? `> > ${l}` : '> >'));
      return [colHead, ...lines].join('\n');
    });

    columns++;
    return `\n> [!columns]+\n${blocks.join('\n>\n')}\n\n`;
  }

  function renderFigure(el: Element, depth: number): string {
    // 1. Block equation
    if (el.classList.contains('equation') || el.hasAttribute('data-notion-equation')) {
      return renderEquationBlock(el);
    }

    // 2. Code block wrapped in <figure> with optional <figcaption>
    const pre = el.querySelector(':scope > pre');
    if (pre) return renderCodeBlock(pre, el, depth);

    // 3. Link-to-page card
    if (el.classList.contains('link-to-page')) {
      const a = el.querySelector('a[href]');
      if (!a) return '';
      const href = a.getAttribute('href')?.trim() ?? '';
      if (!href || isUnsafeUrl(href)) return '';
      const plain = anchorPlainText(a) || href;
      if (linkDepth > 0) return ` ${escapeMarkdownText(plain)} `;
      const pageId = normalizeUuid(a.getAttribute('data-notion-page-id'));
      const resolved = resolveFormattedLink(href, escapeMarkdownText(plain), plain, pageId);
      return resolved ? `\n\n${resolved}\n\n` : '';
    }

    // 4. Image figure
    const img = el.querySelector('img');
    if (el.classList.contains('image') || el.hasAttribute('data-notion-image') || img) {
      const src = (img?.getAttribute('src') ?? el.getAttribute('data-notion-image') ?? '').trim();
      const safeSrc = !src || isUnsafeUrl(src) ? '' : formatMarkdownLinkTarget(src);
      if (!safeSrc) return '';
      const capEl = el.querySelector(':scope > figcaption');
      const alt = (capEl ? inlineOnly(capEl.textContent ?? '') : '') || img?.getAttribute('alt')?.trim() || fileBasename(src);
      return `\n\n![${alt.replace(/[[\]]/g, '')}](${safeSrc})\n\n`;
    }

    // 5. Bookmark card
    const bookmark = el.querySelector('a.bookmark[href]');
    if (bookmark) {
      const href = bookmark.getAttribute('href')?.trim() ?? '';
      const safeHref = !href || isUnsafeUrl(href) ? '' : formatMarkdownLinkTarget(href);
      if (!safeHref) return '';
      const titleNode = bookmark.querySelector('.bookmark-title');
      const label = inlineOnly(titleNode?.textContent ?? '') || href;
      if (linkDepth > 0) return ` ${escapeMarkdownText(label)} `;
      return `\n\n[${escapeMarkdownText(label)}](${safeHref})\n\n`;
    }

    // 6. Attached file card (`<div class="source"><a data-notion-file="...">`)
    const fileLink = el.querySelector('a[data-notion-file], .source > a[href]');
    if (fileLink) {
      const href = (fileLink.getAttribute('href') ?? fileLink.getAttribute('data-notion-file') ?? '').trim();
      const safeHref = !href || isUnsafeUrl(href) ? '' : formatMarkdownLinkTarget(href);
      if (!safeHref) return '';
      const label =
        fileLink.getAttribute('data-notion-file-alias')?.trim() ||
        inlineOnly(fileLink.textContent ?? '') ||
        fileBasename(href);
      if (linkDepth > 0) return ` ${escapeMarkdownText(label)} `;
      return `\n\n[${escapeMarkdownText(label)}](${safeHref})\n\n`;
    }

    const fallback = walkChildren(el, depth).replace(/\n{3,}/g, '\n\n').trim();
    return fallback ? `\n\n${fallback}\n\n` : '';
  }

  function renderHighlightMark(el: Element, depth: number): string {
    const inner = walkChildrenInline(el, depth);
    if (!inner.trim()) return inner;
    const [, , core = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner) ?? [];
    if (!core || containsMarkdownBlock(core)) return inner;
    const raw = readNotionHighlight(el);
    if (!raw) {
      return shouldUseHtmlMark(core) ? wrapRun(inner, '<mark>', '</mark>') : wrapRun(inner, '==', '==');
    }
    if (raw === 'default' || raw === 'default_background') return inner;

    const isBg = raw.endsWith('_background');
    const base = isBg ? raw.slice(0, -'_background'.length) : raw;
    const paletteName = Object.hasOwn(NOTION_COLOR_NAME, base) ? NOTION_COLOR_NAME[base]! : null;
    if (!paletteName) return inner;

    if (isBg) {
      const hl = Object.hasOwn(HIGHLIGHT_BY_NAME, paletteName) ? HIGHLIGHT_BY_NAME[paletteName]! : DEFAULT_HIGHLIGHT;
      colors++;
      return hl.value
        ? wrapRun(inner, `<mark style="background-color: ${hl.value}">`, '</mark>')
        : shouldUseHtmlMark(core)
          ? wrapRun(inner, '<mark>', '</mark>')
          : wrapRun(inner, '==', '==');
    }
    const textHex = Object.hasOwn(TEXT_COLOR_BY_NAME, paletteName) ? TEXT_COLOR_BY_NAME[paletteName]! : null;
    if (!textHex) return inner;
    colors++;
    return wrapRun(inner, `<span style="color: ${textHex}">`, '</span>');
  }

  function walk(node: Node, depth: number): string {
    if (depth > MAX_HTML_DEPTH) return escapeMarkdownText(node.textContent ?? '');
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeMarkdownText(node.textContent ?? '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return '';

    // Inline math token (`<span data-notion-inline-equation="E = mc^2">`)
    if (el.hasAttribute('data-notion-inline-equation')) {
      const latex = sanitizeInlineLatex(
        el.getAttribute('data-notion-inline-equation') ||
          el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ||
          '',
      );
      return latex ? `$${latex}$` : '';
    }

    // Column layout
    if (tag === 'div' && (el.classList.contains('column-list') || el.hasAttribute('data-notion-column-list'))) {
      return renderColumnList(el, depth);
    }

    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Number(tag.slice(1));
        const text = inlineOnly(walkChildrenInline(el, depth));
        return text ? `\n${'#'.repeat(level)} ${text}\n\n` : '';
      }
      case 'p':
        return renderParagraph(el, depth);
      case 'br':
        return '\n';
      case 'hr':
        return '\n---\n\n';
      case 'strong':
      case 'b':
        return wrapRun(walkChildrenInline(el, depth), '**', '**');
      case 'em':
      case 'i':
        return wrapRun(walkChildrenInline(el, depth), '*', '*');
      case 'del':
      case 's':
      case 'strike':
        return wrapRun(walkChildrenInline(el, depth), '~~', '~~');
      case 'u':
        return wrapRun(walkChildrenInline(el, depth), '<u>', '</u>');
      case 'code':
        return markdownCodeSpan(el.textContent ?? '');
      case 'mark':
        return renderHighlightMark(el, depth);
      case 'span': {
        if (el.classList.contains('icon')) return '';
        const inner = walkChildrenInline(el, depth);
        return isUnderlineSpan(el) ? wrapRun(inner, '<u>', '</u>') : inner;
      }
      case 'a': {
        const href = el.getAttribute('href')?.trim() ?? '';
        const plain = anchorPlainText(el);
        if (!href || isUnsafeUrl(href) || linkDepth > 0) {
          return inlineOnly(walkChildrenInline(el, depth)) || escapeMarkdownText(plain || href);
        }
        linkDepth++;
        let inner = '';
        try {
          inner = inlineOnly(walkChildrenInline(el, depth));
        } finally {
          linkDepth--;
        }
        const pageId = normalizeUuid(el.getAttribute('data-notion-page-id'));
        return resolveFormattedLink(href, inner || escapeMarkdownText(plain || href), plain || href, pageId);
      }
      case 'img': {
        const src = el.getAttribute('src')?.trim() ?? '';
        const safeSrc = !src || isUnsafeUrl(src) ? '' : formatMarkdownLinkTarget(src);
        if (!safeSrc) return '';
        const alt = el.getAttribute('alt')?.trim() || fileBasename(src);
        return `![${alt.replace(/[[\]]/g, '')}](${safeSrc})`;
      }
      case 'ul':
      case 'ol':
        return renderList(el, '', depth);
      case 'blockquote': {
        const parts: string[] = [];
        let inlineBuf = '';
        const flush = () => {
          const t = inlineBuf.replace(/[ \t]+\n/g, '\n').trim();
          inlineBuf = '';
          if (t) parts.push(t);
        };
        for (const child of Array.from(el.childNodes)) {
          if (child.nodeType === Node.ELEMENT_NODE) {
            const cTag = (child as Element).tagName.toLowerCase();
            if (/^(?:p|div|ul|ol|blockquote|pre|figure|table|hr|aside|details|h[1-6])$/.test(cTag)) {
              flush();
              const b = walk(child, depth + 1).replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
              if (b) parts.push(b);
              continue;
            }
          }
          inlineBuf = appendMathSafe(inlineBuf, walk(child, depth + 1));
        }
        flush();
        const content = parts.join('\n\n').trim();
        if (!content) return '';
        return `\n${content.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n')}\n\n`;
      }
      case 'pre':
        return renderCodeBlock(el, null, depth);
      case 'aside':
        return renderCallout(el, depth);
      case 'details':
        return renderDetails(el, depth);
      case 'figure':
        return renderFigure(el, depth);
      case 'figcaption':
        return walkChildrenInline(el, depth);
      case 'table':
        return renderTable(el, depth);
      case 'header':
        return '';
      default:
        return walkChildren(el, depth);
    }
  }

  const parts: string[] = [];
  if (propLines.length > 0) parts.push(propLines.join('\n'));
  if (description) parts.push(guardMarkdownLineStart(escapeMarkdownText(description)));
  const renderedBody = bodyEl ? walkChildren(bodyEl, 0).replace(/\n{3,}/g, '\n\n').trim() : '';
  if (renderedBody) parts.push(renderedBody);

  return {
    title,
    body: parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
    tags,
    callouts,
    columns,
    colors,
  };
}
