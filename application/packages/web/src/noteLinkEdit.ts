/**
 * Note-link body and live-editor mutations for Graph, Explore, and Suggested
 * connections (#177, #852).
 *
 * Kept in its own lazy-loaded module so `NotesView.tsx` and `NoteEditorPane.tsx`
 * load it on click rather than on the boot path.
 *
 * Spec: docs/internal/specs/graph-view.md (section 4.1)
 */

import type { Editor as TipTapEditor } from '@tiptap/core';
import { insertFootnote } from './footnotes';
import { nextFence, type Fence } from './markdownFence';
import {
  noteLinkKey,
  noteLinkTarget,
  noteLinkTargets,
  parseNoteLinkTarget,
  SUGGESTED_LINK_MARKER,
} from './noteLinks';
import { hasStructuredBody } from './notesViewUtils';
import { formNotesText, withFormNotes } from './vaultBody';

const FOOTNOTE_LABEL_RE = /\[\^([^\s\]^]+)\]/g;
const FOOTNOTE_DEF_START_RE = /^\[\^[^\s\]^]+\]:/;

function nextFreeFootnoteLabel(body: string): string {
  const used = new Set<string>();
  FOOTNOTE_LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOOTNOTE_LABEL_RE.exec(body)) !== null) {
    if (m[1]) used.add(m[1]);
  }
  let max = 0;
  // Nine digits at most so adding one always advances an exact integer.
  for (const label of used) {
    if (/^\d{1,9}$/.test(label)) max = Math.max(max, Number(label));
  }
  let n = max + 1;
  while (used.has(String(n))) n += 1;
  return String(n);
}

/**
 * True when an item type can hold outgoing `[[note-links]]`: markdown pillars
 * store them in their body, while bookmarks and contacts store them in their
 * JSON `notes` field (`vaultBody.ts`).
 */
export function canStoreNoteLinks(type: string | undefined): boolean {
  return !hasStructuredBody(type) || type === 'link' || type === 'contact';
}

/**
 * Append an inline `[[Target]]` note-link line to a form item's Markdown
 * `notes` field (bookmarks and contacts). Returns `notes` unchanged when a
 * note-link to `targetTitle` already exists outside code blocks.
 */
export function appendInlineNoteLink(
  notes: string,
  targetTitle: string,
  suggested = false,
): string {
  const sanitized = noteLinkTarget(targetTitle);
  if (!sanitized) return notes;
  const wantedKey = noteLinkKey(sanitized);

  for (const rawTarget of noteLinkTargets(notes)) {
    const { note } = parseNoteLinkTarget(rawTarget);
    if (note && noteLinkKey(note) === wantedKey) return notes;
  }

  const linkLine = suggested
    ? `[[${sanitized}]]${SUGGESTED_LINK_MARKER}`
    : `[[${sanitized}]]`;
  const trimmed = notes.replace(/\r\n/g, '\n').replace(/\n+$/g, '');
  return trimmed ? `${trimmed}\n${linkLine}` : linkLine;
}

/**
 * Append a footnote marker `[^N]` at the end of the last non-footnote prose
 * line and `[^N]: [[TargetTitle]]` in the footnote section, matching
 * `footnotes.ts` (`isLinkOnlyDefinition`). Returns `body` unchanged when it
 * already links to `targetTitle`.
 * Spec: docs/internal/specs/graph-view.md (section 4.1)
 */
