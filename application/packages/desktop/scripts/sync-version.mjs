#!/usr/bin/env node
// Sync the native build version from the single source of truth (web/src/version.ts)
// into tauri.conf.json, Cargo.toml, Cargo.lock, the Android version stamp and the iOS share
// extension's Info.plist, and the language list (SUPPORTED_LOCALES in
// web/src/i18n.ts) into both Info.plist files. Runs
// automatically before every Tauri dev/build (wired into
// beforeDevCommand/beforeBuildCommand in tauri.conf.json).
// Spec: docs/internal/commit-workflow.md (version single source)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve everything from this script's location so the cwd never matters.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const versionTsPath = resolve(root, 'packages/web/src/version.ts');
const versionTs = readFileSync(versionTsPath, 'utf8');
const match = versionTs.match(/export const VERSION = '([^']+)'/);
if (!match) {
  console.error('sync-version: could not find VERSION in', versionTsPath);
  process.exit(1);
}
const version = match[1];

const updated = [];

// tauri.conf.json: top-level "version": "x.y.z"
const confPath = resolve(root, 'packages/desktop/src-tauri/tauri.conf.json');
const conf = readFileSync(confPath, 'utf8');
const confNext = conf.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
if (confNext !== conf) {
  writeFileSync(confPath, confNext);
  updated.push('tauri.conf.json');
}

