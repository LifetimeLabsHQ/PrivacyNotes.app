/**
 * Fallback A4 sheet paginator for browsers that do not implement CSS Paged
 * Media `@page` margin boxes (`@bottom-center`, etc.) - currently Firefox
 * (Gecko, Mozilla Bug 286443), Safari (WebKit, Bug 85062), Linux WebKitGTK,
 * and Chromium < 131.
 *
 * Chrome 131+, Edge, Brave, Arc, and Windows WebView2 support `@page` margin
 * boxes natively (`supportsPageMarginBoxes() === true`) and macOS/iOS native
 * apps draw page numbers in AppKit/UIKit (`print.rs`), so this module never
 * touches those paths.
 */

import { formatPageNumber, type PageNumbersSetting } from './pageNumbers';

// 248mm total sheet height fits inside both US Letter (279.4mm, ~254mm
// printable with Safari/WebKitGTK default 0.5in margins) and A4 (297mm, ~271mm
// printable) without ever spilling a sheet's footer onto an extra blank page.
const SHEET_HEIGHT_MM = 248;
const SHEET_BODY_HEIGHT_MM = 212;
const FALLBACK_BODY_HEIGHT_PX = 801; // 212mm at 96dpi, for non-layout test environments
const MIN_HEADING_TAIL_PX = 52; // keep headings with at least ~3 lines of following text

/**
 * Feature-detect CSS `@page` margin-box support via CSSOM (zero UA sniffing).
 * Engines that do not implement `@page` margin boxes strip `@bottom-center`
 * at CSS parse time, leaving `pageRule.cssRules.length === 0`.
 */
export function supportsPageMarginBoxes(): boolean {
  try {
    if (typeof CSSStyleSheet === 'undefined') return false;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('@page { @bottom-center { content: "x"; } }');
    const rule = sheet.cssRules[0] as CSSGroupingRule | undefined;
    return Boolean(rule && 'cssRules' in rule && rule.cssRules.length > 0);
  } catch {
    return false;
  }
}

/**
 * Split syntax-highlighted `<code>` HTML into standalone per-line HTML strings,
 * closing any open `<span>` tags at line end and re-opening them on the next
 * line so a `<pre>` split across printed sheets stays valid HTML.
 */
function splitHighlightedLines(codeHtml: string): string[] {
  const rawLines = codeHtml.split('\n');
  const openTags: string[] = [];
  const out: string[] = [];
  const tagRe = /<(\/?)span\b[^>]*>/gi;
  for (const line of rawLines) {
    const prefix = openTags.join('');
    let m: RegExpExecArray | null;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(line)) !== null) {
      if (m[1] === '/') {
        openTags.pop();
      } else {
        openTags.push(m[0]);
      }
    }
    const suffix = '</span>'.repeat(openTags.length);
    out.push(prefix + line + suffix);
  }
  return out;
}

function measureMmPx(doc: Document, mm: number): number {
  const probe = doc.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.height = `${mm}mm`;
  probe.style.width = '1px';
  doc.body.appendChild(probe);
  // Prefer `offsetHeight` over `getBoundingClientRect().height`: in WebKit/Safari
  // when pageZoom != 1, `getBoundingClientRect()` inside an off-screen iframe is
  // scaled by 1/pageZoom while `scrollHeight` and `offsetHeight` stay in matching
  // layout pixels.
  const h = probe.offsetHeight || probe.getBoundingClientRect().height;
  probe.remove();
  return h > 0 ? h : FALLBACK_BODY_HEIGHT_PX;
}

function cloneShallow(doc: Document, el: Element): HTMLElement {
  return doc.importNode(el.cloneNode(false), false) as HTMLElement;
}

function isHeading(el: Element): boolean {
  return /^H[1-6]$/.test(el.tagName);
}

/**
 * Reflow a standalone print `iframeDoc` into fixed A4 `.pn-print-sheet` boxes,
 * each carrying a real `.pn-print-footer` page number (`1 / N` or `N`).
 * Called by `printNote()` only when page numbers are enabled AND the engine
 * lacks CSS `@page` margin-box support.
 */
