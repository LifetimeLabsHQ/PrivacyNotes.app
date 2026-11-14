/**
 * Small readers more than one importer needs: zip paths, tags, dates, loose
 * JSON values, note-links and inline alignment. Each importer calls these
 * instead of keeping a copy (rule AD).
 */
import { normalizeTag } from '../notesRepo';
import { noteLinkTarget } from '../noteLinks';

/** A zip entry that is never note content: macOS resource forks and dot files. */
export function isJunkEntry(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.startsWith('__macosx/') || lower.includes('/__macosx/')) return true;
  const name = path.split('/').pop() ?? '';
  if (name.startsWith('.')) return true;
  return false;
}

/** A zip entry name with the leading slashes and dot segments gone, or null for a path that climbs. */
export function cleanPath(path: string): string | null {
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/**
 * Tags through `normalizeTag`, deduplicated case-insensitively: "Dev" and
 * "dev" are one tag and the first spelling stays.
 */
export function normalizeTagList(rawTags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTags) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** A date string as ISO, or now when it is missing or unreadable. */
export function isoOrNow(s: string | undefined): string {
  if (!s) return new Date().toISOString();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

/** A finite number from loose JSON, else null. */
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A string from loose JSON, else empty. */
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * A note-link to another note's title. The target goes through
 * `noteLinkTarget` because a real title can hold a pipe or a bracket, and
 * writing one raw produces a link that parses as a different target with
 * different text. The sanitized target still resolves: `noteLinkKey`
 * compares it to the note's real title through the same rule.
 * Spec: packages/web/src/noteLinks.ts
 */
export function noteLink(target: string, label: string): string {
  const t = noteLinkTarget(target);
  const l = label.replace(/[[\]]/g, '').trim();
  if (!t) return l;
  if (!l || l === t) return `[[${t}]]`;
  return `[[${t}|${l}]]`;
}

/** An inline `text-align` other than the default, in an exported HTML style. */
export const ALIGN_RE = /text-align:\s*(center|right|justify)/i;
