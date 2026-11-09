/**
 * The menu path vocabulary, shared by the gate (tools/check-help-paths.mjs)
 * and the help pages (help-page.ts, which draws each path as a breadcrumb).
 * It lives here, not under tools/, because the public mirror ships
 * packages/web and help-page.ts needs it to build. Both read the same code,
 * so a path is drawn exactly as far as the gate reads it.
 * Spec: docs/contrib/help-center.md (rule 12)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const HELP_FILES = new Set(['faq', 'guides']);
// `quickAdd` holds the words the quick add reads out of typed text, never a
// label on screen.
export const NOT_SCANNED = new Set(['helpQuestions', 'quickAdd']);

// Labels that only the settings search shows (settingsSearch/registry.ts),
// never a menu: the Security tabs render their short labels, and the long
// ones stay in the catalogs as search result names. A path naming one of
// these walks to a tab the reader cannot find. The list is written out
// because the registry's other keys are also reached through template keys
// (`accountTabs.${label}`) that a scan of the source cannot tell apart;
// tests/helpPaths.test.ts holds each entry to the registry and to no
// component.
export const SEARCH_ONLY_KEYS = new Set(['security:modal.tabPhrase']);

export const isArabic = (locale) => locale === 'ar' || locale.startsWith('ar-');
export const lower = (s, locale) => s.toLocaleLowerCase(locale);

/** The exemption model, read out of i18nExempt.ts so the two cannot drift. */
export function parseExemptions(src) {
  const listOf = (name) => {
    const m = src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  };
  const CJK = listOf('CJK');
  const LATIN = listOf('LATIN');
  const renderTranslated = new Map();
  const entryRe = /'([a-zA-Z]+:[A-Za-z0-9_.]+)':\s*(\[\]|CJK|allBut\(([^)]*)\)|\[[^\]]*\])/g;
  const table = src.slice(src.indexOf('const RENDER_TRANSLATED'), src.indexOf('function fits'));
  for (const m of table.matchAll(entryRe)) {
    const [, key, shape, tooWideList] = m;
    if (shape === '[]') renderTranslated.set(key, []);
    else if (shape === 'CJK') renderTranslated.set(key, CJK);
    else if (shape.startsWith('allBut')) {
      const tooWide = [...(tooWideList ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
      renderTranslated.set(key, [...LATIN.filter((l) => !tooWide.includes(l)), ...CJK]);
    } else renderTranslated.set(key, [...shape.matchAll(/'([^']+)'/g)].map((x) => x[1]));
  }
  return { renderTranslated };
}

/**
 * The settings categories whose label lives outside notes:settings, read out
 * of settingsCategories.tsx as [namespace, key] pairs ("Hotkeys" is
 * landing:about.tabs.hotkeys). A short key there belongs to notes:settings,
 * which pathVocab reads whole anyway.
 */
export function parseCategoryKeys(src) {
  return [...src.matchAll(/label: t\('([a-zA-Z]+):([A-Za-z0-9_.]+)'/g)].map((m) => [m[1], m[2]]);
}

/** The string a reader of `locale` actually sees for `qualifiedKey`. */
export function rendered(qualifiedKey, locale, own, english, ex) {
  if (locale === 'en' || english === undefined) return own;
  const fits = (allow) => isArabic(locale) || allow.some((l) => locale === l || locale.startsWith(`${l}-`));
  const allow = ex.renderTranslated.get(qualifiedKey);
  if (allow !== undefined) return fits(allow) ? own : english;
  return own;
}

export function* leaves(node, path = '') {
  if (typeof node === 'string') yield [path, node];
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) yield* leaves(v, path ? `${path}.${k}` : k);
  }
}

// An unquoted segment ends at the next delimiter, ASCII, CJK and Arabic
// punctuation alike, or at the bold marker that closes a **path**.
const DELIMS = new Set('>"“”„«»「」『』.,:;()（）、，。：；！？!?،؛؟*[]\n'.split(''));
export const QUOTES = { '"': '"', '“': '”', '”': '”', '„': '“”', '‘': '’', '«': '»', '「': '」', '『': '』' };

const EXACT_CLOSERS = new Set([')', '）', '」', '』', '”', ']']);

/**
 * Every "<anchor> > a > b" path in `text`, as its segments. A segment is
 * `exact` when something marks where the label ends: quotes around it, a
 * further " > ", a closing bracket, or the "**" that closes a path which
 * opened in bold. After a plain path, "**" opens the NEXT bold label
 * ("設定 > アカウントに**購入を復元**"), so there it is prose. Only an unquoted
 * last segment can run on into prose, so only that one is matched as a
 * prefix. `closer` is the character that ended an unquoted segment.
 * `at` is where the anchor starts; `start` and `end` bound each segment in
 * `text`, quotes included, so the help pages can draw the path in place.
 */
export function parsePaths(text, anchor) {
  const paths = [];
  const opener = `${anchor} > `;
  let from = 0;
  for (let at = text.indexOf(opener, from); at >= 0; at = text.indexOf(opener, from)) {
    let pos = at + anchor.length;
    const path = [];
    path.at = at;
    const boldPath = text.slice(Math.max(0, at - 2), at) === '**';
    const segments = path;
    while (text.startsWith(' > ', pos)) {
      pos += 3;
      let start = pos;
      if (text.startsWith('**', start)) start += 2;
      const close = QUOTES[text[start]];
      if (close) {
        let stop = start + 1;
        while (stop < text.length && !close.includes(text[stop])) stop++;
        if (stop >= text.length) break;
        const quoted = text.slice(start + 1, stop).trim();
        if (!quoted) break;
        segments.push({ text: quoted, exact: true, closer: text[stop], start, end: stop + 1 });
        pos = stop + 1;
        if (text.startsWith('**', pos)) pos += 2;
        continue;
      }
      let j = start;
      while (j < text.length && !DELIMS.has(text[j])) j++;
      const segment = text.slice(start, j).trim();
      if (!segment) break;
      const end = start + text.slice(start, j).trimEnd().length;
      const closer = text[j] ?? '';
      const exact = text.startsWith(' > ', end) || (closer === '*' ? boldPath : EXACT_CLOSERS.has(closer));
      segments.push({ text: segment, exact, closer, start, end });
      pos = end;
    }
    if (segments.length) paths.push(segments);
    from = Math.max(pos, at + 1);
  }
  return paths;
}

// A label must not end in the middle of a word in a spaced alphabet
// ("Account" is not a match for "Accounts"). Scripts that attach particles
// to the word before them (Japanese, Korean, Chinese, Thai, Arabic) skip this.
const WORD_TAIL = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]/u;

