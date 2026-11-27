/**
 * Inline `#tags` in Markdown note bodies.
 *
 * One grammar and one scanner shared across the live editor decorations,
 * sidebar tag counts/filtering, search, graph, bulk rename/delete, importers,
 * the Markdown folder adapter, and HTML export rendering.
 *
 * Kept free of Dexie, TipTap and React imports so BurnNote / export chunks and
 * the boot path stay light.
 */
import type { NoteType } from '@notes/shared';
import { clipGraphemes } from './clipText';
import { nextFence, type Fence } from './markdownFence';
import { MARKDOWN_NOTE_TYPES } from './noteTypes';

/** Max characters in a single tag. Kept equal to `TAG_MAX_LENGTH` in notesRepo.ts. */
const INLINE_TAG_MAX_LENGTH = 30;

/** A tag that can appear inline as `#tag` without breaking at whitespace. */
export const INLINE_TAG_RE = /^[\p{L}_][\p{L}\p{N}_/-]*$/u;

/** CSS hex color lengths rejected so `#fff`, `#f46d24` and `#1e40af80` stay colors. */
const CSS_HEX_RE = /^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Match candidate `#tag` tokens preceded by start-of-string, whitespace, `(` or `[`. */
const INLINE_TAG_SCAN_RE = /(^|[\s(\[])#([\p{L}\p{N}_/-]+)/gu;

export interface InlineTagSpan {
  /** Normalized tag name (without `#`, clipped to INLINE_TAG_MAX_LENGTH). */
  tag: string;
  /** Raw token after `#` as written in the source text. */
  raw: string;
  /** Offset of `#` in the input string. */
  from: number;
  /** Exclusive end offset of the `#tag` token in the input string. */
  to: number;
}

/** Whether `tag` is a valid single-token inline `#tag` (no spaces, no hex color). */
export function isValidInlineTag(tag: string): boolean {
  if (!tag || tag.length > INLINE_TAG_MAX_LENGTH) return false;
  if (!INLINE_TAG_RE.test(tag)) return false;
  if (CSS_HEX_RE.test(tag)) return false;
  return true;
}

/**
 * Scan plain text (already outside code, links, headings and note-links) for
 * inline `#tag` spans. Returns exact character offsets into `text`.
 */
export function findInlineTagSpansInText(text: string): InlineTagSpan[] {
  if (!text || !text.includes('#')) return [];
  const spans: InlineTagSpan[] = [];
  INLINE_TAG_SCAN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_TAG_SCAN_RE.exec(text)) !== null) {
    const raw = match[2];
    if (!raw || !/^[\p{L}_]/u.test(raw)) continue;
    if (CSS_HEX_RE.test(raw)) continue;
    const tag = clipGraphemes(raw, INLINE_TAG_MAX_LENGTH);
    if (!tag) continue;
    const from = match.index + match[1]!.length;
    spans.push({ tag, raw, from, to: from + 1 + raw.length });
  }
  return spans;
}

/**
 * Replace every region of a Markdown body where `#` is NOT a tag with NUL
 * characters of identical length, preserving every character offset in `body`.
 *
 * Strictly O(n): uses line-by-line fence tracking (`nextFence`) and linear
 * single-pass link/note-link patterns (pinned by `tests/linkRunCost.test.ts`).
 */
function maskNonTagRegions(body: string, opts?: { stripComments?: boolean }): string {
  // 1. Mask fenced code blocks (``` / ~~~) and ATX headings line by line.
  const lines = body.split('\n');
  let openFence: Fence | null = null;
  const maskedLines = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const { fence, isFence } = nextFence(openFence, line);
    const insideFence = isFence || openFence !== null;
    openFence = fence;
    if (insideFence || /^\s{0,3}#{1,6}\s/.test(line)) {
      maskedLines[i] = '\0'.repeat(line.length);
    } else {
      maskedLines[i] = line;
    }
  }
  let masked = maskedLines.join('\n');

  // 2. Inline code spans.
  masked = masked.replace(/`[^`\n]*`/g, (run) => '\0'.repeat(run.length));

  // 3. Markdown link destinations: `[see](#custodial-mode)` and `[x](https://e.com/a#b)`.
  // Linear even on adversarial runs of unclosed `](` (external report, 2026-10-24).
  masked = masked.replace(/\]\([^)]*(\))?/g, (run, close?: string) =>
    close ? '\0'.repeat(run.length) : run,
  );

  // 4. Note-link targets: `[[#Setup]]` and `[[Note#Setup]]`.
  masked = masked.replace(/\[\[[^\]\n]*\]\]|(\[\[[^\]\n]*)/g, (run, open?: string) =>
    open === undefined ? '\0'.repeat(run.length) : run,
  );

  // 5. Optional Obsidian comments `%%...%%` (importer only).
  if (opts?.stripComments) {
    masked = masked.replace(/%%[\s\S]*?%%/g, (run) => '\0'.repeat(run.length));
  }

  return masked;
}

/**
 * Every inline `#tag` span in a Markdown note body, with exact character
 * offsets into `body`.
 */
export function findInlineTagSpans(
  body: string,
  opts?: { stripComments?: boolean },
): InlineTagSpan[] {
  if (!body || !body.includes('#')) return [];
  const masked = maskNonTagRegions(body, opts);
  return findInlineTagSpansInText(masked);
}

