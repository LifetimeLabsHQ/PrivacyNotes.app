/**
 * Recognising a pipe table's delimiter row. Kept apart from
 * tableColumnWidths.ts because the word count and the note list read it on
 * every render, and they need nothing else from there.
 * Spec: docs/internal/specs/table-column-widths.md
 */

/** The dash count of each delimiter cell; colons and spaces do not count. Null when the row is not a delimiter row. */
export function dashCounts(delimiter: string): number[] | null {
  let t = delimiter.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  const cells = t.split('|').map((c) => c.trim());
  if (cells.length === 0 || !cells.every((c) => /^:?-+:?$/.test(c))) return null;
  return cells.map((c) => c.replace(/:/g, '').length);
}

/** Whether a line is a pipe table's delimiter row, which carries no words. */
export function isDelimiterRow(line: string): boolean {
  return line.includes('-') && line.includes('|') && dashCounts(line) !== null;
}

/**
 * The line under a pipe table that holds its width when it is narrower than
 * the note: `<!-- table-width: 60% -->`. An HTML comment, so the table stays a
 * table everywhere and a renderer that shows HTML hides the line.
 */
const WIDTH_MARKER = /^<!--\s*table-width:\s*(\d{1,3})%\s*-->$/;

/** The table width a marker line holds, or null when the line is not one or the width is out of range. */
export function tableWidthFromMarker(line: string): number | null {
  const m = WIDTH_MARKER.exec(line.trim());
  if (!m) return null;
  const width = Number(m[1]);
  return width >= 20 && width < 100 ? width : null;
}

/** The marker line for a table width. */
export function tableWidthMarker(width: number): string {
  return `<!-- table-width: ${width}% -->`;
}

/**
 * The line under a pipe table that holds its cell colors (#616):
 * `<!-- table-fill: r0=blue r2c3=green -->`. Rows and columns count from 0
 * and the header row is r0. `rN` colors a whole row, `rNcM` one cell, and a
 * cell entry wins over its row. The names are the highlight palette's
 * (`CELL_FILLS` in editorColors.ts); this file only reads the shape.
 * Spec: docs/internal/specs/table-cell-colors.md
 */
const FILL_MARKER = /^<!--\s*table-fill:\s*([a-z0-9=\s]*?)\s*-->$/;
const FILL_ENTRY = /^(r\d{1,4}(?:c\d{1,3})?)=([a-z]{1,16})$/;

/** Cell colors by `rN` and `rNcM` key. */
export type TableFills = Record<string, string>;

/** The fills a marker line holds, or null when the line is not one. */
export function tableFillsFromMarker(line: string): TableFills | null {
  const m = FILL_MARKER.exec(line.trim());
  if (!m) return null;
  const fills: TableFills = {};
  for (const entry of m[1]!.split(/\s+/)) {
    const e = FILL_ENTRY.exec(entry);
    if (e) fills[e[1]!] = e[2]!;
  }
  return fills;
}

/** The color name of one cell, or null. */
export function fillAt(fills: TableFills | null, row: number, col: number): string | null {
  return fills?.[`r${row}c${col}`] ?? fills?.[`r${row}`] ?? null;
}

/** The marker line for a grid of color names (null for none), or null when no cell has one. */
export function tableFillMarker(grid: readonly (readonly (string | null)[])[]): string | null {
  const entries: string[] = [];
  grid.forEach((row, r) => {
    if (row.length && row[0] && row.every((name) => name === row[0])) {
      entries.push(`r${r}=${row[0]}`);
      return;
    }
    row.forEach((name, c) => { if (name) entries.push(`r${r}c${c}=${name}`); });
  });
  return entries.length ? `<!-- table-fill: ${entries.join(' ')} -->` : null;
}

/** Whether a line is one of the marker lines under a pipe table, which carry no words. */
export function isTableMarker(line: string): boolean {
  return tableWidthFromMarker(line) !== null || FILL_MARKER.test(line.trim());
}