export function appendFootnoteNoteLink(
  body: string,
  targetTitle: string,
  suggested = false,
): string {
  const sanitized = noteLinkTarget(targetTitle);
  if (!sanitized) return body;
  const wantedKey = noteLinkKey(sanitized);

  for (const rawTarget of noteLinkTargets(body)) {
    const { note } = parseNoteLinkTarget(rawTarget);
    if (note && noteLinkKey(note) === wantedKey) return body;
  }

  const label = nextFreeFootnoteLabel(body);
  const linkMarkdown = suggested
    ? `[[${sanitized}]]${SUGGESTED_LINK_MARKER}`
    : `[[${sanitized}]]`;
  const defLine = `[^${label}]: ${linkMarkdown}`;

  const normalized = body.replace(/\r\n/g, '\n');
  if (!normalized.trim()) {
    return `[^${label}]\n\n${defLine}`;
  }

  const lines = normalized.split('\n');
  // Identify lines belonging to footnote definitions (outside fenced code blocks).
  const isFootnoteLine = new Array<boolean>(lines.length).fill(false);
  let fence: Fence | null = null;
  let inFootnote = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const stepped = nextFence(fence, line);
    const wasInFence = fence !== null;
    fence = stepped.fence;
    if (wasInFence || stepped.isFence) {
      if (inFootnote) isFootnoteLine[i] = true;
      continue;
    }
    if (FOOTNOTE_DEF_START_RE.test(line)) {
      inFootnote = true;
      isFootnoteLine[i] = true;
      continue;
    }
    if (inFootnote) {
      if (line.trim() === '' || /^(?: {4}|\t)/.test(line)) {
        isFootnoteLine[i] = true;
      } else {
        inFootnote = false;
      }
    }
  }

  let lastProseIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isFootnoteLine[i] && lines[i]!.trim() !== '') {
      lastProseIdx = i;
      break;
    }
  }

  if (lastProseIdx === -1) {
    // Body holds only footnote definitions: prepend a marker line above them.
    const trimmed = normalized.replace(/^\n+|\n+$/g, '');
    return `[^${label}]\n\n${trimmed}\n\n${defLine}`;
  }

  const targetLine = lines[lastProseIdx]!;
  const isFenceOrRule =
    /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(targetLine) ||
    /^ {0,3}(?:[-*_]\s*){3,}$/.test(targetLine);

  if (isFenceOrRule) {
    lines.splice(lastProseIdx + 1, 0, '', `[^${label}]`);
  } else {
    lines[lastProseIdx] = `${targetLine.replace(/[ \t]+$/, '')}[^${label}]`;
  }

  const withMarker = lines.join('\n').replace(/\n+$/g, '');
  return `${withMarker}\n\n${defLine}`;
}

function matchesWantedLinkTarget(targetPart: string, wantedKey: string): boolean {
  if (noteLinkKey(targetPart) === wantedKey) return true;
  const { note } = parseNoteLinkTarget(targetPart);
  return Boolean(note && noteLinkKey(note) === wantedKey);
}

/**
 * Split a single line into CommonMark inline code spans and plain-text gaps.
 * Outside code spans, backslash-escaped ASCII punctuation is literal so `\\``
 * does not open a span; an opening run of `n` backticks closes only at the next
 * run of exact length `n`, and stays literal text when unclosed.
 */
function splitInlineCode(line: string): { text: string; code: boolean }[] {
  if (!line.includes('`')) return line ? [{ text: line, code: false }] : [];
  const segments: { text: string; code: boolean }[] = [];
  let plainStart = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '\\' && i + 1 < line.length && /[!-/:-@[-\x60{-~]/.test(line[i + 1]!)) {
      i += 2;
      continue;
    }
    if (ch !== '`') {
      i += 1;
      continue;
    }
    let n = 1;
    while (line[i + n] === '`') n += 1;
    let close = -1;
    for (let j = line.indexOf('`', i + n); j !== -1; ) {
      let k = j + 1;
      while (line[k] === '`') k += 1;
      if (k - j === n) {
        close = j;
        break;
      }
      j = line.indexOf('`', k);
    }
    if (close === -1) {
      i += n;
      continue;
    }
    if (i > plainStart) segments.push({ text: line.slice(plainStart, i), code: false });
    segments.push({ text: line.slice(i, close + n), code: true });
    i = close + n;
    plainStart = i;
  }
  if (plainStart < line.length) segments.push({ text: line.slice(plainStart), code: false });
  return segments;
}

/**
 * Remove every note-link pointing to `targetTitle` from `body` (outside fenced
 * and inline code spans, leaving `![[embed]]` embeds untouched). When a
 * single-line footnote definition held only that note-link (such as links added
 * by `appendFootnoteNoteLink`), the definition and its inline `[^label]`
 * references are both removed cleanly.
 * Spec: docs/internal/specs/graph-view.md (section 4.1)
 */
