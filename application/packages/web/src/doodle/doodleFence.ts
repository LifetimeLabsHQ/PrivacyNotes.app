/**
 * The doodle block's fence (issue #736), for code that must not load the
 * drawing code: the note previews, search and the word count. A doodle's
 * text is stroke data, never words.
 */

/** The fence language of a doodle block (doodleFormat.ts). */
export const DOODLE_FENCE = 'doodle';

/** A block's height in board units when its fence line names none. */
export const BOARD_HEIGHT_DEFAULT = 400;

/** Whether a fence's text is a doodle the block can show: the full check of
 *  every field is the board's (doodleFormat.ts), loaded with the board. */
export function looksLikeDoodle(text: string): boolean {
  try {
    const raw = JSON.parse(text.trim()) as { v?: unknown; strokes?: unknown } | null;
    return !!raw && typeof raw === 'object' && raw.v === 1 && Array.isArray(raw.strokes);
  } catch {
    return false;
  }
}

const DOODLE_BLOCK = /^([ \t>]*)(`{3,})doodle\b[^\n]*\n[\s\S]*?\n\1\2[ \t]*$/gm;

/** The body with every doodle block's data taken out. */
export function withoutDoodleData(body: string): string {
  return body.includes('```doodle') ? body.replace(DOODLE_BLOCK, '') : body;
}