// Cargo.toml: the version line inside the [package] section only
const cargoPath = resolve(root, 'packages/desktop/src-tauri/Cargo.toml');
const cargo = readFileSync(cargoPath, 'utf8');
const cargoNext = cargo.replace(/(\[package\][^[]*?\nversion\s*=\s*")[^"]+(")/, `$1${version}$2`);
if (cargoNext !== cargo) {
  writeFileSync(cargoPath, cargoNext);
  updated.push('Cargo.toml');
}

// Cargo.lock: the app's own `version` line, the one under `name = "privacynotes"`.
// Left behind, cargo has to rewrite the lockfile on every build, so a release
// could never run with `--locked` and would resolve a crate the commit does not
// pin (beta #236 item 1). Nothing else in the lockfile is touched.
const lockPath = resolve(root, 'packages/desktop/src-tauri/Cargo.lock');
const lock = readFileSync(lockPath, 'utf8');
const lockNext = lock.replace(/(\[\[package\]\]\r?\nname = "privacynotes"\r?\nversion = ")[^"]+(")/, `$1${version}$2`);
if (lockNext !== lock) {
  writeFileSync(lockPath, lockNext);
  updated.push('Cargo.lock');
}

// gen/android/app/tauri.properties: the versionName/versionCode gradle actually reads.
// Tauri writes it at `android init` and does not reliably refresh it afterwards, so without
// this an AAB ships new code under the previous stamp, which Play rejects as a duplicate
// versionCode. Skipped when the Android project has never been generated on this machine.
// Spec: docs/internal/android-setup.md (Android version stamp)
const androidPropsPath = resolve(
  root,
  'packages/desktop/src-tauri/gen/android/app/tauri.properties',
);
if (existsSync(androidPropsPath)) {
  const [major, minor, patch] = version.split('.').map(Number);
  // The encoding gives minor and patch 3 digits each, so either one reaching 1000 would
  // silently collide with the next major. Fail the build instead: a duplicate versionCode
  // cannot be un-published once Play has seen it.
  if (![major, minor, patch].every(Number.isInteger) || minor > 999 || patch > 999) {
    console.error(`sync-version: cannot encode "${version}" as an Android versionCode`);
    process.exit(1);
  }
  const versionCode = major * 1000000 + minor * 1000 + patch;
  const props = readFileSync(androidPropsPath, 'utf8');
  const propsNext = props
    .replace(/^(tauri\.android\.versionName=).*$/m, `$1${version}`)
    .replace(/^(tauri\.android\.versionCode=).*$/m, `$1${versionCode}`);
  if (propsNext !== props) {
    writeFileSync(androidPropsPath, propsNext);
    updated.push(`tauri.properties (versionCode ${versionCode})`);
  }
}

// The iOS share extension: App Store Connect refuses an upload whose extension
// version differs from the app's, and Tauri stamps only the app's own plist.
// Spec: docs/internal/specs/share-into-app.md
const sharePlistPath = resolve(root, 'packages/desktop/src-tauri/ios-share/Info.plist');
const sharePlist = readFileSync(sharePlistPath, 'utf8');
const sharePlistNext = sharePlist.replace(
  /(<key>(?:CFBundleShortVersionString|CFBundleVersion)<\/key>\s*<string>)[^<]*(<\/string>)/g,
  `$1${version}$2`,
);
if (sharePlistNext !== sharePlist) {
  writeFileSync(sharePlistPath, sharePlistNext);
  updated.push('ios-share/Info.plist');
}

// CFBundleLocalizations: the languages the macOS and iOS bundles declare. iOS hands
// the webview only those of the phone's languages the bundle declares, so a missing
// entry opens the app in English on a phone set to that language. The shared
// Info.plist is the one that ships: the macOS bundle takes it as it is, and Tauri
// merges it over the generated iOS plist on every iOS build, whole arrays included.
// The generated copy is written too, so the tracked file matches what that merge
// writes back into it; a freshly re-initialized one without the key is left alone,
// because the next iOS build merges the key in. Apple knows Traditional Chinese by
// its script tag.
// Spec: docs/contrib/i18n-spec.md section 10d (wiring checklist)
const i18nPath = resolve(root, 'packages/web/src/i18n.ts');
const declared = readFileSync(i18nPath, 'utf8').match(/SUPPORTED_LOCALES = \[([\s\S]*?)\] as const;/);
if (!declared) {
  console.error('sync-version: could not find SUPPORTED_LOCALES in', i18nPath);
  process.exit(1);
}
const localizations = [...(declared[1] ?? '').matchAll(/'([^']+)'/g)].map((m) =>
  m[1] === 'zh-TW' ? 'zh-Hant' : m[1],
);
const LOCALIZATIONS = /(<key>CFBundleLocalizations<\/key>\s*<array>)[\s\S]*?\n([ \t]*)(<\/array>)/;
for (const [plistRel, required] of [
  ['Info.plist', true],
  ['gen/apple/privacynotes_iOS/Info.plist', false],
]) {
  const plistPath = resolve(root, 'packages/desktop/src-tauri', plistRel);
  const plist = existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : '';
  if (!LOCALIZATIONS.test(plist)) {
    if (!required) continue;
    console.error('sync-version: no CFBundleLocalizations array in', plistPath);
    process.exit(1);
  }
  const plistNext = plist.replace(LOCALIZATIONS, (_, open, indent, close) =>
    [open, ...localizations.map((tag) => `${indent}\t<string>${tag}</string>`), `${indent}${close}`].join('\n'),
  );
  if (plistNext !== plist) {
    writeFileSync(plistPath, plistNext);
    updated.push(`${plistRel} (CFBundleLocalizations)`);
  }
}

// The share extension's UI strings, from the web catalogs, so the locale checks
// that guard every other string guard these too. A locale whose catalog lacks
// the base messages gets no folder, and iOS falls back to English for any newer
// key a locale does not carry yet. Apple knows Traditional Chinese by its
// script tag, as above.
// Spec: docs/internal/specs/share-into-app.md
for (const lang of readdirSync(resolve(root, 'packages/web/src/locales'))) {
  const dirPath = resolve(root, 'packages/web/src/locales', lang);
  const shellPath = resolve(dirPath, 'shell.json');
  if (!existsSync(shellPath)) continue;
  const shell = JSON.parse(readFileSync(shellPath, 'utf8'));
  const texts = shell.shareInbox;
  if (!texts?.saved || !texts?.failed || !texts?.tooLarge) continue;
  const commonPath = resolve(dirPath, 'common.json');
  const notesPath = resolve(dirPath, 'notes.json');
  const editorPath = resolve(dirPath, 'editor.json');
  const extensionPath = resolve(dirPath, 'extension.json');
  const common = existsSync(commonPath) ? JSON.parse(readFileSync(commonPath, 'utf8')) : {};
  const notes = existsSync(notesPath) ? JSON.parse(readFileSync(notesPath, 'utf8')) : {};
  const editor = existsSync(editorPath) ? JSON.parse(readFileSync(editorPath, 'utf8')) : {};
  const extension = existsSync(extensionPath) ? JSON.parse(readFileSync(extensionPath, 'utf8')) : {};
  const entries = [
    ['saved', texts.saved],
    ['failed', texts.failed],
    ['tooLarge', texts.tooLarge],
    ['save', common.actions?.save],
    ['cancel', common.actions?.cancel],
    ['note', notes.newMenu?.note],
    ['bookmark', notes.newMenu?.bookmark],
    ['clipPage', notes.newMenu?.clipPage],
    ['task', notes.newMenu?.task],
    ['journal', notes.newMenu?.journal],
    ['files', shell.tagsRail?.files],
    ['folder', shell.folders?.chipUnfiled],
    ['unfiled', shell.folders?.unfiled],
    ['tags', shell.tagsRail?.tags],
    ['taskList', editor.toolbar?.taskList],
    ['quickTasks', texts.quickTasks],
    ['titlePlaceholder', texts.titlePlaceholder],
    ['notePlaceholder', texts.notePlaceholder],
    ['taskPlaceholder', texts.taskPlaceholder],
    ['journalHint', texts.journalHint],
    ['addTagPlaceholder', extension.organize?.addTag],
    ['photoCount', texts.photoCount],
    ['fileCount', shell.noteRow?.files_other],
  ].filter(([, value]) => typeof value === 'string' && value.length > 0);
  const quote = (s) => JSON.stringify(s);
  const strings = entries.map(([k, v]) => `"${k}" = ${quote(v)};\n`).join('');
  const dir = resolve(root, 'packages/desktop/src-tauri/ios-share', `${lang === 'zh-TW' ? 'zh-Hant' : lang}.lproj`);
  const stringsPath = resolve(dir, 'Localizable.strings');
  if (existsSync(stringsPath) && readFileSync(stringsPath, 'utf8') === strings) continue;
  mkdirSync(dir, { recursive: true });
  writeFileSync(stringsPath, strings);
  updated.push(`ios-share/${lang} strings`);
}

console.log(
  `sync-version: ${version}` +
    (updated.length ? ` -> updated ${updated.join(', ')}` : ' (already in sync)'),
);