export function removeNoteLink(body: string, targetTitle: string): string {
  const sanitized = noteLinkTarget(targetTitle);
  if (!sanitized) return body;
  const wantedKey = noteLinkKey(sanitized);

  const normalized = body.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const removedFootnotes = new Set<string>();
  const dropped = new Array<boolean>(lines.length).fill(false);

  const escapedSuggested = SUGGESTED_LINK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targetPartRe = '(?![\\]\\n|])[^\\[\\]|\\n]*(?:\\[(?!\\[)[^\\[\\]|\\n]*)*';
  const linkOnlyDefRe = new RegExp(
    `^ {0,3}\\[\\^([^\\[\\]\\s]+)\\]:[ \\t]*\\[\\[(${targetPartRe}(?:\\|[^\\]\\n]*)?)\\]\\](?:${escapedSuggested})?[ \\t]*$`,
  );

  // Pass 1: detect single-link footnote definitions targeting wantedKey (skip multi-line defs).
  let fence: Fence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const stepped = nextFence(fence, line);
    const wasInFence = fence !== null;
    fence = stepped.fence;
    if (wasInFence || stepped.isFence) continue;
    const m = linkOnlyDefRe.exec(line);
    if (!m) continue;
    // Skip if followed by indented continuation lines belonging to the same footnote definition.
    let nextIdx = i + 1;
    while (nextIdx < lines.length && lines[nextIdx]!.trim() === '') nextIdx++;
    if (nextIdx < lines.length && /^(?: {4}|\t)/.test(lines[nextIdx]!)) continue;
    const rawTarget = m[2]!;
    const pipeIdx = rawTarget.indexOf('|');
    const targetPart = pipeIdx >= 0 ? rawTarget.slice(0, pipeIdx) : rawTarget;
    if (matchesWantedLinkTarget(targetPart, wantedKey)) {
      removedFootnotes.add(m[1]!);
      dropped[i] = true;
    }
  }

  // Pass 2: strip removed footnote markers and matching inline [[Target]] links
  // inside non-code segments only, leaving untouched lines and unrelated spacing intact.
  const rewrittenLines = lines.slice();
  let anyLineModified = removedFootnotes.size > 0;
  fence = null;
  for (let i = 0; i < lines.length; i++) {
    if (dropped[i]) continue;
    const origLine = lines[i]!;
    const stepped = nextFence(fence, origLine);
    const wasInFence = fence !== null;
    fence = stepped.fence;
    if (wasInFence || stepped.isFence) continue;

    const origLeadLen = /^([ \t]*)/.exec(origLine)?.[1]?.length ?? 0;
    const segments = splitInlineCode(origLine);
    let lineModified = false;
    let segOffset = 0;

    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s]!;
      const segEnd = segOffset + seg.text.length;
      if (!seg.code) {
        const edits: { start: number; end: number; replacement: string }[] = [];
        const text = seg.text;
        const len = text.length;
        let ketCursor = -2;
        let pipeCursor = -2;
        let doubleBraCursor = -2;
        const findKet = (from: number): number => {
          if (ketCursor === -1) return -1;
          if (ketCursor < from) ketCursor = text.indexOf(']', from);
          return ketCursor;
        };
        const findPipe = (from: number): number => {
          if (pipeCursor === -1) return -1;
          if (pipeCursor < from) pipeCursor = text.indexOf('|', from);
          return pipeCursor;
        };
        const findDoubleBra = (from: number): number => {
          if (doubleBraCursor === -1) return -1;
          if (doubleBraCursor < from) doubleBraCursor = text.indexOf('[[', from);
          return doubleBraCursor;
        };

        let pos = 0;
        while (pos < len) {
          const ch = text[pos]!;
          if (ch === '\\' && pos + 1 < len && /[!-/:-@[-\x60{-~]/.test(text[pos + 1]!)) {
            pos += 2;
            continue;
          }
          if (ch === '[' && text[pos + 1] === '[') {
            const nextKet = findKet(pos + 2);
            if (nextKet === -1) break;
            if (nextKet === pos + 2 || text[nextKet + 1] !== ']') {
              pos += 1;
              continue;
            }
            const nextPipe = findPipe(pos + 2);
            const hasPipe = nextPipe !== -1 && nextPipe < nextKet;
            const targetEnd = hasPipe ? nextPipe : nextKet;
            if (targetEnd === pos + 2) {
              pos += 1;
              continue;
            }
            const nextDoubleBra = findDoubleBra(pos + 2);
            if (nextDoubleBra !== -1 && nextDoubleBra < targetEnd) {
              pos += 1;
              continue;
            }
            const end =
              nextKet +
              2 +
              (text.startsWith(SUGGESTED_LINK_MARKER, nextKet + 2) ? SUGGESTED_LINK_MARKER.length : 0);
            if (pos > 0 && text[pos - 1] === '!') {
              pos = end;
              continue;
            }
            const targetPart = text.slice(pos + 2, targetEnd);
            if (matchesWantedLinkTarget(targetPart, wantedKey)) {
              const aliasPart = hasPipe ? text.slice(nextPipe + 1, nextKet).trim() : '';
              edits.push({ start: pos, end, replacement: aliasPart });
            }
            pos = end;
            continue;
          }
          if (ch === '[' && text[pos + 1] === '^' && removedFootnotes.size > 0) {
            let labelEnd = pos + 2;
            while (labelEnd < len && !/[\[\]\s]/.test(text[labelEnd]!)) {
              labelEnd += 1;
            }
            if (labelEnd > pos + 2 && text[labelEnd] === ']' && text[labelEnd + 1] !== ':') {
              const label = text.slice(pos + 2, labelEnd);
              if (removedFootnotes.has(label)) {
                edits.push({ start: pos, end: labelEnd + 1, replacement: '' });
              }
              pos = labelEnd + 1;
              continue;
            }
            pos += 2;
            continue;
          }
          pos += 1;
        }

        if (edits.length > 0) {
          lineModified = true;
          const merged: { start: number; end: number; replacement: string }[] = [];
          for (const edit of edits) {
            const prev = merged[merged.length - 1];
            if (
              prev &&
              prev.replacement === '' &&
              edit.replacement === '' &&
              /^ *$/.test(seg.text.slice(prev.end, edit.start))
            ) {
              prev.end = edit.end;
            } else {
              merged.push({ ...edit });
            }
          }

          const leadKeep = Math.max(0, origLeadLen - segOffset);
          let out = seg.text.slice(0, merged[0]!.start);
          for (let k = 0; k < merged.length; k++) {
            const edit = merged[k]!;
            const nextStart = merged[k + 1]?.start ?? seg.text.length;
            const right = seg.text.slice(edit.end, nextStart);
            if (edit.replacement !== '') {
              out += edit.replacement + right;
              continue;
            }
            const atLineStart = segOffset + edit.start === origLeadLen;
            const atLineEnd = segEnd === origLine.length && k === merged.length - 1 && /^[ \t]*$/.test(right);
            if (atLineEnd) {
              while (out.length > leadKeep && (out.endsWith(' ') || out.endsWith('\t'))) {
                out = out.slice(0, -1);
              }
              if (/^ {2,}$/.test(right)) out += right;
            } else if (atLineStart) {
              out += right.replace(/^ +/, '');
            } else if (/^([.,;:?]|!(?!\[))/.test(right)) {
              while (out.length > leadKeep && out.endsWith(' ')) out = out.slice(0, -1);
              out += right;
            } else if (out.endsWith(' ') && right.startsWith(' ')) {
              while (out.length > leadKeep && out.endsWith(' ')) out = out.slice(0, -1);
              out += ` ${right.replace(/^ +/, '')}`;
            } else {
              out += right;
            }
          }
          seg.text = out;
        }
      }
      segOffset = segEnd;
    }

    if (lineModified) {
      anyLineModified = true;
      const nextLine = segments.map((seg) => seg.text).join('');
      if (nextLine.trim() === '' && origLine.trim() !== '') {
        dropped[i] = true;
      } else {
        rewrittenLines[i] = nextLine;
      }
    }
  }

  if (!anyLineModified) return body;

  const keptLines: string[] = [];
  let sawDroppedSinceLastKept = false;
  let allPriorDropped = true;

  for (let i = 0; i < lines.length; i++) {
    if (dropped[i]) {
      sawDroppedSinceLastKept = true;
      continue;
    }
    const line = rewrittenLines[i]!;
    const isBlank = line.trim() === '';
    if (isBlank && allPriorDropped && sawDroppedSinceLastKept) {
      continue;
    }
    if (
      isBlank &&
      sawDroppedSinceLastKept &&
      keptLines.length > 0 &&
      keptLines[keptLines.length - 1]!.trim() === ''
    ) {
      continue;
    }
    keptLines.push(line);
    allPriorDropped = false;
    sawDroppedSinceLastKept = false;
  }

  if (sawDroppedSinceLastKept) {
    while (keptLines.length > 0 && keptLines[keptLines.length - 1]!.trim() === '') {
      keptLines.pop();
    }
  }

  return keptLines.join('\n');
}

