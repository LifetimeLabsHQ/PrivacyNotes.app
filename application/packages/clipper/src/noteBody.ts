/**
 * The size rule of a note body. It imports nothing, so the command line
 * bundles it without the clip engine, and a sender runs the same rule the
 * app runs when it adopts an inbox note (`inboxNoteBody` in index.ts).
 * Spec: docs/internal/plans/agent-cli.md (section 3.4)
 */

/** The largest note body a clip or an inbox note may save, in UTF-8 bytes.
 *  The encrypted row must stay under the server's 1 MiB row ceiling.
 *  Spec: docs/internal/specs/web-clipper-stage1.md (section 3.2, Size) */
export const CLIP_MAX_BODY_BYTES = 700 * 1024;

export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** Whether a finished note body is under the cap. */
export function bodyFits(body: string): boolean {
  return utf8Length(body) <= CLIP_MAX_BODY_BYTES;
}

/** `text` as one fenced code block, the fence one backtick longer than the
 *  longest run of backticks in it (three at least), so no line inside can
 *  close it. Nothing inside a fence is read as Markdown, so nothing needs a
 *  backslash: the form is only the two fence lines longer than the text. */
export function fencedText(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** Whether the app can always make a note of this inbox Markdown: its fenced
 *  form, the last body `inboxNoteBody` falls back to, fits. A sender that
 *  checks this never reports saved for a note the app would refuse. */
export function inboxNoteFits(markdown: string): boolean {
  return bodyFits(fencedText(markdown));
}
