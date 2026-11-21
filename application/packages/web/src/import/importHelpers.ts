/**
 * Small readers more than one importer needs: zip paths, tags, dates, loose
 * JSON values, note-links and inline alignment. Each importer calls these
 * instead of keeping a copy (rule AD).
 */
import { normalizeTag } from '../notesRepo';
import { noteLinkTarget } from '../noteLinks';
import { mapOutsideCode } from './codeSegments';

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

/** A `<` that would open raw HTML: before a letter, `/`, `!` or `?`, and not
 *  an autolink (`<https://x.com>`, `<me@x.com>`), which stays a link. */
const TAG_OPEN_RE = /(?<!\\)<(?=[A-Za-z/!?])(?![A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>|[^\s<>@]+@[^\s<>]+>)/g;

/**
 * Typed text that is Markdown already, with each `<` that would open an HTML
 * tag escaped. The editor reads raw HTML, so `<url>`, `<your-api-key>` or
 * `List<T>` is an unknown tag there: the word is not shown, and the next save
 * drops it. `a < b > c` needs nothing and is left as it is, and so are code
 * spans and fences. Run it on text only, before the importer adds its own
 * tags (`<u>`, `<sup>`). Beta #149.
 */
export function escapeTypedTags(md: string): string {
  return md.includes('<') ? mapOutsideCode(md, (prose) => prose.replace(TAG_OPEN_RE, '\\<')) : md;
}

interface FrontMatter {
  values: Map<string, string[]>;
  body: string;
}

function unquoteYaml(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // YAML's \U and \u escapes, which JSON does not have in that form.
    const yaml = s.replace(/\\U([0-9a-fA-F]{8})|\\u([0-9a-fA-F]{4})/g, (whole, long: string | undefined, short: string | undefined) => {
      const cp = parseInt(long ?? short ?? '', 16);
      return cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
    });
    if (yaml !== s) return yaml.slice(1, -1);
    try {
      const parsed: unknown = JSON.parse(s);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* not JSON-shaped: strip the quotes only */
    }
    return s.slice(1, -1);
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Flat YAML front matter, as Anytype and Capacities write it: `Key: value`,
 *  or `Key:` and a list of `- item` lines. A flow list `[a, b]` stays one
 *  value; the caller splits it. */
export function splitFrontMatter(text: string): FrontMatter {
  const values = new Map<string, string[]>();
  const t = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return { values, body: t };
  const end = t.indexOf('\n---\n', 3);
  const endAtEof = end < 0 && t.endsWith('\n---') ? t.length - 4 : -1;
  const stop = end >= 0 ? end : endAtEof;
  if (stop < 0) return { values, body: t };
  let key = '';
  for (const line of t.slice(4, stop).split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const item = /^\s+-\s?(.*)$/.exec(line);
    if (item && key) {
      values.get(key)!.push(unquoteYaml(item[1]!));
      continue;
    }
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1]!.trim();
    values.set(key, kv[2]!.trim() ? [unquoteYaml(kv[2]!)] : []);
  }
  return { values, body: t.slice(stop + 5) };
}
