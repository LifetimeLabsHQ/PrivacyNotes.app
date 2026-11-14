import { bytesToHex } from '@notes/shared';

/** SHA-256 of the bytes as lowercase hex, through WebCrypto. The one helper
 *  for a content hash: the blob stores' dedup keys, the importers, the
 *  backups and the model check. */
export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as ArrayBufferView<ArrayBuffer> | ArrayBuffer);
  return bytesToHex(new Uint8Array(digest));
}
