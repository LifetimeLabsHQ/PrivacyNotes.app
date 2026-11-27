/**
 * Page numbers across Full screen, the note editor footer, and print/HTML
 * export (GitHub #944).
 *
 * Notes are continuous Markdown, so nothing is written into the body:
 *   - Print & PDF / exported HTML draw real paper page numbers through CSS
 *     `@page` bottom margin boxes.
 *   - Full screen and the editor footer count honest screen-pages from the
 *     scroll container's height at the active zoom level.
 *
 * Synced in `UserSettings.pageNumbers` so a person's print and reading setup
 * follows them across devices, like `lineSpacing` and `nestedNumbers`.
 */

export const PAGE_NUMBERS_PLACEMENTS = ['off', 'left', 'center', 'right'] as const;
export type PageNumbersPlacement = (typeof PAGE_NUMBERS_PLACEMENTS)[number];

export const PAGE_NUMBERS_FORMATS = ['of', 'number'] as const;
export type PageNumbersFormat = (typeof PAGE_NUMBERS_FORMATS)[number];

export type PageNumbersSetting = {
  placement: PageNumbersPlacement;
  format: PageNumbersFormat;
  print: boolean;
  fullScreen: boolean;
  editor: boolean;
};

export function defaultPageNumbers(): PageNumbersSetting {
  return {
    placement: 'center',
    format: 'of',
    print: true,
    fullScreen: true,
    editor: true,
  };
}

export function readPageNumbers(raw: unknown): PageNumbersSetting {
  const base = defaultPageNumbers();
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.placement === 'string' && (PAGE_NUMBERS_PLACEMENTS as readonly string[]).includes(obj.placement)) {
    base.placement = obj.placement as PageNumbersPlacement;
  }
  if (typeof obj.format === 'string' && (PAGE_NUMBERS_FORMATS as readonly string[]).includes(obj.format)) {
    base.format = obj.format as PageNumbersFormat;
  }
  if (typeof obj.print === 'boolean') base.print = obj.print;
  if (typeof obj.fullScreen === 'boolean') base.fullScreen = obj.fullScreen;
  if (typeof obj.editor === 'boolean') base.editor = obj.editor;
  return base;
}

export function formatPageNumber(current: number, total: number, format: PageNumbersFormat): string {
  const safeTotal = Math.max(1, Math.floor(total));
  const safeCurrent = Math.min(safeTotal, Math.max(1, Math.floor(current)));
  return format === 'number' ? String(safeCurrent) : `${safeCurrent} / ${safeTotal}`;
}

export function nextPageNumbersPlacement(current: PageNumbersPlacement): PageNumbersPlacement {
  const index = PAGE_NUMBERS_PLACEMENTS.indexOf(current);
  return PAGE_NUMBERS_PLACEMENTS[(index + 1) % PAGE_NUMBERS_PLACEMENTS.length] ?? 'off';
}

/**
 * Footer quick-toggle transition (#944): turning on from `off` defaults to
 * bottom center; turning off hides the editor footer without discarding a
 * chosen left/right placement or print setting.
 */
export function toggleEditorPageNumbersSetting(current: PageNumbersSetting): PageNumbersSetting {
  if (current.placement !== 'off' && current.editor) {
    return { ...current, editor: false };
  }
  return {
    ...current,
    placement: current.placement === 'off' ? 'center' : current.placement,
    editor: true,
  };
}

export type ScrollPage = { current: number; total: number };

/**
 * Compute the current screen-page and total screen-pages from a scroll
 * container's geometry. Advances once the reader scrolls roughly a third of
 * the way into the next screen, and snaps cleanly to the final page at the
 * bottom so rounding never leaves `4 / 5` stuck at the end.
 */
export function computeScrollPage(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): ScrollPage {
  if (!Number.isFinite(clientHeight) || clientHeight <= 0 || !Number.isFinite(scrollHeight)) {
    return { current: 1, total: 1 };
  }
  if (scrollHeight <= clientHeight + 2) {
    return { current: 1, total: 1 };
  }
  const total = Math.max(1, Math.ceil(scrollHeight / clientHeight));
  const safeTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  if (safeTop + clientHeight >= scrollHeight - 2) {
    return { current: total, total };
  }
  const current = Math.min(total, Math.max(1, Math.floor((safeTop + clientHeight * 0.35) / clientHeight) + 1));
  return { current, total };
}

/**
 * Emit the top-level `@page` rule and print `.page` rule for
 * `buildNoteHtmlDocument` in `export.ts`.
 *
 * `@page` is emitted at top level (never nested inside `@media print`) and
 * uses a concrete sans stack rather than `var(--pn-sans)`, because CSS Paged
 * Media does not inherit `:root` custom properties into `@page` margin boxes.
 *
 * When off, preserves the historical `margin: 0` + `.page { padding: 20mm }`
 * rule so browser default headers/footers stay suppressed. When on, moves the
 * 20mm print margin onto `@page`, clears the unused margin boxes so browsers
 * do not print URLs or dates, and places the page counter in the chosen bottom
 * margin box.
 */
export function pageNumbersPrintCss(setting: PageNumbersSetting): string {
  if (setting.placement === 'off' || !setting.print) {
    return `  @page {
    size: A4;
    margin: 0;
  }
  @media print {
    .page {
      max-width: none;
      margin: 0;
      padding: 20mm;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
  }`;
  }

  const box = setting.placement === 'left'
    ? '@bottom-left'
    : setting.placement === 'right'
      ? '@bottom-right'
      : '@bottom-center';
  const counter = setting.format === 'number'
    ? 'counter(page)'
    : 'counter(page) " / " counter(pages)';

  const emptyBoxes = ['@top-left', '@top-center', '@top-right', '@bottom-left', '@bottom-center', '@bottom-right']
    .filter((b) => b !== box)
    .map((b) => `    ${b} { content: ""; }`)
    .join('\n');

  return `  @page {
    size: A4;
    margin: 18mm 20mm 20mm 20mm;
${emptyBoxes}
    ${box} {
      content: ${counter};
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 9pt;
      color: #6a6a6a;
      vertical-align: top;
      padding-top: 5mm;
    }
  }
  @media print {
    .page {
      max-width: none;
      margin: 0;
      padding: 0;
    }
  }`;
}
