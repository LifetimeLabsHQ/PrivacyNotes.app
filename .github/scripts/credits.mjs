#!/usr/bin/env node
// The credits wall: who reported the bugs and asked for the features that
// shipped. Reads the public issues with `gh`, writes CREDITS.md whole, and
// rewrites the short section between the credits markers in README.md.
// The credits workflow (.github/workflows/credits.yml) runs it every day.
//
//   node credits.mjs --readme README.md --credits CREDITS.md
//
// Options:
//   --readme <path>    the README that holds the credits markers
//   --credits <path>   the full credits file, written whole
//   --config <path>    a JSON file: { "exclude": [logins], "refuse": "regex" }
//   --json <path>      read the issues from a file instead of gh
//
// The accounts to leave out come from the CREDITS_EXCLUDE environment
// variable (logins separated by commas or spaces) and from --config. With
// neither, the script refuses: an empty list would credit accounts that asked
// to be left out.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO_SLUG = 'LifetimeLabsHQ/PrivacyNotes.app';

// Lowest shipped count for each tier, highest first.
export const TIERS = [50, 25, 10, 5, 3];
// The README shows the avatars of everyone at or above this count. Keep it equal
// to a tier, so the cut matches the wall.
const README_MIN = 3;
const RECENT_DAYS = 30;
// Everyone with at least this many issues in that window, so equal counts get equal places.
const RECENT_MIN = 3;

const START = '<!-- credits:start -->';
const END = '<!-- credits:end -->';

const hasLabel = (issue, name) => issue.labels.some((l) => l.name === name);
const titleIs = (issue, kind) => new RegExp(`^\\s*\\[?${kind}\\]?\\s*:`, 'i').test(issue.title);

/** The logins in a CREDITS_EXCLUDE value: commas or whitespace between them. */
export function parseExclude(value) {
  return (value ?? '').split(/[\s,]+/).filter(Boolean);
}

