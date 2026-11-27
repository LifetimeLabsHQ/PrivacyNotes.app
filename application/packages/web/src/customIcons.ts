/**
 * User-uploaded custom icons, kept in the encrypted settings blob as
 * `customIcons`: one register per icon id, whose value is a compact 48x48
 * image data URL (WebP, PNG or JPEG, <= 5 KB raw) and null once deleted.
 *
 * Folders, tags, notes, calendars and custom trackers point at one via
 * `custom:<id>` in `itemStyles` (well under its 64-char limit). Older builds
 * pass both the unknown top-level `customIcons` key and any `custom:<id>`
 * icon value through untouched and draw their default glyph.
 *
 * Every entry is strictly validated as a raster base64 data URL (never SVG,
 * never an external URL) within the byte budget so untrusted or corrupted
 * settings data cannot inject active content or bloat the settings blob.
 *
 * Spec: docs/internal/specs/folder-tag-icons.md (section 3.9)
 */
import {
  mergeRegisterMaps,
  newRegisterId,
  REGISTER_ID,
  registerMapsEqual,
  stampAfter,
  validateRegisterMap,
  type RegisterMap,
} from './registers';

export type CustomIcons = RegisterMap;

/** Target square dimension for custom icons in physical pixels (48x48). */
export const CUSTOM_ICON_PX = 48;

/** Target square dimension for custom theme app icons in physical pixels (80x80 for crisp 2x sidebar display). */
export const THEME_ICON_PX = 80;

/** Maximum number of live custom icons per account (6 clean rows of 8 in the picker). */
export const CUSTOM_ICON_MAX = 48;

/** Maximum number of live custom theme icons (1 per custom theme). */
const THEME_ICON_MAX = 50;

/** Maximum raw image byte size per custom icon (5 KB). */
export const CUSTOM_ICON_MAX_BYTES = 5 * 1024;

/** Look id prefix stored in `itemStyles`. */
const CUSTOM_ICON_PREFIX = 'custom:';

/** Max string length for a base64 data URL holding CUSTOM_ICON_MAX_BYTES raw bytes. */
const DATA_URL_MAX = 7000;

const DATA_URL_RE = /^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/]+=*)$/;

const isCustomIconKey = (id: string) => REGISTER_ID.test(id);

/** Whether a look icon id points to a user-uploaded custom icon (`custom:<id>`). */
export function isCustomIconId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(CUSTOM_ICON_PREFIX) && isCustomIconKey(id.slice(CUSTOM_ICON_PREFIX.length));
}

/** The 12-char register key behind a `custom:<id>` look id, or null. */
export function customIconKey(id: string | null | undefined): string | null {
  return isCustomIconId(id) ? id!.slice(CUSTOM_ICON_PREFIX.length) : null;
}

/** Build the `custom:<id>` look id for a register key. */
export function customIconLookId(key: string): string {
  return `${CUSTOM_ICON_PREFIX}${key}`;
}

/** Exact decoded byte size of a base64 string, or -1 if malformed. */
function decodedBase64Bytes(b64: string): number {
  if (b64.length === 0 || b64.length % 4 !== 0) return -1;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** Strict validation: raster image data URL (WebP/PNG/JPEG) within the 5 KB raw budget. */
export function isValidCustomIconDataUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > DATA_URL_MAX) return false;
  const m = DATA_URL_RE.exec(v);
  if (!m) return false;
  const bytes = decodedBase64Bytes(m[2]!);
  return bytes > 0 && bytes <= CUSTOM_ICON_MAX_BYTES;
}

/** Sanitize a raw map from a settings blob or a backup. */
export function validateCustomIcons(raw: unknown, now = Date.now()): CustomIcons {
  const base = validateRegisterMap(raw, isCustomIconKey, DATA_URL_MAX, now);
  const out: CustomIcons = {};
  for (const [id, reg] of Object.entries(base)) {
    if (reg.v === null || isValidCustomIconDataUrl(reg.v)) {
      out[id] = reg;
    }
  }
  return out;
}

export function mergeCustomIcons(local: CustomIcons, remote: CustomIcons, now = Date.now()): CustomIcons {
  return mergeRegisterMaps(local, remote, now);
}

export const customIconsEqual = registerMapsEqual;

/** A fresh custom icon id: twelve lower-case letters and digits. */
export function newCustomIconId(): string {
  return newRegisterId();
}

export interface LiveCustomIcon {
  id: string;
  lookId: string;
  dataUrl: string;
  at: string;
}

/** Live (non-deleted) custom icons, newest first so freshly uploaded icons lead the grid. */
export function liveCustomIcons(icons: CustomIcons): LiveCustomIcon[] {
  const out: LiveCustomIcon[] = [];
  for (const [id, reg] of Object.entries(icons)) {
    if (typeof reg.v === 'string' && isValidCustomIconDataUrl(reg.v)) {
      out.push({ id, lookId: customIconLookId(id), dataUrl: reg.v, at: reg.at });
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id.localeCompare(b.id)));
  return out;
}

/** Look up the validated data URL for a `custom:<id>` look id, or null if missing/deleted. */
export function customIconDataUrl(icons: CustomIcons | undefined, lookId: string | null | undefined): string | null {
  if (!icons) return null;
  const key = customIconKey(lookId);
  if (!key) return null;
  const v = icons[key]?.v;
  return isValidCustomIconDataUrl(v) ? v : null;
}

/** Whether a save under this id fits within CUSTOM_ICON_MAX. */
export function canSaveCustomIcon(icons: CustomIcons, id: string): boolean {
  if (typeof icons[id]?.v === 'string') return true;
  return liveCustomIcons(icons).length < CUSTOM_ICON_MAX;
}

/** Save a validated custom icon data URL under `id`. Refuses invalid data or writes past the cap. */
export function saveCustomIcon(icons: CustomIcons, id: string, dataUrl: string): CustomIcons {
  if (!isCustomIconKey(id) || !isValidCustomIconDataUrl(dataUrl) || !canSaveCustomIcon(icons, id)) return icons;
  const prev = icons[id];
  if (prev?.v === dataUrl) return icons;
  return { ...icons, [id]: { v: dataUrl, at: stampAfter(prev?.at) } };
}

/** Delete a custom icon. The null tombstone syncs so other devices drop it too. */
export function deleteCustomIcon(icons: CustomIcons, id: string): CustomIcons {
  const prev = icons[id];
  if (!prev || prev.v === null) return icons;
  return { ...icons, [id]: { v: null, at: stampAfter(prev.at) } };
}

/** Look up the validated custom icon data URL for a theme id, or null if none. */
export function themeIconDataUrl(icons: CustomIcons | undefined, themeId: string | null | undefined): string | null {
  if (!icons || !themeId || !isCustomIconKey(themeId)) return null;
  const v = icons[themeId]?.v;
  return isValidCustomIconDataUrl(v) ? v : null;
}

/** Save a validated custom app icon for `themeId` (1 icon per custom theme). */
export function saveThemeIcon(icons: CustomIcons, themeId: string, dataUrl: string): CustomIcons {
  if (!isCustomIconKey(themeId) || !isValidCustomIconDataUrl(dataUrl)) return icons;
  const prev = icons[themeId];
  if (prev?.v === dataUrl) return icons;
  if (typeof prev?.v !== 'string' && liveCustomIcons(icons).length >= THEME_ICON_MAX) return icons;
  return { ...icons, [themeId]: { v: dataUrl, at: stampAfter(prev?.at) } };
}
