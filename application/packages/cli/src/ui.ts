/**
 * How `privacynotes` draws a result: one framed card, the badge in the top border, the
 * frame's color the outcome (brand for a prompt or a status, ok for done,
 * error for a problem), a table of details, and a footer that says what
 * happens next. Without color (a pipe, NO_COLOR, TERM=dumb) the same words
 * print as plain lines with no frame, so a script or an agent reads them
 * easily. `--json` never comes here.
 * Spec: docs/internal/plans/agent-cli.md (section 3.5, Output)
 */

type Tone = 'dim' | 'bold' | 'accent' | 'ok' | 'warn' | 'tag' | 'bar' | 'barEmpty';
export type Seg = readonly [text: string, tone?: Tone];
export type Row = readonly Seg[];

export interface Card {
  tone: 'brand' | 'ok' | 'error';
  badge: string;
  rows: readonly Row[];
  footer?: Row;
}

export interface Style {
  color: boolean;
  /** The terminal's width in columns. */
  columns: number;
}

/** The narrowest and widest card, frame included. */
const CARD_MIN = 40;
const CARD_MAX = 72;

const ESC = '\u001b[';
const paint = (codes: string, text: string) => `${ESC}${codes}m${text}${ESC}0m`;

// 256-color codes, which every current terminal shows.
const FRAME: Record<Card['tone'], string> = { brand: '38;5;61', ok: '38;5;29', error: '38;5;124' };
const BADGE: Record<Card['tone'], string> = { brand: '1;97;48;5;61', ok: '1;97;48;5;29', error: '1;97;48;5;124' };
const TONE: Record<Tone, string> = {
  dim: '38;5;245',
  bold: '1;97',
  accent: '38;5;141',
  ok: '38;5;78',
  warn: '38;5;221',
  tag: '38;5;221;48;5;58',
  bar: '38;5;141',
  barEmpty: '38;5;238',
};

/** Columns a string takes. `privacynotes` prints only single-width symbols. */
export const width = (s: string): number => [...s].length;

/** Cut to `max` columns, with an ellipsis when it was longer. */
function cut(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** Fit a row into `room` columns: the last segments that do not fit are cut. */
function fitRow(row: Row, room: number): Row {
  const out: Seg[] = [];
  let left = room;
  for (const [text, tone] of row) {
    if (left <= 0) break;
    const t = cut(text, left);
    out.push([t, tone]);
    left -= width(t);
  }
  return out;
}

const plainSeg = ([text, tone]: Seg): string => (tone === 'tag' ? `#${text.trim()}` : text);

export function renderCard(card: Card, style: Style): string {
  if (!style.color) {
    const lines = [card.badge, ...card.rows.map((r) => `  ${r.map(plainSeg).join('')}`.trimEnd())];
    if (card.footer) lines.push(`  ${card.footer.map(plainSeg).join('')}`);
    return lines.filter((l, i) => i === 0 || l.trim()).join('\n');
  }
  const total = Math.min(CARD_MAX, Math.max(CARD_MIN, style.columns));
  const inner = total - 2;
  const room = inner - 4;
  const frame = (t: string) => paint(FRAME[card.tone], t);
  const badge = ` ${cut(card.badge, inner - 6)} `;
  const top = frame('╭─') + paint(BADGE[card.tone], badge) + frame(`${'─'.repeat(inner - 1 - width(badge))}╮`);
  const line = (row: Row) => {
    const fitted = fitRow(row, room);
    const used = fitted.reduce((n, [t]) => n + width(t), 0);
    const body = fitted.map(([t, tone]) => (tone ? paint(TONE[tone], t) : t)).join('');
    return `${frame('│')}  ${body}${' '.repeat(room - used)}  ${frame('│')}`;
  };
  const out = [top, ...card.rows.map(line)];
  if (card.footer) out.push(frame(`├${'─'.repeat(inner)}┤`), line(card.footer));
  out.push(frame(`╰${'─'.repeat(inner)}╯`));
  return out.join('\n');
}

/** A label column, then the value. */
export function kv(label: string, ...value: Seg[]): Row {
  return [[label.padEnd(10), 'dim'], ...value];
}

/** Tags as chips: " work " " ai ". */
export function chips(tags: readonly string[]): Seg[] {
  return tags.flatMap((t, i): Seg[] => (i ? [[' '], [` ${t} `, 'tag']] : [[` ${t} `, 'tag']]));
}

/** A ten-step bar of how full a note is. */
export function sizeBar(bytes: number, limit: number): Seg[] {
  const filled = Math.min(10, Math.max(1, Math.round((bytes / limit) * 10)));
  return [['▰'.repeat(filled), 'bar'], ['▱'.repeat(10 - filled), 'barEmpty']];
}

export function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "2 min ago", "3 h ago", "4 days ago". */
export function ago(iso: string, now: Date): string {
  const s = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** Color only for a terminal that asks for none of the opt-outs. */
export function wantsColor(isTTY: boolean | undefined, env: Record<string, string | undefined>): boolean {
  if (!isTTY) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return true;
}
