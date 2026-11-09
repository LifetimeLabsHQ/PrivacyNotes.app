// Builds `pn` into one file, dist/pn.mjs, that runs on Node.js 20 or newer
// with no install step: the shared inbox crypto is bundled in, Node's own
// modules stay imports. The version is the app's (packages/web/src/version.ts).
// Spec: docs/internal/plans/agent-cli.md (section 3.5, C5)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const version = /VERSION = '([^']+)'/.exec(readFileSync(resolve(import.meta.dirname, '../web/src/version.ts'), 'utf8'))?.[1];
if (!version) throw new Error('pn build: no VERSION in packages/web/src/version.ts');

export default defineConfig({
  define: { __PN_VERSION__: JSON.stringify(version) },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: true,
    target: 'node20',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    rollupOptions: { input: 'src/pn.ts', output: { entryFileNames: 'pn.mjs', banner: '#!/usr/bin/env node' } },
  },
});
