#!/usr/bin/env node
// Writes public/_locales/<code>/messages.json from the `manifest` group of each
// locale's extension.json, and the name from the app's brand key. The browser
// reads these for the manifest's __MSG_*__ fields only; the popup and the
// menus read the catalogs through i18next. A locale without the catalog is skipped, so English alone builds.
// The locale list is SUPPORTED_LOCALES in packages/web/src/i18n.ts.
// Spec: docs/internal/plans/browser-extension-build.md (section 5, strings)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../../web/src');
const OUT = resolve(HERE, '../public/_locales');

const i18nSource = readFileSync(join(WEB, 'i18n.ts'), 'utf8');
const list = /export const SUPPORTED_LOCALES = \[([\s\S]*?)\]/.exec(i18nSource)?.[1];
if (!list) throw new Error('i18n.ts: SUPPORTED_LOCALES not found');
const locales = [...list.matchAll(/'([A-Za-z-]+)'/g)].map((m) => m[1]);

// The stores spell a region with an underscore: pt_BR, zh_TW.
const storeCode = (locale) => locale.replace('-', '_');

rmSync(OUT, { recursive: true, force: true });
let written = 0;
for (const locale of locales) {
  const file = join(WEB, 'locales', locale, 'extension.json');
  if (!existsSync(file)) continue;
  const manifest = JSON.parse(readFileSync(file, 'utf8')).manifest ?? {};
  // The name is the app's own brand key, never a second copy of it.
  const notesFile = join(WEB, 'locales', locale, 'notes.json');
  const brand = existsSync(notesFile) ? JSON.parse(readFileSync(notesFile, 'utf8')).settings?.groupBrand : undefined;
  const messages = Object.fromEntries(
    Object.entries({ extName: brand ?? 'PrivacyNotes', ...manifest }).map(([key, message]) => [key, { message }]),
  );
  const dir = join(OUT, storeCode(locale));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages, null, 2) + '\n');
  written += 1;
}
if (!existsSync(join(OUT, 'en', 'messages.json'))) throw new Error('no English extension catalog');
console.log(`extension locales: ${written} written`);
