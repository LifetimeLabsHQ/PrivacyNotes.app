/**
 * Cross-platform "save a Blob to disk".
 *
 * On web we use the classic hidden-anchor + `download` attribute trick. In the
 * native (Tauri) webview that trick is a silent no-op - the webview has no
 * download handler - so exports, "Save QR", and phrase backups all did nothing
 * on desktop. On native we instead open a Save As dialog and write the bytes
 * with the fs plugin.
 *
 * The web branch runs synchronously up to the anchor click, so the download
 * starts inside the user-gesture task that made the call.
 *
 * The native branch verifies what actually landed on disk before it resolves.
 * On Android `save()` is ACTION_CREATE_DOCUMENT, which creates the file the
 * moment the user taps Save, and on iOS the dialog exports an empty placeholder
 * before the app writes - so every way the following write can fail leaves a
 * real, empty or partial file behind. A caller that does not hear about the
 * failure is worse than useless here: the user walks away holding a backup
 * that will not restore. Reported as issue #193. So `saveBlob` never throws:
 * it resolves to what became of the file, and the sink check refuses any call
 * whose result is dropped.
 *
 * Spec: docs/contrib/gotchas.md (native webview has no download handler; Android
 * SAF writes need a truncate-free retry and a size check)
 */
import { detectPlatform } from './devices';
import { cleanFileName } from './fileNames';
import i18n from './i18n';

/**
 * What became of the file. A dismissed Save As dialog is the reader's own
 * choice, not a failure. A failed save may have left an empty or partial file
 * behind, so the caller tells the reader to check it.
 */
export type SaveResult =
  /** `path` is where the native Save As dialog put the file; the web
   *  download has no path the page can know. */
  | { ok: true; path?: string }
  | { ok: false; reason: 'cancelled' }
  /** `blockedFolder` is set when the reader picked a folder the desktop app
   *  never writes into; nothing was written. */
  | { ok: false; reason: 'failed'; error: unknown; blockedFolder?: string };

/**
 * The folders under the home folder that the desktop app never writes into:
 * credential folders, places where a file runs on its own, and the app's own
 * data. The write deny list in capabilities/default.json refuses them whatever
 * the Save As dialog allows; this copy only lets the app say why (issue #673).
 * Spec: packages/desktop/src-tauri/capabilities/default.json (fs:allow-write-file deny)
 */
export const PROTECTED_FOLDERS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
  '.config/gh',
  '.local/share/keyrings',
  'Library/LaunchAgents',
  'Applications',
  'bin',
  'AppData',
  'Documents/WindowsPowerShell',
  'Documents/PowerShell',
  'Library/Application Support/app.privacynotes',
  'Library/Caches/app.privacynotes',
  'Library/Logs/app.privacynotes',
  'Library/WebKit',
];

/** The protected folder `path` is inside, as a full path, or null. */
export function protectedFolder(path: string, home: string): string | null {
  const sep = home.includes('\\') ? '\\' : '/';
  const base = home.replace(/[\\/]+$/, '');
  const rel = path.replace(/\\/g, '/');
  const root = `${base.replace(/\\/g, '/')}/`;
  if (!rel.startsWith(root)) return null;
  const inside = rel.slice(root.length);
  const hit = PROTECTED_FOLDERS.find((folder) => inside.startsWith(`${folder}/`));
  return hit ? `${base}${sep}${hit.replaceAll('/', sep)}` : null;
}

/** The sentence for a failed save: why a protected folder refused it, or the caller's own. */
export function saveFailureText(saved: { blockedFolder?: string }, fallback: string): string {
  return saved.blockedFolder
    ? i18n.t('importExport:saveErrors.protectedFolder', { folder: saved.blockedFolder })
    : fallback;
}

class BlockedFolderError extends Error {
  constructor(readonly folder: string) {
    super(saveFailureText({ blockedFolder: folder }, ''));
  }
}

export async function saveBlob(blob: Blob, filename: string): Promise<SaveResult> {
  // Every caller's name, an attachment's from a note included, reaches the
  // browser's download and the native Save dialog in the same clean form.
  filename = cleanFileName(filename, 'download');
  if (detectPlatform() === 'web') {
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      // Defer revoke so the browser has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
    // The browser owns the download from here and reports nothing back.
    return { ok: true };
  }

  try {
    const path = await saveNative(blob, filename);
    return path ? { ok: true, path } : { ok: false, reason: 'cancelled' };
  } catch (error) {
    if (error instanceof BlockedFolderError) {
      return { ok: false, reason: 'failed', error, blockedFolder: error.folder };
    }
    return { ok: false, reason: 'failed', error };
  }
}

/** The saved path, or null when the reader dismisses the dialog; throws when
 *  the bytes did not all land. */
async function saveNative(blob: Blob, filename: string): Promise<string | null> {
  // Native: the webview cannot download, so prompt for a location and write the
  // bytes ourselves. `save` returns null when the user cancels the dialog.
  const [{ save }, fs] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const path = await save({ defaultPath: filename });
  if (!path) return null;
  // The fs plugin would refuse the write with a scope error that names no
  // reason, so the reader hears which folder and why before anything is written.
  if (detectPlatform() === 'desktop') {
    const { homeDir } = await import('@tauri-apps/api/path');
    const folder = protectedFolder(path, await homeDir());
    if (folder) throw new BlockedFolderError(folder);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());

  try {
    await fs.writeFile(path, bytes);
  } catch (err) {
    // plugin-fs opens the target in "wt" (write + truncate) mode. On Android
    // that mode reaches the DocumentsProvider behind the content:// URI, and
    // providers are free not to implement truncate - Drive-style ones reject
    // the open outright. The document the picker just created is empty by
    // definition, so appending is equivalent to writing: retry without the
    // truncate flag rather than hand back a 0-byte file. Only retry when the
    // target is confirmed still empty, so a write that died halfway can never
    // be appended to.
    if ((await fileSize(fs, path)) !== 0) throw err;
    await fs.writeFile(path, bytes, { append: true });
  }

  // Confirm the bytes are really there. `fileSize` returns null when the
  // platform cannot answer, and an unanswerable check must not fail a save
  // that probably worked - only a definite mismatch throws.
  const written = await fileSize(fs, path);
  if (written !== null && written !== bytes.length) {
    throw new Error(
      i18n.t('importExport:saveErrors.shortWrite', {
        written,
        expected: bytes.length,
      }),
    );
  }
  return path;
}

/** Bytes currently on disk at `path`, or null when the size cannot be read
 *  (stat unsupported for this target, permission denied, file gone). */
async function fileSize(
  fs: typeof import('@tauri-apps/plugin-fs'),
  path: string,
): Promise<number | null> {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return null;
  }
}
