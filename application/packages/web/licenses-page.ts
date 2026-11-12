import type { Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { THEME_SCRIPT_TAG, THEME_TOGGLE_CSS, themeVarsCss, WASHI_DARK, WASHI_LIGHT } from './static-page-theme.ts';
import { brandMark, CHROME_CSS, GITHUB_ICON, OG_IMAGE_TAGS, ogLocaleTag, SITE_FOOTER, siteNav } from './static-page-chrome.ts';

// Pre-renders a static /licenses page: the third-party software the app
// includes, with each license. Emitted as licenses/index.html, linked from
// the footer's Legal column and the public README.
//
// The list is the build's own: every package with a module in a chunk of
// this bundle, so a dependency bump updates the page with no one doing
// anything, and a package that tree-shaking or a stub removed is not listed.
// The fonts are every font asset in the bundle, read from their own name tables. The Rust crates of
// the desktop and mobile apps come from Cargo.lock, because the site build
// (Cloudflare) has no cargo.
//
// Web build only, like the other static pages: the app downloads do not
// carry this page (docs/contrib/bundle-size.md section 1). The same shell as
// /changelog and /help (.pcols grid, .rail-col sidebar); zero inline scripts.
// Spec: docs/internal/plans/third-party-notices.md

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://privacynotes.app';
const REPO_URL = 'https://github.com/LifetimeLabsHQ/PrivacyNotes.app';
const CARGO_LOCK = path.resolve(__dirname, '../desktop/src-tauri/Cargo.lock');
/** The license of the word lists the browser extension's fill script takes from Chromium. */
const CHROMIUM_WORDS_LICENSE = path.resolve(__dirname, '../extension/src/fill/LICENSE-chromium.txt');
const EXCALIDRAW_FONTS = path.join(
  path.dirname(fs.realpathSync(path.resolve(__dirname, 'node_modules/@excalidraw/excalidraw/package.json'))),
  'dist/prod/fonts'
);
const OUR_PACKAGES = /^@notes\//;

// Packages that ship without a license file. The MIT or BSD-3-Clause text
// below, with the holder named in the upstream repository's LICENSE. Anything
// else without a file falls back to its package.json author.
const MISSING_TEXT_HOLDER: Array<[RegExp, string]> = [
  [/^@excalidraw\//, 'Copyright (c) 2020 Excalidraw'],
  [/^@radix-ui\//, 'Copyright (c) 2022 WorkOS'],
  [/^pmtiles$/, 'Copyright 2021 Protomaps LLC'],
  [/^@protomaps\/basemaps$/, 'Copyright 2019-2023 Protomaps LLC, Kelso Cartography'],
];

const BSD3_TEXT = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

type Pkg = { name: string; version: string; license: string; url: string; text: string };
type Font = { family: string; copyright: string; license: string; url: string };
type Crate = { name: string; version: string };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function repoUrl(pkg: Record<string, unknown>, name: string): string {
  const repo = pkg.repository;
  const raw = typeof repo === 'string' ? repo : (repo as { url?: string } | undefined)?.url;
  if (raw) {
    const url = raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, 'https://github.com/');
    if (url.startsWith('https://')) return url;
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;
  }
  return `https://www.npmjs.com/package/${name}`;
}

function authorName(pkg: Record<string, unknown>): string | null {
  const a = pkg.author;
  const raw = typeof a === 'string' ? a : (a as { name?: string } | undefined)?.name;
  return raw ? raw.replace(/\s*[<(].*$/, '').trim() || null : null;
}

// The package.json license as one SPDX id, so one license is one group: the
// old `license: {type}` and `licenses: [...]` forms too, and an OR list in one
// order ("MIT OR Apache-2.0" and "Apache-2.0 OR MIT" are the same choice).
// With no field at all, the license file's own title names it.
function licenseId(pkg: Record<string, unknown>, text: string): string {
  const field = pkg.license ?? (pkg.licenses as unknown[] | undefined)?.[0];
  const raw = typeof field === 'string' ? field : (field as { type?: string } | undefined)?.type;
  if (!raw) return /^(the )?MIT License/i.test(text) ? 'MIT' : /^Apache License/.test(text) ? 'Apache-2.0' : 'See the repository';
  const bare = raw.replace(/^\((.*)\)$/, '$1');
  return / OR /.test(bare) && !/[()]| AND /.test(bare) ? bare.split(' OR ').sort().join(' OR ') : bare;
}

/** One entry per package directory that a chunk of this bundle draws from. */
export function collectPackages(moduleIds: Iterable<string>): Pkg[] {
  const dirs = new Map<string, string>();
  for (const id of moduleIds) {
    const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(id.replace(/\\/g, '/'));
    if (m) dirs.set(m[1]!, m[1]!);
  }
  const pkgs = new Map<string, Pkg>();
  for (const dir of dirs.keys()) {
    const file = path.join(dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const name = String(pkg.name);
    if (OUR_PACKAGES.test(name)) continue;
    const version = String(pkg.version);
    const key = `${name}@${version}`;
    if (pkgs.has(key)) continue;
    const texts = fs
      .readdirSync(dir)
      .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f) && fs.statSync(path.join(dir, f)).isFile())
      .sort()
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim());
    let text = texts.join('\n\n');
    const license = licenseId(pkg, text);
    if (!text && /^(MIT|BSD-3-Clause)$/.test(license)) {
      const holder = MISSING_TEXT_HOLDER.find(([re]) => re.test(name))?.[1] ?? (authorName(pkg) ? `Copyright (c) ${authorName(pkg)}` : null);
      if (holder) text = license === 'MIT' ? `MIT License\n\n${holder}\n\n${MIT_TEXT}` : `BSD 3-Clause License\n\n${holder}\n\n${BSD3_TEXT}`;
    }
    pkgs.set(key, { name, version, license, url: repoUrl(pkg, name), text });
  }
  return [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// The name table of a WOFF2 file: the table directory, then one Brotli stream
// holding every table in order. Only the name table is read, and it is never
// transformed, so no glyph decoding is needed.
// Spec: https://www.w3.org/TR/WOFF2/ (section 5, table directory)
const WOFF2_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

export function woff2Names(buf: Buffer): Record<number, string> {
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const c = buf[p++]!;
      v = v * 128 + (c & 127);
      if (!(c & 128)) return v;
    }
    throw new Error('woff2: bad UIntBase128');
  };
  const tables: Array<{ tag: string; len: number }> = [];
  for (let i = 0, n = buf.readUInt16BE(12); i < n; i++) {
    const flags = buf[p++]!;
    const tag = (flags & 63) === 63 ? buf.toString('latin1', (p += 4) - 4, p) : WOFF2_TAGS[flags & 63]!;
    const version = flags >> 6;
    let len = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    if (transformed) len = base128();
    tables.push({ tag, len });
  }
  const data = zlib.brotliDecompressSync(buf.subarray(p, p + buf.readUInt32BE(20)));
  let off = 0;
  for (const t of tables) {
    if (t.tag !== 'name') {
      off += t.len;
      continue;
    }
    const d = data.subarray(off, off + t.len);
    const strings = d.readUInt16BE(4);
    const out: Record<number, string> = {};
    for (let i = 0, n = d.readUInt16BE(2); i < n; i++) {
      const r = 6 + i * 12;
      const platform = d.readUInt16BE(r);
      const id = d.readUInt16BE(r + 6);
      if ((platform !== 0 && platform !== 3) || out[id] != null) continue;
      const s = d.subarray(strings + d.readUInt16BE(r + 10), strings + d.readUInt16BE(r + 10) + d.readUInt16BE(r + 8));
      let str = '';
      for (let j = 0; j + 1 < s.length; j += 2) str += String.fromCharCode(s.readUInt16BE(j));
      out[id] = str;
    }
    return out;
  }
  return {};
}

/** One entry per font family that ships, from the files' own metadata. */
export function collectFonts(woff2: Array<{ file: string; source: Buffer }>): Font[] {
  const families = new Map<string, Font>();
  for (const { source } of woff2) {
    const n = woff2Names(source);
    // The typographic family (16) groups the weights; the legacy family (1)
    // names each weight apart, as "Assistant SemiBold".
    const family = (n[16] ?? n[1] ?? 'Unknown').replace(/ Regular$/, '');
    if (families.has(family)) continue;
    families.set(family, {
      family,
      copyright: (n[0] ?? '').trim(),
      license: (n[13] ?? '').trim(),
      url: (n[14] ?? '').trim(),
    });
  }
  return [...families.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/** Excalidraw's font files, for the dev route, which has no bundle to read them from. */
export function excalidrawFontFiles(): Array<{ file: string; source: Buffer }> {
  return fs
    .readdirSync(EXCALIDRAW_FONTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      fs.readdirSync(path.join(EXCALIDRAW_FONTS, d.name)).map((f) => ({ file: f, source: fs.readFileSync(path.join(EXCALIDRAW_FONTS, d.name, f)) }))
    );
}

/** Every registry crate in Cargo.lock, all targets of the desktop and mobile apps. */
export function collectCrates(): Crate[] {
  if (!fs.existsSync(CARGO_LOCK)) return [];
  const crates: Crate[] = [];
  for (const block of fs.readFileSync(CARGO_LOCK, 'utf8').split('[[package]]').slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    if (name && version && /^source = "registry\+/m.test(block)) crates.push({ name, version });
  }
  return crates.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function slug(license: string): string {
  return 'l-' + license.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function groupByLicense(pkgs: Pkg[]): Array<{ license: string; pkgs: Pkg[] }> {
  const groups = new Map<string, Pkg[]>();
  for (const p of pkgs) groups.set(p.license, [...(groups.get(p.license) ?? []), p]);
  return [...groups.entries()]
    .map(([license, list]) => ({ license, pkgs: list }))
    .sort((a, b) => b.pkgs.length - a.pkgs.length || a.license.localeCompare(b.license));
}

function renderRail(groups: Array<{ license: string; pkgs: Pkg[] }>, fonts: Font[], crates: Crate[]): string {
  const rows = groups
    .map(
      (g) =>
        `<a class="ritem" href="#${slug(g.license)}"><span class="rlbl">${esc(g.license)}</span><span class="rct">${g.pkgs.length}</span></a>`
    )
    .join('\n');
  return `<div class="rail-col">
<nav class="rail" aria-label="Packages by license">
<p class="eyebrow">// Packages</p>
${rows}
</nav>
<nav class="rail rail-more" aria-label="Fonts and apps">
<p class="eyebrow rail-sep">// More</p>
<a class="ritem" href="#fonts"><span class="rlbl">Fonts</span><span class="rct">${fonts.length}</span></a>
${crates.length ? `<a class="ritem" href="#crates"><span class="rlbl">Rust crates</span><span class="rct">${crates.length}</span></a>` : ''}
<a class="ritem" href="#map-data"><span class="rlbl">Map data</span><span class="rct">${MAP_DATA.length}</span></a>
<a class="ritem" href="#extension"><span class="rlbl">Browser extension</span><span class="rct">1</span></a>
</nav>
<div class="rail rail-extra">
<a class="ritem" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">${GITHUB_ICON}<span class="rlbl">Source code</span></a>
</div>
</div>`;
}

function renderPackages(groups: Array<{ license: string; pkgs: Pkg[] }>): string {
  return groups
    .map(
      (g) => `<section class="lic" id="${slug(g.license)}">
<h2 class="eyebrow">// ${esc(g.license)}</h2>
${g.pkgs
  .map((p) => {
    const head = `<span class="lp-name">${esc(p.name)}</span><span class="lp-ver">${esc(p.version)}</span>`;
    const link = `<a class="lp-link" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url.replace(/^https:\/\//, ''))}</a>`;
    return p.text
      ? `<details class="lp"><summary>${head}</summary>${link}<pre>${esc(p.text)}</pre></details>`
      : `<div class="lp lp-bare">${head}${link}</div>`;
  })
  .join('\n')}
</section>`
    )
    .join('\n');
}

function renderFonts(fonts: Font[]): string {
  return `<section class="lic" id="fonts">
<h2 class="eyebrow">// Fonts</h2>
${fonts
  .map(
    (f) => `<details class="lp"><summary><span class="lp-name">${esc(f.family)}</span></summary>${
      f.url ? `<a class="lp-link" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.url.replace(/^https?:\/\//, ''))}</a>` : ''
    }<pre>${esc([f.copyright, f.license].filter(Boolean).join('\n\n'))}</pre></details>`
  )
  .join('\n')}
</section>`;
}

/**
 * The data behind a note's place and its maps. Not in the bundle, so nothing
 * reads it from the build: the map host serves it (note-location.md). The map
 * itself credits OpenStreetMap under every map; the town search credits
 * GeoNames here only, which its CC BY licence allows ("any reasonable manner").
 */
const MAP_DATA: Array<{ name: string; url: string; text: string }> = [
  {
    name: 'OpenStreetMap',
    url: 'https://www.openstreetmap.org/copyright',
    text: 'Map data © OpenStreetMap contributors, available under the Open Database License (ODbL). Drawn from a Protomaps build of OpenStreetMap, served from our own host.',
  },
  {
    name: 'Wikidata',
    url: 'https://www.wikidata.org/',
    text: 'The place search uses well-known places from Wikidata (mountains, lakes, islands, parks, buildings, regions), dedicated to the public domain (CC0).',
  },
  {
    name: 'GeoNames',
    url: 'https://www.geonames.org/',
    text: 'The place search uses the GeoNames list of towns of 5,000 people or more, licensed under Creative Commons Attribution 4.0 (CC BY 4.0).',
  },
];

function renderMapData(): string {
  return `<section class="lic" id="map-data">
<h2 class="eyebrow">// Map data</h2>
${MAP_DATA.map(
  (d) => `<details class="lp"><summary><span class="lp-name">${esc(d.name)}</span></summary><a class="lp-link" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.url.replace(/^https?:\/\//, ''))}</a><pre>${esc(d.text)}</pre></details>`
).join('\n')}
</section>`;
}

/**
 * The browser extension ships its own bundle, so nothing of it is found in
 * this build's chunks. What it takes from others by hand is listed here: the
 * word lists of its fill script (packages/extension/src/fill/wordsChromium.ts).
 */
function renderExtension(): string {
  const url = 'https://chromium.googlesource.com/chromium/src/+/main/components/autofill/content/renderer/html_based_username_detector_vocabulary.h';
  const text = fs.readFileSync(CHROMIUM_WORDS_LICENSE, 'utf8').trim();
  return `<section class="lic" id="extension">
<h2 class="eyebrow">// Browser extension</h2>
<details class="lp"><summary><span class="lp-name">Chromium word lists</span><span class="lp-ver">BSD-3-Clause</span></summary><a class="lp-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url.replace(/^https:\/\//, ''))}</a><pre>${esc(`The words for "password", "username" and "user" in many languages, which the extension uses to find the fields of a login form.\n\n${text}`)}</pre></details>
</section>`;
}

function renderCrates(crates: Crate[]): string {
  if (!crates.length) return '';
  return `<section class="lic" id="crates">
<h2 class="eyebrow">// Rust crates</h2>
<p class="lic-note">The desktop and mobile apps are built with these Rust crates, for every platform together. Each one links to its page on crates.io, which shows its license.</p>
<ul class="crates">
${crates.map((c) => `<li><a href="https://crates.io/crates/${esc(c.name)}/${esc(c.version)}" target="_blank" rel="noopener noreferrer">${esc(c.name)}</a> <span class="lp-ver">${esc(c.version)}</span></li>`).join('\n')}
</ul>
</section>`;
}

const PAGE_CSS = `.rail-more,.rail-extra{margin-top:24px;padding-top:18px;border-top:1px solid var(--line)}
.lic{margin:0 0 30px;scroll-margin-top:16px}
.lic:first-child{margin-top:22px}
.lic .eyebrow{margin:0 0 8px}
.lic-note{margin:0 0 12px;font-size:var(--fs-row);line-height:1.6;color:var(--muted)}
.lp{border-top:1px solid var(--line)}
.lp summary,.lp-bare{display:flex;align-items:baseline;gap:10px;padding:9px 4px;cursor:pointer;font-size:var(--fs-row)}
.lp-bare{cursor:default;flex-wrap:wrap}
.lp summary:hover .lp-name{color:var(--accent)}
.lp-name{font-weight:600;color:var(--fg);overflow-wrap:anywhere}
.lp-ver{font-size:var(--fs-compact);color:var(--faint);font-variant-numeric:tabular-nums}
.lp-link{display:inline-block;margin:0 4px 8px;font-size:var(--fs-compact);color:var(--muted);overflow-wrap:anywhere}
.lp-bare .lp-link{margin:0}
.lp-link:hover{color:var(--accent)}
.lp pre{margin:0 0 14px;padding:14px 16px;max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--card);font-size:var(--fs-compact);line-height:1.55;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.crates{margin:0;padding:0;list-style:none;columns:3 220px;column-gap:24px;font-size:var(--fs-compact)}
.crates li{padding:3px 0;break-inside:avoid}
.crates a{color:var(--fg);text-decoration:none}
.crates a:hover{color:var(--accent);text-decoration:underline}
@media(max-width:860px){.rail-more,.rail-extra{margin-top:14px;padding-top:0;border-top:0}}`;

function renderHtml(pkgs: Pkg[], fonts: Font[], crates: Crate[]): string {
  const groups = groupByLicense(pkgs);
  const description = 'The open source software PrivacyNotes includes, with the license of each package, font and crate.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Third-party licenses - PrivacyNotes</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${ORIGIN}/licenses">
<meta property="og:title" content="Third-party licenses - PrivacyNotes">
<meta property="og:description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:url" content="${ORIGIN}/licenses">
<meta property="og:site_name" content="PrivacyNotes">
${ogLocaleTag()}
${OG_IMAGE_TAGS}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${THEME_SCRIPT_TAG}
<script src="/static-pages.js" defer></script>
<style>
${themeVarsCss(`${WASHI_LIGHT};--accent:#1E40AF;--on-accent:#fff;--mark-fg:#1E40AF`, `${WASHI_DARK};--accent:#4A90D9;--on-accent:#03203E;--mark-fg:#7FB0E4`)}
${THEME_TOGGLE_CSS}
${CHROME_CSS}
${PAGE_CSS}
</style>
</head>
<body data-static-page="licenses">
<div class="wrap">
${siteNav({})}
<div class="pcols">
${renderRail(groups, fonts, crates)}
<div class="col-head">
<h1>Third-party licenses</h1>
<p class="sub">${brandMark()} is open source and built on other open source software. These are the packages, fonts, map data and crates it includes, each with its license. Select a package to read its license.</p>
</div>
<div class="col-body">
${renderPackages(groups)}
${renderFonts(fonts)}
${renderMapData()}
${renderExtension()}
${renderCrates(crates)}
</div>
</div>
</div>
${SITE_FOOTER}
</body>
</html>`;
}

export function licensesPagePlugin(): Plugin {
  return {
    name: 'emit-licenses-page',
    generateBundle(_options, bundle) {
      const moduleIds: string[] = [];
      const woff2: Array<{ file: string; source: Buffer }> = [];
      for (const out of Object.values(bundle)) {
        if (out.type === 'chunk') moduleIds.push(...Object.keys(out.modules));
        else if (/\.(woff2?|ttf|otf)$/.test(out.fileName)) {
          if (out.fileName.endsWith('.woff2') && typeof out.source !== 'string') woff2.push({ file: out.fileName, source: Buffer.from(out.source) });
          else this.warn(`licenses page: ${out.fileName} is not a WOFF2 font, so its license cannot be read; add a reader in licenses-page.ts`);
        }
      }
      const pkgs = collectPackages(moduleIds);
      for (const p of pkgs) if (!p.text) this.warn(`licenses page: ${p.name}@${p.version} ships no license text; the page links its repository only`);
      this.emitFile({
        type: 'asset',
        fileName: 'licenses/index.html',
        // Every font in the bundle, the Excalidraw files included: their
        // plugin emits them earlier in vite.config.ts's list.
        source: renderHtml(pkgs, collectFonts(woff2), collectCrates()),
      });
    },
    configureServer(server) {
      // The dev server has no bundle to read, so /licenses there lists the
      // whole production dependency tree instead: a superset of the built
      // page (Mermaid and other stubbed or tree-shaken packages show up).
      server.middlewares.use('/licenses', (req, res, next) => {
        if ((req.url ?? '/').split('?')[0] !== '/') return next();
        try {
          const ids = devPackageDirs().map((d) => `${d}/package.json`);
          const katexFonts = path.join(path.dirname(fs.realpathSync(path.resolve(__dirname, 'node_modules/katex/package.json'))), 'dist/fonts');
          const woff2 = fs
            .readdirSync(katexFonts)
            .filter((f) => f.endsWith('.woff2'))
            .map((f) => ({ file: f, source: fs.readFileSync(path.join(katexFonts, f)) }));
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(renderHtml(collectPackages(ids), collectFonts([...woff2, ...excalidrawFontFiles()]), collectCrates()));
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

/** Every package the web app and its workspace packages depend on in production, walked through pnpm's layout. */
export function devPackageDirs(): string[] {
  const seen = new Set<string>();
  const queue = [__dirname, path.resolve(__dirname, '../shared'), path.resolve(__dirname, '../clipper')];
  const find = (from: string, dep: string): string | null => {
    // A package's own node_modules first, then the folder it sits in, which
    // in pnpm's store holds its dependencies as siblings.
    const root = from.includes('/node_modules/') ? from.slice(0, from.lastIndexOf('/node_modules/') + '/node_modules'.length) : null;
    for (const dir of [path.join(from, 'node_modules', dep), root && path.join(root, dep)]) {
      if (dir && fs.existsSync(path.join(dir, 'package.json'))) return fs.realpathSync(dir);
    }
    return null;
  };
  while (queue.length) {
    const dir = queue.shift()!;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    // Optional dependencies are left out: in this tree they are native Node
    // binaries (pdf.js's canvas) that never reach a browser.
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const found = find(dir, dep);
      if (found && !seen.has(found)) {
        seen.add(found);
        queue.push(found);
      }
    }
  }
  return [...seen].filter((d) => d.includes('/node_modules/'));
}
