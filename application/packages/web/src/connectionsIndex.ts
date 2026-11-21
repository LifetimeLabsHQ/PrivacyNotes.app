import { noteLinkKey, noteLinkTargets, parseNoteLinkTarget } from './noteLinks';
import { extractAttachmentIds } from './mediaRefs';

/**
 * Which items link to which, read from the note bodies on this device: the
 * data behind the Connections panel (backlinks).
 *
 * A link counts only when a click on it would open one item. That is the
 * resolution `navigateToNoteByTitle` runs (whole title first, then the key),
 * so a title two notes share links to neither of them here, as a click
 * offers a choice instead of following it.
 *
 * Sources are the notes whose body is markdown, and the items whose form has a
 * notes field (a contact, a login): `textOf` hands over the text to read, the
 * body or that field. Any item can be a target. A
 * PIN-protected source is never listed, only counted, so the panel says how
 * many it left out without naming them.
 * Spec: docs/internal/issues/0351.md (Spec)
 */

type Item = { id: string; title: string; body: string; pinProtected?: number };

export type LinkIndex = {
  /** Target id to the ids of the listable notes that link to it. */
  incoming: Map<string, string[]>;
  /** Target id to how many PIN-protected notes link to it. */
  protectedIncoming: Map<string, number>;
  /** Source id to the ids it links to, and the targets no item carries. */
  outgoing: Map<string, { ids: string[]; missing: string[] }>;
};

/**
 * The resolver a click runs, built once over the items: the exact title (any
 * case) first, then the key. A scan of every item per link costs half a
 * second on a library of a few thousand notes, so it is two lookup maps.
 */
export function linkResolver<T extends Item>(items: readonly T[], nameOf: (item: T) => string) {
  const byExact = new Map<string, T[]>();
  const byKey = new Map<string, T[]>();
  const add = (map: Map<string, T[]>, k: string, n: T) => {
    const list = map.get(k);
    if (list) list.push(n);
    else map.set(k, [n]);
  };
  for (const n of items) {
    const name = nameOf(n);
    add(byExact, name.toLowerCase(), n);
    const key = noteLinkKey(name);
    if (key) add(byKey, key, n);
  }
  const hasNote = (name: string) => byKey.has(noteLinkKey(name));
  const resolve = (note: string): T[] => {
    const exact = byExact.get(note.toLowerCase());
    if (exact) return exact;
    const key = noteLinkKey(note);
    return key ? byKey.get(key) ?? [] : [];
  };
  return { hasNote, resolve };
}

/**
 * The items one body links to, as a click resolves them, and the targets no
 * item carries. A title two items share links to neither; a link to the
 * source itself does not count.
 */
export function linksInBody<T extends Item>(
  body: string,
  sourceId: string,
  { hasNote, resolve }: ReturnType<typeof linkResolver<T>>,
): { ids: string[]; missing: string[] } {
  const ids = new Set<string>();
  const missing = new Map<string, string>();
  for (const target of noteLinkTargets(body)) {
    const { note } = parseNoteLinkTarget(target, hasNote);
    // `[[#Heading]]` points into the note that holds it.
    if (note === '') continue;
    const matches = resolve(note);
    if (matches.length === 0) {
      const key = noteLinkKey(note);
      if (key && !missing.has(key)) missing.set(key, note);
      continue;
    }
    if (matches.length > 1) continue;
    const match = matches[0]!;
    if (match.id !== sourceId) ids.add(match.id);
  }
  return { ids: [...ids], missing: [...missing.values()] };
}

export function buildLinkIndex<T extends Item>(
  items: readonly T[],
  {
    nameOf,
    isSource,
    textOf,
  }: {
    /** The name a note-link finds the item by (`noteLinkName`). */
    nameOf: (item: T) => string;
    /** False for an item that holds no text a note-link can sit in. */
    isSource: (item: T) => boolean;
    /** The text that holds its links: the body (the default), or a form's notes field. */
    textOf?: (item: T) => string;
  },
): LinkIndex {
  const incoming = new Map<string, string[]>();
  const protectedIncoming = new Map<string, number>();
  const outgoing = new Map<string, { ids: string[]; missing: string[] }>();
  const resolver = linkResolver(items, nameOf);

  for (const source of items) {
    if (!isSource(source)) continue;
    const text = textOf ? textOf(source) : source.body;
    if (!text.includes('[[')) continue;
    const isProtected = source.pinProtected === 1;
    const out = linksInBody(text, source.id, resolver);
    outgoing.set(source.id, out);
    for (const id of out.ids) {
      if (isProtected) {
        protectedIncoming.set(id, (protectedIncoming.get(id) ?? 0) + 1);
      } else {
        const list = incoming.get(id);
        if (list) list.push(source.id);
        else incoming.set(id, [source.id]);
      }
    }
  }
  return { incoming, protectedIncoming, outgoing };
}

/** The notes that use one file item, and how many PIN-protected ones do (only counted). */
export type FileUse = { ids: string[]; hidden: number };

/**
 * Which notes use each file item (#852): the items that hold one of its files
 * (a file chip, or a picture placed from Files, both `pn:file/<uuid>`) and the
 * items that note-link to it. Files shows the first one on the file's row,
 * and the file's Connections panel lists them all. A file item with no use is
 * an unused file. A PIN-protected item is only counted, as in the backlinks,
 * so a file it uses is still in use.
 * Spec: docs/internal/issues/0852.md
 */
export function buildFileUses<T extends Item & { type?: string }>(
  items: readonly T[],
  index: Pick<LinkIndex, 'incoming' | 'protectedIncoming'>,
): Map<string, FileUse> {
  const uses = new Map<string, { ids: Set<string>; hidden: Set<string>; protectedLinks: number }>();
  const filesOf = new Map<string, string[]>();
  for (const item of items) {
    if (item.type !== 'file') continue;
    uses.set(item.id, { ids: new Set(index.incoming.get(item.id)), hidden: new Set(), protectedLinks: index.protectedIncoming.get(item.id) ?? 0 });
    for (const uuid of extractAttachmentIds(item.body)) {
      const list = filesOf.get(uuid);
      if (list) list.push(item.id);
      else filesOf.set(uuid, [item.id]);
    }
  }
  if (uses.size === 0) return new Map();
  for (const item of items) {
    if (!item.body.includes('pn:file/')) continue;
    for (const uuid of extractAttachmentIds(item.body)) {
      for (const fileId of filesOf.get(uuid) ?? []) {
        if (fileId === item.id) continue;
        const use = uses.get(fileId)!;
        if (item.pinProtected === 1) use.hidden.add(item.id);
        else use.ids.add(item.id);
      }
    }
  }
  const out = new Map<string, FileUse>();
  for (const [id, use] of uses) out.set(id, { ids: [...use.ids], hidden: use.hidden.size + use.protectedLinks });
  return out;
}
