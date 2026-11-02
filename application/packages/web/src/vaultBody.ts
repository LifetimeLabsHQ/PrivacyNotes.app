import { attachmentLinks, cleanFileName } from './fileNames';

/**
 * Every key of a stored vault body, as an object to spread under the fields
 * a form writes.
 *
 * The login, card and SSH key forms save an item by writing the fields they
 * know. A newer version can store more keys in the same JSON body, and a save
 * from here must carry them back unchanged: a dropped key is data lost, and a
 * dropped `pn:file/` reference lets blob GC delete the file it names. The
 * caller writes its own fields after the spread, so they always win.
 */
export function storedVaultKeys(previous: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(previous);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The body a vault or contact form saves when the stored item changed while
 * the form was open. `base` is the body the form opened on, `draft` what it
 * would write, `current` the body stored now (another device's edit may have
 * landed). Each top-level key the form changed takes the draft's value; every
 * other key keeps the current one. Without this, Save wrote the whole draft
 * and undid the other device's change with no conflict (external report,
 * 2026-10-24). A body that is not a JSON object falls back to the draft.
 */
export function mergeVaultDraft(base: string, draft: string, current: string): string {
  if (current === base || current === draft) return draft;
  const parse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const b = parse(base);
  const d = parse(draft);
  const c = parse(current);
  if (!b || !d || !c) return draft;
  const out: Record<string, unknown> = { ...c };
  for (const key of new Set([...Object.keys(b), ...Object.keys(d)])) {
    if (JSON.stringify(d[key]) === JSON.stringify(b[key])) continue;
    if (key in d) out[key] = d[key];
    else delete out[key];
  }
  return JSON.stringify(out);
}

/** One file on a vault item: the fields of its `[name|size|mime](pn:file/<uuid>)` link. */
export type VaultFile = { uuid: string; name: string; size: string; mime: string };

/**
 * The files of a login, card or SSH key: the `files` key of its body, a list
 * of the same `[name|size|mime](pn:file/<uuid>)` links a note body holds. The
 * link form is what blob GC, the orphan reconcile, the Files pillar and the
 * full backup and its restore already find in a body as text, so a vault
 * file needs nothing of its own there. A malformed entry is skipped.
 * Spec: docs/internal/issues/0563.md
 */
export function vaultFiles(body: string): VaultFile[] {
  const list = storedVaultKeys(body).files;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (typeof entry !== 'string') return [];
    const link = attachmentLinks(entry)[0];
    return link ? [{ uuid: link.uuid, name: link.name, size: link.size, mime: link.mime }] : [];
  });
}

const VAULT_FILE_TYPES = new Set(['login', 'card', 'ssh-key']);

/**
 * The files a note names, read the way its body is written. A note body is
 * markdown and `attachmentLinks` reads it as text. A vault body is JSON on
 * one line, where the array's own bracket, or a `[` in a password, opens a
 * link that runs into the first file's fields, so its names come only
 * through `vaultFiles`. The uuid, which blob GC reads, is right either way.
 */
export function noteFileLinks(note: { type?: string; body: string }): VaultFile[] {
  if (VAULT_FILE_TYPES.has(note.type ?? '')) return vaultFiles(note.body);
  return attachmentLinks(note.body).map(({ uuid, name, size, mime }) => ({ uuid, name, size, mime }));
}

/** True for the note types whose files live in a JSON body (`vaultFiles`). */
export function hasVaultFiles(type: string | undefined): boolean {
  return VAULT_FILE_TYPES.has(type ?? '');
}

/** The body with `files` set to these files, every other key kept. An empty list removes the key. */
export function withVaultFiles(body: string, files: VaultFile[]): string {
  const { files: _old, ...rest } = storedVaultKeys(body);
  if (files.length === 0) return JSON.stringify(rest);
  return JSON.stringify({
    ...rest,
    files: files.map((f) => `[${cleanFileName(f.name, 'Attachment')}|${f.size}|${f.mime}](pn:file/${f.uuid})`),
  });
}
