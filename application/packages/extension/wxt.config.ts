import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { defineConfig, type WxtViteConfig } from 'wxt';
import react from '@vitejs/plugin-react';
import { BORROWED_KEYS } from './catalog-keys';

// One version for every port, the extension included.
// Spec: docs/internal/agent-rules.md (rule A)
const VERSION = /VERSION = '([0-9.]+)'/.exec(
  readFileSync(resolve(__dirname, '../web/src/version.ts'), 'utf8'),
)?.[1];
if (!VERSION) throw new Error('packages/web/src/version.ts: no VERSION found');

const REPO = resolve(__dirname, '../..');
const WEB_SRC = resolve(__dirname, '../web/src');

// The files of packages/web/src the extension build reads. Every build writes
// the modules it imported into web-sources.json (committed), and the Firefox
// source zip carries that list, the files read outside the module graph (the
// version, the locale list, the catalogs, the CSS and the UI folder Tailwind
// scans), and nothing else of the app. scripts/check-source-zip.mjs rebuilds
// from the zip, so a missing file fails there by name.
const LISTED = resolve(__dirname, 'web-sources.json');
const WEB_SOURCES = [
  'packages/web/src/version.ts',
  'packages/web/src/i18n.ts',
  'packages/web/src/index.css',
  'packages/web/src/typeScale.css',
  'packages/web/src/ui/**',
  ...['extension', 'notes', 'common', 'shell', 'auth', 'security', 'settingsSearch', 'editor'].map((ns) => `packages/web/src/locales/*/${ns}.json`),
  ...(existsSync(LISTED) ? (JSON.parse(readFileSync(LISTED, 'utf8')) as string[]) : []),
];

const imported = new Set<string>();
function recordWebSources(): NonNullable<WxtViteConfig['plugins']>[number] {
  return {
    name: 'pn-web-sources',
    apply: 'build',
    buildEnd() {
      for (const id of this.getModuleIds()) {
        const file = id.split('?')[0]!;
        if (file.startsWith(`${WEB_SRC}/`) && !file.endsWith('.css') && !file.endsWith('.json')) imported.add(relative(REPO, file));
      }
    },
  };
}

const LOCALES = /export const SUPPORTED_LOCALES = \[([\s\S]*?)\]/.exec(
  readFileSync(resolve(__dirname, '../web/src/i18n.ts'), 'utf8'),
)?.[1]?.match(/'[A-Za-z-]+'/g)?.map((l) => l.slice(1, -1)) ?? ['en'];

/** Every locale's extension catalog, and the app keys of catalog-keys.mjs,
 *  as one small module: `virtual:pn-catalogs`. */
function catalogs(): NonNullable<WxtViteConfig['plugins']>[number] {
  const id = 'virtual:pn-catalogs';
  const read = (locale: string, ns: string) => {
    const file = resolve(__dirname, `../web/src/locales/${locale}/${ns}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null;
  };
  return {
    name: 'pn-catalogs',
    resolveId: (source: string) => (source === id ? `\0${id}` : null),
    load(loaded: string) {
      if (loaded !== `\0${id}`) return null;
      const out: Record<string, Record<string, Record<string, unknown>>> = {};
      for (const locale of LOCALES) {
        const own = read(locale, 'extension');
        if (!own) continue;
        const res: Record<string, Record<string, unknown>> = { extension: own };
        for (const path of BORROWED_KEYS) {
          const [ns, key] = path.split(':') as [string, string];
          const parts = key.split('.');
          let value: unknown = read(locale, ns);
          for (const p of parts) value = (value as Record<string, unknown> | null)?.[p];
          if (value === undefined) continue;
          let at = (res[ns] ??= {});
          for (const p of parts.slice(0, -1)) at = (at[p] ??= {}) as Record<string, unknown>;
          at[parts[parts.length - 1]!] = value;
        }
        out[locale] = res;
      }
      return `export default ${JSON.stringify(out)};`;
    },
  };
}

// Spec: docs/internal/plans/browser-extension-build.md (section 5, permissions)
export default defineConfig({
  entrypointsDir: 'entrypoints',
  publicDir: 'public',
  outDir: '.output',
  zip: {
    // The store version, not package.json's 0.0.1, so each upload names its version.
    artifactTemplate: `privacynotes-${VERSION}-{{browser}}.zip`,
    sourcesTemplate: `privacynotes-${VERSION}-sources.zip`,
    sourcesRoot: resolve(__dirname, '../..'),
    includeSources: [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.base.json',
      'packages/extension/**',
      'packages/shared/**',
      'packages/clipper/**',
      // The lockfile names every workspace package, and a frozen install
      // refuses one whose package.json is missing; their sources stay out.
      'packages/web/package.json',
      'packages/desktop/package.json',
      'packages/admin/package.json',
      ...WEB_SOURCES,
    ],
    // A build cache would make the rebuild skip a step (a tsbuildinfo tells
    // tsc that shared/dist exists when it does not).
    excludeSources: ['**/.wxt/**', '**/dist/**', '**/*.tsbuildinfo', 'packages/extension/public/_locales/**'],
  },
  vite: () => ({
    plugins: [react(), catalogs(), recordWebSources()],
    // The app's shortcut helper asks which native build it is in; the
    // extension is none (vite-env.d.ts declares the name for the app).
    define: { __PN_BUILD_PLATFORM__: '""' },
    resolve: {
      alias: { '@web': resolve(__dirname, '../web/src') },
      // The app's UI parts are imported from packages/web/src; their imports
      // of these packages must resolve to the extension's own copies, so the
      // bundle carries one React and the source zip needs no web install.
      dedupe: ['react', 'react-dom', 'react-i18next', 'i18next', '@phosphor-icons/react'],
    },
  }),
  hooks: {
    'build:done': () => {
      const list = `${JSON.stringify([...imported].sort(), null, 2)}\n`;
      if (!existsSync(LISTED) || readFileSync(LISTED, 'utf8') !== list) writeFileSync(LISTED, list);
    },
  },
  manifest: ({ browser }) => ({
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    version: VERSION,
    permissions: [
      'scripting',
      'storage',
      'contextMenus',
      'alarms',
      'idle',
      'clipboardRead',
      'clipboardWrite',
      // Chrome and Edge hold 10 MB in storage.local without unlimitedStorage, less
      // than one sealed clip with all its pictures. It shows no install warning.
      ...(browser === 'firefox' ? [] : ['offscreen', 'favicon', 'unlimitedStorage']),
    ],
    host_permissions: ['<all_urls>'],
    action: { default_title: '__MSG_extName__' },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+S' },
        description: '__MSG_commandOpen__',
      },
      'copy-login': {
        suggested_key: { default: 'Alt+Shift+L' },
        description: '__MSG_commandCopyLogin__',
      },
      'save-bookmark': {
        suggested_key: { default: 'Alt+Shift+B' },
        description: '__MSG_commandSaveBookmark__',
      },
    },
    // "pn" in the address bar searches the local copy; nothing leaves the browser.
    omnibox: { keyword: 'pn' },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'extension@privacynotes.app',
              strict_min_version: '140.0',
              data_collection_permissions: { required: ['websiteContent', 'authenticationInfo'] },
            },
          },
        }
      : {}),
  }),
});