/**
 * Distinct inline `#tags` in a Markdown body, ignoring code, link destinations,
 * note-links, headings and CSS hex colors.
 */
export function extractInlineTags(
  body: string,
  opts?: { stripComments?: boolean },
): string[] {
  const spans = findInlineTagSpans(body, opts);
  if (spans.length === 0) return [];
  const found = new Set<string>();
  for (const span of spans) found.add(span.tag);
  return [...found];
}

/**
 * Rewrite every inline `#oldTag` occurrence in `body` to `#newTag`.
 * If `newTag` is not valid inline syntax (e.g. contains a space), strips `#`
 * instead so the prose stays readable while the caller keeps `newTag` in
 * `note.tags`.
 */
export function renameInlineTagInBody(
  body: string,
  oldTag: string,
  newTag: string,
): { body: string; changed: boolean; demotedToHeader: boolean } {
  const spans = findInlineTagSpans(body).filter((s) => s.tag === oldTag);
  if (spans.length === 0) return { body, changed: false, demotedToHeader: false };
  const inlineOk = isValidInlineTag(newTag);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += body.slice(cursor, span.from);
    out += inlineOk ? `#${newTag}` : span.raw;
    cursor = span.to;
  }
  out += body.slice(cursor);
  return { body: out, changed: true, demotedToHeader: !inlineOk };
}

/**
 * Remove the `#` prefix from every inline `#tag` occurrence in `body`, keeping
 * the word itself so prose sentences stay intact.
 */
export function stripInlineTagInBody(
  body: string,
  tag: string,
): { body: string; changed: boolean } {
  const spans = findInlineTagSpans(body).filter((s) => s.tag === tag);
  if (spans.length === 0) return { body, changed: false };
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += body.slice(cursor, span.from);
    out += span.raw;
    cursor = span.to;
  }
  out += body.slice(cursor);
  return { body: out, changed: true };
}

/** Minimal note shape needed to compute effective tags. */
export interface TagBearingNote {
  tags: readonly string[];
  body: string;
  type?: NoteType;
}

const effectiveCache = new WeakMap<TagBearingNote, { body: string; tags: readonly string[]; merged: string[] }>();

function hasMarkdownBody(type: NoteType | undefined): boolean {
  return MARKDOWN_NOTE_TYPES.includes(type ?? 'note');
}

/**
 * Effective tags of a note: its note-level `tags` plus any inline `#tags` in a
 * markdown body. When `isLocked` is true (a PIN-protected note whose gate is
 * shut), `body` is never read so inline tags cannot leak out past the lock.
 */
export function effectiveNoteTags(
  note: TagBearingNote,
  isLocked = false,
): readonly string[] {
  if (isLocked || !hasMarkdownBody(note.type) || !note.body || !note.body.includes('#')) {
    return note.tags;
  }
  const cached = effectiveCache.get(note);
  if (cached && cached.body === note.body && cached.tags === note.tags) {
    return cached.merged;
  }
  const inline = extractInlineTags(note.body);
  if (inline.length === 0) {
    const plain = note.tags as string[];
    effectiveCache.set(note, { body: note.body, tags: note.tags, merged: plain });
    return note.tags;
  }
  const merged = [...note.tags];
  const seen = new Set(merged);
  for (const t of inline) {
    if (!seen.has(t)) {
      seen.add(t);
      merged.push(t);
    }
  }
  effectiveCache.set(note, { body: note.body, tags: note.tags, merged });
  return merged;
}

/** Whether `note` carries `tag` either in `note.tags` or inline in its body. */
export function noteHasTag(
  note: TagBearingNote,
  tag: string,
  isLocked = false,
): boolean {
  if (note.tags.includes(tag)) return true;
  if (isLocked || !hasMarkdownBody(note.type) || !note.body || !note.body.includes('#')) {
    return false;
  }
  return effectiveNoteTags(note, false).includes(tag);
}

/** Whether `note` carries at least one note-level or inline tag. */
export function noteHasAnyTag(
  note: TagBearingNote,
  isLocked = false,
): boolean {
  if (note.tags.length > 0) return true;
  if (isLocked || !hasMarkdownBody(note.type) || !note.body || !note.body.includes('#')) {
    return false;
  }
  return effectiveNoteTags(note, false).length > 0;
}

/** Whether two markdown bodies contain the exact same set of inline `#tags`.
 *  Fast-paths when neither body holds `#` so ordinary typing allocates nothing. */
export function sameInlineTags(a: string, b: string): boolean {
  if (a === b) return true;
  const aHas = a.includes('#');
  const bHas = b.includes('#');
  if (!aHas && !bHas) return true;
  const tagsA = aHas ? extractInlineTags(a) : [];
  const tagsB = bHas ? extractInlineTags(b) : [];
  if (tagsA.length !== tagsB.length) return false;
  if (tagsA.length === 0) return true;
  const setA = new Set(tagsA);
  for (const t of tagsB) {
    if (!setA.has(t)) return false;
  }
  return true;
}

/** Whether `note` carries `tag` specifically inline in its markdown body. */
export function noteHasInlineTag(
  note: TagBearingNote,
  tag: string,
  isLocked = false,
): boolean {
  if (isLocked || !hasMarkdownBody(note.type) || !note.body || !note.body.includes('#')) {
    return false;
  }
  return extractInlineTags(note.body).includes(tag);
}
