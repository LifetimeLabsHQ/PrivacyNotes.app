/**
 * The info string of a code fence, the text after the opening ```: a
 * language, an optional title and an optional `fold` word.
 *
 *     ```bash title="/root/scripts/auto-update.sh" fold
 *
 * `title="..."` is the form Docusaurus, MkDocs Material and Starlight read,
 * and an app that does not know it shows a plain code block with the right
 * language. `fold` saves a titled block closed. Read by the editor
 * (editorCodeBlock.ts) and the export (markdownRender.ts), so it stays free
 * of TipTap. Spec: docs/internal/design-decisions.md (code blocks can carry a title)
 */
export type FenceInfo = { language: string | null; title: string | null; folded: boolean };

const TITLE = /(^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/;

export function parseFenceInfo(info: string): FenceInfo {
  let rest = info.trim();
  let title: string | null = null;
  const m = rest.match(TITLE);
  if (m) {
    title = cleanFenceTitle(m[2] ?? m[3] ?? m[4] ?? '');
    rest = (rest.slice(0, m.index) + ' ' + rest.slice((m.index ?? 0) + m[0].length)).trim();
  }
  const words = rest ? rest.split(/\s+/) : [];
  const folded = title !== null && words.includes('fold');
  const first = words[0];
  const language = first && !(title !== null && first === 'fold') ? first : null;
  return { language, title, folded };
}

/** A title holds no quote, backtick or line break, which would end the
 *  attribute or the fence line. */
export function cleanFenceTitle(title: string): string {
  return title.replace(/["`\r\n]/g, '').trim();
}

/** The info string for a block. An empty title is written (`title=""`), so
 *  a band waiting for its name survives a save; `fold` only with a title,
 *  since the title band is what folds. */
export function formatFenceInfo(language: string | null, title: string | null, folded: boolean): string {
  const lang = String(language || '').replace(/[`\s]/g, '');
  if (title === null) return lang;
  const name = cleanFenceTitle(title);
  return `${lang}${lang ? ' ' : ''}title="${name}"${folded ? ' fold' : ''}`;
}

/**
 * `width=N` and `height=N` in an info string, as whole numbers, or null where
 * one is missing. A map block keeps its size there (```map width=60
 * height=320): an app that does not know the words still shows the place.
 * Spec: docs/internal/plans/note-location.md (section 4b)
 */
export function parseFenceSize(info: string): { width: number | null; height: number | null } {
  const read = (key: string) => {
    const m = info.match(new RegExp(`(?:^|\\s)${key}=(\\d{1,4})(?=\\s|$)`));
    return m ? Number(m[1]) : null;
  };
  return { width: read('width'), height: read('height') };
}