export function paginateDocumentForPrint(doc: Document, setting: PageNumbersSetting): number {
  if (setting.placement === 'off' || !setting.print) return 0;
  const origPage = doc.querySelector('.page');
  const origArticle = origPage?.querySelector('article.content');
  if (!origPage || !origArticle) return 0;

  // Open folded callouts before measuring so they measure and print expanded
  // on engines without CSS `::details-content` support.
  for (const d of origPage.querySelectorAll('details.pn-callout')) {
    d.setAttribute('open', '');
  }

  const align = setting.placement === 'left' ? 'left' : setting.placement === 'right' ? 'right' : 'center';
  const style = doc.createElement('style');
  style.setAttribute('data-pn-print-fallback', '');
  style.textContent = `
    @page {
      margin: 0;
    }
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      background: #ffffff !important;
      color: #4a4a4a !important;
      font-size: 10pt !important;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    /* Fixed physical width (210mm / 174mm body) during screen measurement so
       Safari cannot collapse width: 100% to 0-150px inside a newly written
       off-screen iframe before first paint (which wrapped text one word per
       line and exploded a 2-page note into 15 pages). Under @media print the
       sheet switches to responsive 100% up to 210mm so it fits both A4 and
       US Letter with default browser margins cleanly. */
    .pn-print-sheet {
      position: relative;
      width: 210mm;
      height: ${SHEET_HEIGHT_MM}mm;
      padding: 14mm 18mm 16mm 18mm;
      margin: 0 auto;
      box-sizing: border-box;
      background: #ffffff;
      overflow: hidden;
      page-break-after: always;
      break-after: page;
    }
    .pn-print-sheet:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .pn-print-sheet--oversized {
      height: auto;
      min-height: ${SHEET_HEIGHT_MM}mm;
      overflow: visible;
    }
    .pn-sheet-body {
      width: 174mm;
      margin: 0;
      padding: 0;
    }
    @media print {
      .pn-print-sheet {
        width: 100%;
        max-width: 210mm;
      }
      .pn-sheet-body {
        width: 100%;
      }
    }
    .pn-sheet-body img {
      max-height: 180mm;
      width: auto;
      height: auto;
    }
    .pn-sheet-body .content {
      padding-inline: 1px;
    }
    .pn-sheet-body .content pre:not(.pn-copybox) {
      white-space: pre-wrap;
      overflow-wrap: break-word;
      overflow-x: visible;
    }
    .pn-sheet-body .content pre:not(.pn-copybox) code {
      white-space: pre-wrap;
      overflow-wrap: break-word;
    }
    .pn-print-footer {
      position: absolute;
      left: 18mm;
      right: 18mm;
      bottom: 6mm;
      text-align: ${align};
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 9pt;
      line-height: 1;
      color: #6a6a6a;
      font-variant-numeric: tabular-nums;
    }
  `;
  doc.head.appendChild(style);

  const maxBodyPx = measureMmPx(doc, SHEET_BODY_HEIGHT_MM);
  const header = origPage.querySelector('header.note-head');
  const trackers = origPage.querySelector('section.trackers');
  const queue: Element[] = Array.from(origArticle.children);
  origPage.remove();

  const sheets: HTMLElement[] = [];
  let currentSheet!: HTMLElement;
  let currentBody!: HTMLElement;
  let currentArticle!: HTMLElement;

  const openSheet = (first: boolean) => {
    const sheet = doc.createElement('section');
    sheet.className = 'pn-print-sheet';
    const body = doc.createElement('div');
    body.className = 'pn-sheet-body';
    if (first) {
      if (header) body.appendChild(header);
      if (trackers) body.appendChild(trackers);
    }
    const article = doc.createElement('article');
    article.className = 'content';
    body.appendChild(article);
    sheet.appendChild(body);
    doc.body.appendChild(sheet);
    sheets.push(sheet);
    currentSheet = sheet;
    currentBody = body;
    currentArticle = article;
  };

  const fits = () => currentBody.scrollHeight <= maxBodyPx + 0.5;
  const sheetHasContent = () =>
    currentArticle.children.length > 0 || currentBody.children.length > 1;

  const trySplitTable = (table: HTMLTableElement): boolean => {
    const tbody = table.tBodies[0];
    const rows = tbody ? Array.from(tbody.rows) : [];
    if (!tbody || rows.length < 2) return false;

    const makeTableShell = () => {
      const shell = cloneShallow(doc, table) as HTMLTableElement;
      const colgroup = table.querySelector(':scope > colgroup');
      if (colgroup) shell.appendChild(colgroup.cloneNode(true));
      if (table.tHead) shell.appendChild(table.tHead.cloneNode(true));
      const nextBody = doc.createElement('tbody');
      shell.appendChild(nextBody);
      return { shell, nextBody };
    };

    const { shell, nextBody } = makeTableShell();
    currentArticle.appendChild(shell);
    let placed = 0;
    for (const row of rows) {
      nextBody.appendChild(row);
      if (!fits()) {
        row.remove();
        break;
      }
      placed++;
    }
    if (placed === 0) {
      shell.remove();
      // Restore detached rows back into original tbody
      for (const row of rows) tbody.appendChild(row);
      return false;
    }
    const remaining = rows.slice(placed);
    if (remaining.length > 0) {
      const { shell: restTable, nextBody: restBody } = makeTableShell();
      for (const row of remaining) restBody.appendChild(row);
      queue.unshift(restTable);
      openSheet(false);
    }
    return true;
  };

  const trySplitList = (list: HTMLElement): boolean => {
    const items = Array.from(list.children).filter((c) => c.tagName === 'LI');
    if (items.length < 2) return false;

    const startAttr = list.tagName === 'OL' ? Number(list.getAttribute('start') ?? '1') : 1;
    const baseStart = Number.isFinite(startAttr) ? startAttr : 1;

    const headList = cloneShallow(doc, list);
    currentArticle.appendChild(headList);
    let placed = 0;
    for (const item of items) {
      headList.appendChild(item);
      if (!fits()) {
        item.remove();
        break;
      }
      placed++;
    }
    if (placed === 0) {
      headList.remove();
      for (const item of items) list.appendChild(item);
      return false;
    }
    const remaining = items.slice(placed);
    if (remaining.length > 0) {
      const restList = cloneShallow(doc, list);
      if (restList.tagName === 'OL') {
        restList.setAttribute('start', String(baseStart + placed));
      }
      for (const item of remaining) restList.appendChild(item);
      queue.unshift(restList);
      openSheet(false);
    }
    return true;
  };

  const trySplitPre = (pre: HTMLElement): boolean => {
    const code = pre.querySelector(':scope > code');
    if (!code) return false;
    const lines = splitHighlightedLines(code.innerHTML);
    if (lines.length < 4) return false;

    const makePreShell = (includeHeader: boolean) => {
      const shell = cloneShallow(doc, pre);
      if (includeHeader) {
        for (const child of Array.from(pre.children)) {
          if (child !== code) shell.appendChild(child.cloneNode(true));
        }
      }
      const nextCode = cloneShallow(doc, code);
      shell.appendChild(nextCode);
      return { shell, nextCode };
    };

    const { shell, nextCode } = makePreShell(true);
    currentArticle.appendChild(shell);
    // Binary search for the largest prefix of lines that fits cleanly on this sheet.
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      nextCode.innerHTML = lines.slice(0, mid).join('\n');
      if (fits()) lo = mid;
      else hi = mid - 1;
    }
    if (lo < 3) {
      shell.remove();
      return false;
    }
    nextCode.innerHTML = lines.slice(0, lo).join('\n');
    const restLines = lines.slice(lo);
    if (restLines.length > 0) {
      const { shell: restPre, nextCode: restCode } = makePreShell(false);
      restCode.innerHTML = restLines.join('\n');
      queue.unshift(restPre);
      openSheet(false);
    }
    return true;
  };

  openSheet(true);

  while (queue.length > 0) {
    const el = queue.shift()!;
    currentArticle.appendChild(el);
    if (fits()) {
      // Avoid stranding a heading alone at the very bottom of a page.
      if (
        isHeading(el) &&
        queue.length > 0 &&
        maxBodyPx - currentBody.scrollHeight < MIN_HEADING_TAIL_PX &&
        (currentArticle.children.length > 1 || currentBody.children.length > 1)
      ) {
        el.remove();
        openSheet(false);
        currentArticle.appendChild(el);
      }
      continue;
    }

    el.remove();

    // Try splitting tables, lists, and long code blocks in place first.
    if (el.tagName === 'TABLE' && trySplitTable(el as HTMLTableElement)) continue;
    if ((el.tagName === 'UL' || el.tagName === 'OL') && trySplitList(el as HTMLElement)) continue;
    if (el.tagName === 'PRE' && trySplitPre(el as HTMLElement)) continue;

    // Unwrap multi-block vault-notes wrappers so their inner markdown blocks flow cleanly.
    if (el.classList.contains('vault-notes')) {
      const label = el.querySelector(':scope > strong');
      const bodyWrap = el.querySelector(':scope > .vault-notes-body');
      if (bodyWrap && bodyWrap.children.length > 1) {
        const inner = Array.from(bodyWrap.children);
        const unwrapped: Element[] = [];
        if (label) {
          const head = doc.createElement('div');
          head.className = 'vault-notes';
          head.appendChild(label);
          unwrapped.push(head);
        }
        unwrapped.push(...inner);
        queue.unshift(...unwrapped);
        continue;
      }
    }

    if (sheetHasContent()) {
      openSheet(false);
      queue.unshift(el);
      continue;
    }

    // Single atomic element taller than a full sheet: place it without clipping.
    currentArticle.appendChild(el);
    currentSheet.classList.add('pn-print-sheet--oversized');
  }

  // Drop a trailing empty sheet if a split opened one with nothing left to place.
  if (sheets.length > 1 && currentArticle.children.length === 0 && currentBody.children.length === 1) {
    sheets.pop()!.remove();
  }

  const total = sheets.length;
  for (let i = 0; i < total; i++) {
    const footer = doc.createElement('footer');
    footer.className = 'pn-print-footer';
    footer.textContent = formatPageNumber(i + 1, total, setting.format);
    sheets[i]!.appendChild(footer);
  }

  return total;
}
