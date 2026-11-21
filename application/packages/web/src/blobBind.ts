/**
 * The row binding of a file. A file's ciphertext carries no associated data,
 * so a party who can write the account's bucket could put file X at the path
 * of file Y. A file written once per random id needs only that id inside it.
 *
 * The id says whether the object is bound: a bound object has a uuid of its
 * own form (version nibble `8`; `crypto.randomUUID()` makes `4`), and a
 * reader requires the id inside such an object. Without that, an object with
 * no id would have to be taken, and any older file could replace a bound one.
 *
 * - An attachment carries the id in its JSON header. Old readers keep the
 *   extra key and ignore it.
 * - An image is raw bytes, so a bound image is a container: BLOB_MAGIC, a
 *   4-byte little-endian header length, the JSON header `{"id": ...}`, then
 *   the image. An old reader would show a broken picture.
 * New files of both kinds take a bound id only once NOTE_BIND_REQUIRED_FROM
 * has passed: an old app cannot sync then, and so cannot upload, under a
 * bound id from a backup, an object with no id inside (its restore keeps the
 * archive's ids). Every app reads both forms from now on.
 * Spec: docs/internal/plans/payload-row-binding.md (section 6)
 */
import { NOTE_BIND_REQUIRED_FROM } from '@notes/shared';

/** The first bytes of a bound image: no image format starts with them. */
// Spec: docs/internal/plans/payload-row-binding.md (section 6)
const BLOB_MAGIC = new Uint8Array([0x00, 0x50, 0x4e, 0x42, 0x49, 0x4e, 0x44, 0x31]); // \0PNBIND1

const utf8In = new TextDecoder();
const utf8Out = new TextEncoder();

/** A new id for an object that carries its id inside. */
export function boundBlobId(): string {
  const id = crypto.randomUUID();
  return `${id.slice(0, 14)}8${id.slice(15)}`;
}

/** Whether an object's id says the object carries its id inside. */
export function isBoundBlobId(uuid: string): boolean {
  return uuid.length === 36 && uuid[14] === '8';
}

/** Whether new files are written bound: after the switch date only. */
export function bindFilesNow(requiredFrom: string | null = NOTE_BIND_REQUIRED_FROM, now = Date.now()): boolean {
  if (requiredFrom === null) return false;
  const from = Date.parse(requiredFrom);
  return Number.isFinite(from) && now >= from;
}

/** The id a new file takes. */
export function newBlobId(): string {
  return bindFilesNow() ? boundBlobId() : crypto.randomUUID();
}

function startsWithMagic(bytes: Uint8Array): boolean {
  if (bytes.length < BLOB_MAGIC.length + 4) return false;
  for (let i = 0; i < BLOB_MAGIC.length; i++) if (bytes[i] !== BLOB_MAGIC[i]) return false;
  return true;
}

/** The bytes an image object holds: the container for a bound id, the raw
 *  image for any other. */
export function sealedImageBytes(uuid: string, image: Uint8Array): Uint8Array {
  if (!isBoundBlobId(uuid)) return image;
  const header = utf8Out.encode(JSON.stringify({ id: uuid.toLowerCase() }));
  const out = new Uint8Array(BLOB_MAGIC.length + 4 + header.length + image.length);
  out.set(BLOB_MAGIC, 0);
  const n = header.length;
  out.set([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff], BLOB_MAGIC.length);
  out.set(header, BLOB_MAGIC.length + 4);
  out.set(image, BLOB_MAGIC.length + 4 + n);
  return out;
}

/** The image inside an opened object, or null when the object is not the one
 *  `uuid` names: a container for another id, or a bound id with no container. */
export function openedImageBytes(uuid: string, opened: Uint8Array): Uint8Array | null {
  if (!startsWithMagic(opened)) return isBoundBlobId(uuid) ? null : opened;
  const at = BLOB_MAGIC.length;
  const n = opened[at]! | (opened[at + 1]! << 8) | (opened[at + 2]! << 16) | (opened[at + 3]! << 24);
  if (n < 2 || n > 1000 || at + 4 + n > opened.length) return null;
  let header: unknown;
  try {
    header = JSON.parse(utf8In.decode(opened.subarray(at + 4, at + 4 + n)));
  } catch {
    return null;
  }
  const id = (header as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || id.toLowerCase() !== uuid.toLowerCase()) return null;
  return opened.slice(at + 4 + n);
}

/** Whether an attachment header names the object it was read from: an `id`
 *  that matches, or no `id` on an object whose id is not bound. */
export function attachmentHeaderFits(uuid: string, header: { id?: unknown }): boolean {
  if (header.id === undefined) return !isBoundBlobId(uuid);
  return typeof header.id === 'string' && header.id.toLowerCase() === uuid.toLowerCase();
}
