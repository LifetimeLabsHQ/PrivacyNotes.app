/**
 * Which desktop asset addresses a picture may load (beta issue 86).
 *
 * The asset protocol serves a file from disk by its path, and the path is the
 * address: `asset://localhost/<path>` on macOS and Linux,
 * `http://asset.localhost/<path>` on Windows and Android. A note, a vault
 * item or a calendar event could spell one, and the app loaded it, a Windows
 * network path (`\\host\share`) included, which connects to that host and
 * hands it the account's NTLM response. So text never chooses an asset
 * address: only `resolveTauriAsset` in `fileAccess.ts` makes one, for a path
 * it checked stays inside the opened Markdown folder, and it records each
 * address it hands out here. The editor's image node (`EncryptedImage.tsx`)
 * and the renderer (`sanitizeImageSrc` in `markdownRender.ts`) refuse every
 * other one.
 * Spec: docs/internal/specs/markdown-folder.md (section 8, media)
 */

const issued = new Set<string>();

/** Record an address the folder resolver made. */
export function issueAssetUrl(url: string): string {
  issued.add(url);
  return url;
}

/**
 * True when `src` would load through the asset protocol. It is parsed the way
 * the web view reads it, so `//asset.localhost/x`, a backslash, a tab, upper
 * case or a percent-escaped dot in the host do not slip past.
 */
function isAssetSource(src: string): boolean {
  let url: URL;
  try {
    url = new URL(src.trim(), 'http://tauri.localhost/');
  } catch {
    return false;
  }
  if (url.protocol === 'asset:') return true;
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.replace(/\.$/, '') === 'asset.localhost';
}

/** True when a picture may load `src`: anything that is not an asset
 *  address, or an asset address the folder resolver made. */
export function allowedImageSource(src: string): boolean {
  return !isAssetSource(src) || issued.has(src);
}