/** A vocabulary indexed by lowercased first character, longest entry first. */
export function buildVocab(labels, locale) {
  const byHead = new Map();
  for (const label of new Set(labels)) {
    const key = lower(label, locale);
    if (key.length < 2) continue;
    const head = key[0];
    if (!byHead.has(head)) byHead.set(head, []);
    byHead.get(head).push({ label, key });
  }
  for (const list of byHead.values()) list.sort((a, b) => b.key.length - a.key.length);
  return byHead;
}

/** The longest label that leads `segment`, and the text after it. */
export function matchLabel(segment, vocab, locale) {
  const seg = lower(segment, locale);
  for (const { label, key } of vocab.get(seg[0]) ?? []) {
    if (!seg.startsWith(key)) continue;
    const next = segment[key.length];
    if (next && WORD_TAIL.test(next) && WORD_TAIL.test(key[key.length - 1])) continue;
    return { label, rest: segment.slice(key.length) };
  }
  return null;
}

/**
 * The words a path in `locale` may use: `anchor` is the rendered Settings
 * label, `categories` the settings category labels and `ui` every label the
 * app renders, all as a reader of `locale` sees them. Null when the locale
 * has no Settings label. help-page.ts reads the same vocabulary to find
 * where a path ends, so the drawn path and this gate cannot disagree.
 */
export function pathVocab(locale, catalogs, english, ex) {
  const shown = (ns, key, own) => {
    const en = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), english[ns]);
    return rendered(`${ns}:${key}`, locale, own, typeof en === 'string' ? en : undefined, ex);
  };
  // The Settings label as the Settings window title renders it. Until
  // 2026-11-09 this read settings:shell.title, a key merged into this one on
  // 2026-10-24, and the gate passed while it checked nothing: main() now
  // fails when it scans no path at all.
  const own = catalogs.shell?.contextMenu?.settings;
  if (typeof own !== 'string') return null;
  const anchor = shown('shell', 'contextMenu.settings', own);

  // First level: the settings category labels, as rendered.
  const at = (json, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), json);
  const categoryLabels = Object.entries(catalogs.notes?.settings ?? {})
    .filter(([k, v]) => k.endsWith('Label') && typeof v === 'string')
    .map(([k, v]) => shown('notes', `settings.${k}`, v));
  for (const [ns, key] of ex.categoryKeys ?? []) {
    // A label still missing from this catalog renders in English.
    const own = at(catalogs[ns], key) ?? at(english[ns], key);
    if (typeof own === 'string') categoryLabels.push(shown(ns, key, own));
  }
  const categories = buildVocab(categoryLabels, locale);

  // Later levels: every string the app renders in this locale. Placeholders,
  // markup and a trailing ellipsis are trimmed off, because copy quotes a
  // label without them.
  const uiLabels = [];
  for (const [ns, json] of Object.entries(catalogs)) {
    if (HELP_FILES.has(ns) || NOT_SCANNED.has(ns)) continue;
    for (const [key, value] of leaves(json)) {
      if (SEARCH_ONLY_KEYS.has(`${ns}:${key}`)) continue;
      let v = shown(ns, key, value).replace(/<[^>]+>/g, '');
      if (v.includes('{{')) v = v.slice(0, v.indexOf('{{')).replace(/[\s:：]+$/, '');
      v = v.trim();
      uiLabels.push(v);
      const noEllipsis = v.replace(/(\.\.\.|…)$/, '').trim();
      if (noEllipsis !== v) uiLabels.push(noEllipsis);
    }
  }
  const ui = buildVocab(uiLabels, locale);
  return { anchor, categories, ui, shown };
}