/**
 * Add a `[[note-link]]` to `targetTitle` onto a stored item body: inline inside
 * the JSON `notes` field for contacts and bookmarks, or as a footnote on
 * Markdown items. Returns `null` when the item cannot store note-links or
 * already links to `targetTitle`.
 */
export function addItemNoteLink(
  item: { type?: string; body: string },
  targetTitle: string,
  suggested = false,
): string | null {
  if (!canStoreNoteLinks(item.type)) return null;
  if (hasStructuredBody(item.type)) {
    const currentNotes = formNotesText(item);
    const nextNotes = appendInlineNoteLink(currentNotes, targetTitle, suggested);
    return nextNotes === currentNotes ? null : withFormNotes(item.body, nextNotes);
  }
  const nextBody = appendFootnoteNoteLink(item.body, targetTitle, suggested);
  return nextBody === item.body ? null : nextBody;
}

/**
 * Remove every `[[note-link]]` targeting `targetTitle` from a stored item body
 * (JSON `notes` field for contacts and bookmarks, or Markdown body otherwise).
 * Returns `null` when the item cannot store note-links or was unchanged.
 */
export function removeItemNoteLink(
  item: { type?: string; body: string },
  targetTitle: string,
): string | null {
  if (!canStoreNoteLinks(item.type)) return null;
  if (hasStructuredBody(item.type)) {
    const currentNotes = formNotesText(item);
    const nextNotes = removeNoteLink(currentNotes, targetTitle);
    return nextNotes === currentNotes ? null : withFormNotes(item.body, nextNotes);
  }
  const nextBody = removeNoteLink(item.body, targetTitle);
  return nextBody === item.body ? null : nextBody;
}

