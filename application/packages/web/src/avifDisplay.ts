/**
 * AVIF pictures in the Linux app.
 *
 * WebKitGTK is built without an AVIF decoder on Ubuntu, Linux Mint and
 * Debian, so an AVIF picture stored from a phone or a browser drew as a
 * broken image in the Linux app (GitHub #687). There the bytes go to the
 * native side, which answers a PNG. Every other platform draws AVIF itself,
 * and the content security policy rules out a WebAssembly decoder here.
 *
 * Spec: docs/contrib/gotchas.md (AppImage AVIF)
 */
import { isLinuxNative } from './devices';

/** An ISO-BMFF file whose ftyp box names an AVIF brand, major or compatible. */
export function isAvifBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const brand = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (brand(4) !== 'ftyp') return false;
  const boxEnd = Math.min((bytes[0]! << 24 | bytes[1]! << 16 | bytes[2]! << 8 | bytes[3]!) >>> 0, bytes.length, 64);
  for (let at = 8; at + 4 <= boxEnd; at += 4) {
    const b = brand(at);
    if (b === 'avif' || b === 'avis') return true;
  }
  return false;
}

/**
 * Bytes the webview can draw, and their type when that changed. Anything but
 * an AVIF in the Linux app comes back as it is, and so does an AVIF the
 * native side cannot decode: it stays the broken picture it was.
 */
export async function drawablePicture(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mime?: string }> {
  if (!isLinuxNative() || !isAvifBytes(bytes)) return { bytes };
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const png = await invoke<ArrayBuffer>('decode_avif', bytes);
    return { bytes: new Uint8Array(png), mime: 'image/png' };
  } catch {
    return { bytes };
  }
}
