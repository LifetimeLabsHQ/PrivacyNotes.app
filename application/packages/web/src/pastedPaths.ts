/**
 * A Windows path pasted as text keeps every backslash (GitHub #755).
 *
 * A text paste is read as Markdown, and in Markdown a backslash before a
 * punctuation mark is an escape: `C:\Docs\_Test` would paste as
 * `C:\Docs_Test`, and a path ending in `\` would end in a line break. So
 * before the parse, each backslash of a raw path is written as `\\`, which
 * Markdown reads as one literal backslash. The rest of the paste is read as
 * Markdown as before.
 *
 * A raw path is told from Markdown by its backslashes. Explorer, a terminal
 * or a text file give single ones; a Markdown copy of the same path (a note
 * copied on another device, a .md file) has at least one `\\`, because that
 * is how Markdown writes a backslash before punctuation. A path with a `\\`
 * in it is left to the parser, which reads it right.
 *
 * Where a path stops: a Windows path can hold spaces (`C:\Program Files`),
 * so it runs to the end of the line or to a character no path can hold
 * (`<>"|?*`, a tab) or a backtick. The accepted cost: a Markdown escape later
 * on the same line as a raw path, such as `snake\_case`, keeps its backslash.
 *
 * Left alone: code, where Markdown keeps every backslash already (a fenced
 * or indented block, and a backtick before the path), and a drive letter that
 * follows anything but a line start, a space, a quote or a bracket `(`, so a
 * word like `Note:\_` and math like `$f:\{x\}$` are not paths.
 * Spec: docs/internal/design-decisions.md (A pasted Windows path keeps its backslashes)
 */
export function keepWindowsPathBackslashes(text: string): string {
  if (!text.includes('\\')) return text;
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      if (/^(?: {4}|\t)/.test(line)) return line;
      return keepInLine(line);
    })
    .join('\n');
}

/** A drive (`C:\`) or a network share (`\\server`), after a line start, a
 *  space, a quote or `(`. */
const PATH_START = /(?<=^|[\s"'(])(?:[A-Za-z]:\\|\\\\(?=[^\\\s]))/g;
/** What ends a path: what no Windows path can hold, and a backtick. */
const PATH_STOP = /[\r\t<>"|?*`]/g;

function keepInLine(line: string): string {
  let out = '';
  let from = 0;
  PATH_START.lastIndex = 0;
  for (let m = PATH_START.exec(line); m; m = PATH_START.exec(line)) {
    const start = m.index;
    PATH_STOP.lastIndex = start + m[0].length;
    const stop = PATH_STOP.exec(line);
    const end = stop ? stop.index : line.length;
    const path = line.slice(start, end);
    // A share's own `\\` opens it; any other `\\` says this is Markdown.
    const body = m[0].startsWith('\\\\') ? path.slice(2) : path;
    if (!body.includes('\\\\')) {
      // A backslash right before the stop escapes that character, not a path.
      const last = path.endsWith('\\') && stop && stop[0] !== '\r' ? path.length - 1 : path.length;
      out += line.slice(from, start) + path.slice(0, last).replace(/\\/g, '\\\\') + path.slice(last);
      from = end;
    }
    PATH_START.lastIndex = end;
  }
  return out + line.slice(from);
}
