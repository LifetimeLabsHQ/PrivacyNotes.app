/**
 * A doodle block as HTML for an export, a print or a burn note (issue #736).
 * Loaded by `prepareRender` in markdownRender.ts only for a body that holds
 * a doodle, so the stroke engine stays off the boot path.
 */
import { BOARD_HEIGHT_DEFAULT, BOARD_WIDTH, clampBoardHeight, parseDoodle } from './doodleFormat';
import { strokeSvg } from './strokes';

/** The block's drawing as a figure, or null when the text is no doodle (it
 *  then prints as code, as the editor shows it). Every number and colour is
 *  checked by the parse, so the markup is safe. */
export function doodleHtml(text: string, rawHeight: number | null): string | null {
  const data = parseDoodle(text);
  if (!data) return null;
  const height = clampBoardHeight(rawHeight ?? BOARD_HEIGHT_DEFAULT) ?? BOARD_HEIGHT_DEFAULT;
  const paper = data.paper ? `<rect width="${BOARD_WIDTH}" height="${height}" fill="${data.paper}"/>` : '';
  const strokes = data.strokes.map((s) => strokeSvg(s, data.style)).join('');
  return `<figure class="doodle" style="margin:1em 0"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOARD_WIDTH} ${height}" style="width:100%;height:auto;display:block" role="img">${paper}${strokes}</svg></figure>`;
}
