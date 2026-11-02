#!/usr/bin/env node
// The Firefox add-on store asks for the source of a bundled extension and
// rebuilds it. This proves that rebuild gives the same bytes: it zips the
// sources the way a submission would, unpacks the zip into an empty folder,
// installs and builds there with the commands of SOURCE.md, and compares every
// file of the two builds. Any difference, a missing file or a failed step
// fails the check.
// Spec: docs/internal/plans/browser-extension-build.md (section 5, CI)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const OUTPUT = join(PKG, '.output');

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

run('pnpm', ['run', 'zip:firefox'], PKG);
const sourcesZip = readdirSync(OUTPUT).find((f) => f.endsWith('-sources.zip'));
if (!sourcesZip) throw new Error('no sources zip in .output');

const work = mkdtempSync(join(tmpdir(), 'pn-extension-sources-'));
try {
  run('unzip', ['-q', join(OUTPUT, sourcesZip), '-d', work], PKG);
  run('pnpm', ['install', '--frozen-lockfile'], work);
  run('pnpm', ['--filter', '@notes/shared', '--fail-if-no-match', 'build'], work);
  run('pnpm', ['--filter', 'extension', '--fail-if-no-match', 'build:firefox'], work);

  const original = join(OUTPUT, 'firefox-mv3');
  const rebuilt = join(work, 'packages/extension/.output/firefox-mv3');
  const names = (dir) => filesUnder(dir).map((f) => relative(dir, f)).sort();
  const a = names(original);
  const b = names(rebuilt);
  const problems = [];
  for (const f of new Set([...a, ...b])) {
    if (!a.includes(f)) problems.push(`only in the rebuild: ${f}`);
    else if (!b.includes(f)) problems.push(`missing from the rebuild: ${f}`);
    else if (!readFileSync(join(original, f)).equals(readFileSync(join(rebuilt, f)))) problems.push(`differs: ${f}`);
  }
  if (problems.length) {
    console.error(`source zip check: the rebuild differs\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`source zip check: ${a.length} files rebuilt byte for byte`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