export function readCatalogs(dir) {
  const out = {};
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.json')) out[file.slice(0, -5)] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  }
  return out;
}

/**
 * The vocabulary of one locale, read from the web package's own files
 * (`webSrc` is packages/web/src). Used by help-page.ts and changelog-page.ts
 * to draw paths, never by the gate, which reads the same files itself.
 * `past` lists labels the app no longer shows, for the changelog.
 */
export function loadPathVocab(webSrc, locale, past = { categories: [], ui: [] }) {
  const ex = parseExemptions(readFileSync(join(webSrc, 'i18nExempt.ts'), 'utf8'));
  ex.categoryKeys = parseCategoryKeys(readFileSync(join(webSrc, 'notesView/settingsCategories.tsx'), 'utf8'));
  const own = readCatalogs(join(webSrc, 'locales', locale));
  const en = locale === 'en' ? own : readCatalogs(join(webSrc, 'locales', 'en'));
  const v = pathVocab(locale, own, en, ex);
  // `past` adds labels the app no longer shows, for a page about the past.
  const plus = (vocab, extra) =>
    extra.length ? buildVocab([...[...vocab.values()].flat().map((e) => e.label), ...extra], locale) : vocab;
  if (v) {
    v.categories = plus(v.categories, past.categories);
    v.ui = plus(v.ui, past.ui);
  }
  return v;
}

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A menu path ("Settings > Account > "Delete account & data..."") drawn as
 * one breadcrumb: each label in the text colour and weight of a UI label,
 * a muted chevron between them, the quotes that mark where the path stops
 * dropped because the breadcrumb itself shows that. The source text stays
 * plain (help-center.md rule 12). UI pattern 170.
 */
function pathHtml(labels) {
  return `<span class="mp">${labels.map((l) => `<span class="mp-l">${escHtml(l)}</span>`).join('<span class="mp-s" aria-hidden="true"> › </span>')}</span>`;
}

/** The look of `pathHtml`, for every page that draws paths. */
export const MENU_PATH_CSS = `.mp{color:var(--fg);font-weight:600;background:var(--rail);border:1px solid var(--line);border-radius:6px;padding:.05em .45em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.mp-l{white-space:nowrap}
.mp-s{color:var(--faint);font-weight:400}`;

/**
 * Replaces each menu path in `s` with a sentinel `<n>` and pushes
 * its HTML to `drawn`, so the caller can escape the rest and put the paths
 * back last. A path is drawn exactly as far as `pnpm check:help-paths` reads
 * it; a segment the vocabulary `v` does not know ends the path there, and a
 * path whose first segment is unknown stays prose.
 */
export function markPaths(s, v, locale, drawn) {
  if (!v || !s.includes(`${v.anchor} > `)) return s;
  let out = '';
  let from = 0;
  for (const segments of parsePaths(s, v.anchor)) {
    const at = segments.at;
    if (at < from) continue;
    const labels = [v.anchor];
    let end = -1;
    for (const [i, seg] of segments.entries()) {
      const hit = matchLabel(seg.text, i === 0 ? v.categories : v.ui, locale);
      if (!hit) break;
      const quoted = s[seg.start] !== seg.text[0];
      if (quoted || seg.exact) {
        labels.push(seg.text);
        end = seg.end;
      } else {
        const len = seg.text.length - hit.rest.length;
        labels.push(seg.text.slice(0, len).trimEnd());
        end = seg.start + len;
      }
      if (!quoted && !seg.exact) break;
    }
    if (end < 0) continue;
    out += s.slice(from, at) + `${drawn.length}`;
    drawn.push(pathHtml(labels));
    from = end;
  }
  return out + s.slice(from);
}

/** Puts the paths `markPaths` took out back into escaped HTML. */
export const restorePaths = (html, drawn) => html.replace(/(\d+)/g, (_, i) => drawn[Number(i)]);
