/**
 * A `<details><summary>` block becomes a Fold callout on import:
 *
 *   <details open>            > [!fold]+ Title
 *   <summary>Title</summary>  > body
 *   body
 *   </details>
 *
 * GitLab, the Notion API and many READMEs write a fold this way, and the
 * editor has no node for raw `<details>`, so without this pass the block
 * loses its fold. Closed unless the tag carries `open`. The innermost block
 * converts first, so a nested fold ends up as a nested callout. Fenced code
 * is left alone: a README that shows the HTML in a code block keeps it.
 * Spec: docs/contrib/callouts.md (importers)
 */

const FENCE = /^\s{0,3}(```|~~~)/;

// Innermost first: neither the summary nor the body may open another <details>.
const DETAILS =
  /^[ \t]*<details(\s+open(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?)?\s*>[ \t]*\n?[ \t]*<summary>((?:(?!<\/?summary>|<details[\s>])[\s\S])*?)<\/summary>((?:(?!<details[\s>])[\s\S])*?)^[ \t]*<\/details>[ \t]*$/im;

/** Past these the text keeps its raw `<details>`: the fold is lost, never the
 *  text. Each pass rescans the whole text and every level prefixes the inner
 *  lines again, so 3000 nested blocks (134 KB) took 38 s on the UI thread and
 *  grew the note to 8.8 MB (external report, 2026-10-24, bug report 32). */
const MAX_DEPTH = 16;
const MAX_BLOCKS = 200;

function nestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  for (const tag of text.matchAll(/<(\/?)details[\s>]/gi)) {
    depth = tag[1] ? Math.max(0, depth - 1) : depth + 1;
    max = Math.max(max, depth);
  }
  return max;
}

function convert(text: string): string {
  if (nestingDepth(text) > MAX_DEPTH) return text;
  let out = text;
  let blocks = 0;
  for (let m = out.match(DETAILS); m && blocks < MAX_BLOCKS; m = out.match(DETAILS), blocks++) {
    const open = Boolean(m[1]);
    const title = m[2]!.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const lines = m[3]!.replace(/^\s*\n|\n\s*$/g, '').split('\n');
    const body = lines.join('').trim() === '' ? [] : lines.map((l) => (l.trim() ? `> ${l}` : '>'));
    const head = `> [!fold]${open ? '+' : '-'} ${title}`.trimEnd();
    const block = [head, ...body].join('\n');
    out = `${out.slice(0, m.index)}\n${block}\n${out.slice(m.index! + m[0].length)}`;
  }
  return out;
}

export function detailsToFold(md: string): string {
  if (!/<details[\s>]/i.test(md)) return md;
  const lines = md.split('\n');
  const parts: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const f = line.match(FENCE)?.[1];
    if (fence) {
      parts.push(line);
      if (f === fence) fence = null;
    } else if (f) {
      if (prose.length) parts.push(convert(prose.join('\n')));
      prose = [];
      fence = f;
      parts.push(line);
    } else {
      prose.push(line);
    }
  }
  if (prose.length) parts.push(convert(prose.join('\n')));
  return parts.join('\n');
}
