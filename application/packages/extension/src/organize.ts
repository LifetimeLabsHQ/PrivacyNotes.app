/**
 * Pure helpers for the extension's Folder & tags picker (#788): flatten the
 * synced folder tree into indented rows, format folder breadcrumb paths, merge
 * committed tag chips with an uncommitted draft, and rank tag suggestions.
 */
import { INBOX_NOTE_LIMITS, ORGANIZER_LIMITS, splitTagText, type OrganizerFolder } from '@notes/shared/extension';

export interface FlatFolder {
  folder: OrganizerFolder;
  depth: number;
  ancestors: string[];
  path: string;
}

const byOrder = (a: OrganizerFolder, b: OrganizerFolder) =>
  a.order - b.order || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/** Flatten `folders` into depth-first display order. Missing parents and cycles
 *  promote cleanly to the top level so nothing is ever hidden or infinite. */
export function flattenFolders(folders: readonly OrganizerFolder[]): FlatFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const children = new Map<string | null, OrganizerFolder[]>();
  const push = (parentId: string | null, folder: OrganizerFolder) => {
    const list = children.get(parentId);
    if (list) list.push(folder);
    else children.set(parentId, [folder]);
  };
  for (const f of folders) {
    const parent = f.parentId && f.parentId !== f.id && byId.has(f.parentId) ? f.parentId : null;
    push(parent, f);
  }
  for (const list of children.values()) list.sort(byOrder);

  const out: FlatFolder[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null, ancestors: string[]) => {
    for (const f of children.get(parentId) ?? []) {
      if (visited.has(f.id)) continue;
      visited.add(f.id);
      const path = ancestors.length ? `${ancestors.join(' / ')} / ${f.name}` : f.name;
      out.push({ folder: f, depth: ancestors.length, ancestors, path });
      walk(f.id, [...ancestors, f.name]);
    }
  };
  walk(null, []);
  // Any disconnected cycle lands at the root rather than disappearing.
  for (const f of [...folders].sort(byOrder)) {
    if (visited.has(f.id)) continue;
    visited.add(f.id);
    out.push({ folder: f, depth: 0, ancestors: [], path: f.name });
    walk(f.id, [f.name]);
  }
  return out;
}

/** Case-insensitive search across folder names and full paths. */
export function filterFolders(rows: readonly FlatFolder[], query: string): FlatFolder[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => r.folder.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
}

/** Breadcrumb parts for one folder id, or null when missing. */
export function folderPathOf(rows: readonly FlatFolder[], id: string | null): { ancestors: string[]; name: string } | null {
  if (!id) return null;
  const hit = rows.find((r) => r.folder.id === id);
  return hit ? { ancestors: hit.ancestors, name: hit.folder.name } : null;
}

/** Merge committed tags with any uncommitted draft text, deduped case-insensitively and capped. */
export function mergeTags(tags: readonly string[], draft: string, limit: number = INBOX_NOTE_LIMITS.tags): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...tags, ...splitTagText(draft)]) {
    const clean = raw.replace(/^#+/, '').trim().slice(0, ORGANIZER_LIMITS.tag);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

/** Up to `limit` suggested existing tags matching `draft` and not already chosen. */
export function tagSuggestions(
  knownTags: readonly string[],
  chosen: readonly string[],
  draft: string,
  limit = 5,
): string[] {
  const picked = new Set(chosen.map((t) => t.toLowerCase()));
  const q = draft.replace(/^#+/, '').trim().toLowerCase();
  const out: string[] = [];
  for (const tag of knownTags) {
    const low = tag.toLowerCase();
    if (picked.has(low)) continue;
    if (q && !low.includes(q)) continue;
    out.push(tag);
    if (out.length >= limit) break;
  }
  return out;
}