/**
 * Insert a footnote `[[note-link]]` into a live ProseMirror/TipTap editor at
 * the current selection (when `atCursor` is true) or at the end of the last
 * textblock outside the `footnotes` section.
 */
export function insertEditorFootnoteNoteLink(
  editor: TipTapEditor,
  targetTitle: string,
  options: { atCursor?: boolean; suggested?: boolean; focus?: boolean } = {},
): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const sanitized = noteLinkTarget(targetTitle);
  if (!sanitized) return false;

  const { atCursor = false, suggested = false, focus = true } = options;
  let at = editor.state.selection.to;
  if (!atCursor) {
    at = -1;
    editor.state.doc.forEach((child, offset) => {
      if (child.type.name === 'footnotes') return;
      child.descendants((node, pos) => {
        if (node.isTextblock) at = offset + 1 + pos + node.nodeSize - 1;
        return !node.isTextblock;
      });
      if (child.isTextblock) at = offset + child.nodeSize - 1;
    });
    if (at < 0) return false;
  }

  const linkNode = editor.schema.nodeFromJSON({
    type: 'wikiLink',
    attrs: { target: sanitized, label: null, ...(suggested ? { suggested: true } : {}) },
  });
  return insertFootnote(editor, { at, inline: [linkNode], focus });
}