/** One row per person: counts from that person's issues. */
export function tally(issues, exclude, now = new Date()) {
  const since = new Date(now.getTime() - RECENT_DAYS * 86400000).toISOString();
  const people = new Map();
  for (const issue of issues) {
    const login = issue.author?.login;
    if (!login || issue.author.is_bot || login.startsWith('app/') || exclude.has(login)) continue;
    const p = people.get(login) ?? { login, issues: 0, shipped: 0, bugs: 0, ideas: 0, recent: 0 };
    p.issues += 1;
    if (issue.createdAt >= since) p.recent += 1;
    const bug = hasLabel(issue, 'bug') || titleIs(issue, 'bug');
    const idea = !bug && (hasLabel(issue, 'feature') || titleIs(issue, 'feature'));
    const done = issue.stateReason === 'COMPLETED' && !hasLabel(issue, 'duplicate') && !hasLabel(issue, 'wontfix');
    if (done && (bug || idea)) {
      p.shipped += 1;
      if (bug) p.bugs += 1;
      else p.ideas += 1;
    }
    people.set(login, p);
  }
  return [...people.values()].sort(
    (a, b) => b.shipped - a.shipped || b.issues - a.issues || a.login.localeCompare(b.login),
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const link = (login) => `https://github.com/${login}`;

// The README's avatars wrap in one centered paragraph, not a table: GitHub sizes a
// table to its content, so a fixed column count leaves space on wide screens and
// scrolls on narrow ones. The name and count show on hover; CREDITS.md has the grid.
function avatars(people) {
  const cell = (p) => `<a href="${link(p.login)}" title="${p.login}, ${p.shipped} shipped"><img src="${link(p.login)}.png?size=112" width="56" height="56" alt="${p.login}"></a>`;
  return `<p align="center">\n${people.map(cell).join('\n')}\n</p>`;
}

function grid(people, { size, perRow, detail }) {
  const cell = (p) => {
    const lines = [
      `<a href="${link(p.login)}"><img src="${link(p.login)}.png?size=${size * 2}" width="${size}" height="${size}" alt=""><br><sub><b>${p.login}</b></sub></a>`,
      `<sub>${p.shipped} shipped</sub>`,
    ];
    if (detail) lines.push(`<sub>${plural(p.bugs, 'bug', 'bugs')} · ${plural(p.ideas, 'idea', 'ideas')}</sub>`);
    return `<td align="center" valign="top">${lines.join('<br>')}</td>`;
  };
  // perRow is the most a row can hold. Use the fewest rows, then spread people
  // evenly over them, so no row ends with one person alone (7 is 7, not 6 and 1).
  const rowCount = Math.ceil(people.length / perRow);
  const perRowEven = Math.ceil(people.length / rowCount);
  const rows = [];
  for (let i = 0; i < people.length; i += perRowEven) {
    rows.push(`<tr>${people.slice(i, i + perRowEven).map(cell).join('')}</tr>`);
  }
  return `<table>\n${rows.join('\n')}\n</table>`;
}

/**
 * Both outputs as strings, so the test can read them without gh or a disk.
 * `refuse`, when given, is a pattern no login may match: the run stops instead.
 */
export function render(people, { refuse } = {}) {
  const bad = refuse && people.find((p) => refuse.test(p.login));
  if (bad) {
    throw new Error(`Login "${bad.login}" matches the refuse pattern in the config. Decide how to credit this person, then run again.`);
  }
  const shippedTotal = people.reduce((n, p) => n + p.shipped, 0);
  const inTier = (i) => people.filter((p) => p.shipped >= TIERS[i] && (i === 0 || p.shipped < TIERS[i - 1]));
  const rest = people.filter((p) => p.shipped < TIERS.at(-1));
  const recent = people.filter((p) => p.recent >= RECENT_MIN)
    .sort((a, b) => b.recent - a.recent || a.login.localeCompare(b.login));

  const credits = [
    '<!-- Generated every day from the public issues by .github/workflows/credits.yml. Do not edit by hand. -->',
    '',
    '# Credits',
    '',
    `PrivacyNotes is shaped by the people who report bugs and ask for features in [our issues](https://github.com/${REPO_SLUG}/issues). ${plural(people.length, 'person has', 'people have')} opened an issue so far, and ${plural(shippedTotal, 'report is', 'reports are')} now fixed or built. Thank you.`,
    '',
    '"Shipped" counts the bug reports and feature requests of a person that we closed as done. The list updates every day. To leave the list, say so in any issue.',
    '',
    ...TIERS.flatMap((min, i) => {
      const tier = inTier(i);
      if (!tier.length) return [];
      const shape = [
        { size: 96, perRow: 7, detail: true },
        { size: 80, perRow: 7, detail: true },
        { size: 56, perRow: 7, detail: true },
        { size: 48, perRow: 8, detail: false },
        { size: 40, perRow: 8, detail: false },
      ][i];
      return [`## ${min} or more shipped`, '', grid(tier, shape), ''];
    }),
    ...(recent.length
      ? ['## Most active in the last 30 days', '', recent.map((p) => `[${p.login}](${link(p.login)}) (${plural(p.recent, 'issue', 'issues')})`).join(' · '), '']
      : []),
    ...(rest.length
      ? ['## Every report counts', '', rest.map((p) => `[${p.login}](${link(p.login)})`).join(' · '), '']
      : []),
  ].join('\n');

  const top = people.filter((p) => p.shipped >= README_MIN);
  const readme = [
    START,
    '## Credits',
    '',
    `PrivacyNotes is shaped by the people who report bugs and ask for features in our issues. ${plural(people.length, 'person has', 'people have')} opened an issue, and ${plural(shippedTotal, 'report is', 'reports are')} now fixed or built.`,
    '',
    ...(top.length ? [avatars(top), ''] : []),
    'Everyone, with their counts, is in [CREDITS.md](CREDITS.md).',
    END,
  ].join('\n');

  return { credits, readme };
}

/** The README with its credits section replaced; throws when the markers are missing. */
export function spliceReadme(text, section) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error(`The README has no ${START} ... ${END} section.`);
  return text.slice(0, a) + section + text.slice(b + END.length);
}

function main() {
  const args = process.argv.slice(2);
  const arg = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
  const readmePath = arg('--readme', 'docs/public/README.md');
  const creditsPath = arg('--credits', 'docs/public/CREDITS.md');
  const configPath = arg('--config', null);
  const jsonFile = arg('--json', null);

  const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const exclude = new Set([...parseExclude(process.env.CREDITS_EXCLUDE), ...(config.exclude ?? [])]);
  if (!exclude.size) {
    throw new Error('No accounts to leave out: set CREDITS_EXCLUDE or pass --config. Nothing was written.');
  }
  const refuse = config.refuse ? new RegExp(config.refuse, 'i') : undefined;

  const raw = jsonFile
    ? readFileSync(jsonFile, 'utf8')
    : execFileSync('gh', ['issue', 'list', '-R', REPO_SLUG, '--state', 'all', '--limit', '10000',
      '--json', 'number,author,labels,stateReason,createdAt,title'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const people = tally(JSON.parse(raw), exclude);
  const { credits, readme } = render(people, { refuse });
  writeFileSync(creditsPath, credits);
  writeFileSync(readmePath, spliceReadme(readFileSync(readmePath, 'utf8'), readme));
  console.log(`Credits: ${people.length} people, ${people.reduce((n, p) => n + p.shipped, 0)} shipped. Wrote ${creditsPath} and the section in ${readmePath}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`Credits not updated: ${err.message}`);
    process.exit(1);
  }
}
