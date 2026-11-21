import type { SettingEntry } from './settingsSearch/registry';
import type { TrackerSetupTab } from './TrackerConfig';
import type { View } from './views';
import { Archive, ArrowsClockwise, ChartBar, GridFour, Heartbeat, LockSimple, Megaphone, PaintBrush, Palette, Password, Pill, Plus, Question, Repeat, Shield, Shuffle, Trash, Globe, type Icon } from './icons';

/**
 * Ninja's doors to the features that sit deep in Settings or in a dialog:
 * the Features group of ">" (each row with a line that says what it does),
 * the commands with no key, and two Create rows of "+". One list of data;
 * NotesView gives each action its run and says when it is offered.
 *
 * A door into Settings names a settings search entry, never a section and a
 * tab of its own: the entry holds both, and `tests/settingsSearch.test.ts`
 * proves each entry has its row in a pane. `tests/ninjaFeatures.test.ts`
 * proves each entry named here exists, so a moved setting fails a test, not
 * Ninja.
 *
 * Spec: docs/internal/specs/ninja-features.md
 */

export type NinjaAction = 'passwordGenerator' | 'lock' | 'lockProtected' | 'syncNow' | 'syncPause' | 'emptyTrash' | 'randomItem';
type NinjaPage = '/' | '/changelog' | '/help' | '/themes';

export type NinjaDoor = {
  /** Stable: the recent list keeps it. */
  id: string;
  group: 'features' | 'commands' | 'new';
  /** Catalog keys, with their namespace. */
  label: string;
  detail?: string;
  icon: Icon;
  pro?: true;
  /** Also a Create row of "+". */
  inCreate?: true;
  to:
    | { kind: 'settings'; entry: SettingEntry['id'] }
    // Settings > Trackers at a tab, in the full window (`openTrackerSettings`).
    | { kind: 'tracker'; tab: TrackerSetupTab; entry: SettingEntry['id'] }
    | { kind: 'page'; path: NinjaPage }
    | { kind: 'action'; id: NinjaAction };
};

export const NINJA_DOORS: readonly NinjaDoor[] = [
  { id: 'feature:stats', group: 'features', label: 'notes:settings.statsLabel', detail: 'common:ninja.features.stats.detail', icon: ChartBar, to: { kind: 'settings', entry: 'section.stats' } },
  { id: 'feature:trackers', group: 'features', label: 'notes:settings.trackersLabel', detail: 'common:ninja.features.trackers.detail', icon: Heartbeat, to: { kind: 'tracker', tab: 'trackers', entry: 'trackers.setup' } },
  { id: 'feature:medication', group: 'features', label: 'common:ninja.features.medication.label', detail: 'common:ninja.features.medication.detail', icon: Pill, to: { kind: 'tracker', tab: 'medications', entry: 'trackers.medications' } },
  { id: 'feature:yearInPixels', group: 'features', label: 'common:ninja.features.yearInPixels.label', detail: 'common:ninja.features.yearInPixels.detail', icon: GridFour, to: { kind: 'settings', entry: 'stats.yearInPixels' } },
  { id: 'feature:importExport', group: 'features', label: 'notes:settings.importLabel', detail: 'common:ninja.features.importExport.detail', icon: Repeat, to: { kind: 'settings', entry: 'section.import' } },
  { id: 'feature:backup', group: 'features', label: 'notes:settings.backupLabel', detail: 'common:ninja.features.backup.detail', icon: Archive, to: { kind: 'settings', entry: 'section.backup' } },
  { id: 'feature:generator', group: 'features', label: 'common:ninja.features.generator.label', detail: 'common:ninja.features.generator.detail', icon: Password, to: { kind: 'action', id: 'passwordGenerator' } },
  { id: 'feature:themes', group: 'features', label: 'common:palette.groups.themes', detail: 'common:ninja.features.themes.detail', icon: Palette, to: { kind: 'settings', entry: 'appearance.theme' } },

  { id: 'new:medication', group: 'new', label: 'common:ninja.new.medication', icon: Pill, inCreate: true, to: { kind: 'tracker', tab: 'medications', entry: 'trackers.medications' } },
  { id: 'new:customTracker', group: 'new', label: 'common:ninja.new.customTracker', icon: Plus, pro: true, inCreate: true, to: { kind: 'tracker', tab: 'custom', entry: 'trackers.custom' } },

  { id: 'cmd:lock', group: 'commands', label: 'notes:footer.lockApp', icon: LockSimple, to: { kind: 'action', id: 'lock' } },
  { id: 'cmd:lockProtected', group: 'commands', label: 'common:ninja.commands.lockProtected', icon: Shield, to: { kind: 'action', id: 'lockProtected' } },
  { id: 'cmd:syncNow', group: 'commands', label: 'settings:syncPanel.syncNow', icon: ArrowsClockwise, to: { kind: 'action', id: 'syncNow' } },
  // Its label and icon follow the switch: Pause sync or Resume sync.
  { id: 'cmd:syncPause', group: 'commands', label: 'settings:syncPanel.pauseSync', icon: ArrowsClockwise, to: { kind: 'action', id: 'syncPause' } },
  { id: 'cmd:randomItem', group: 'commands', label: 'common:ninja.commands.randomItem', icon: Shuffle, to: { kind: 'action', id: 'randomItem' } },
  { id: 'cmd:emptyTrash', group: 'commands', label: 'common:emptyTrash.title', icon: Trash, to: { kind: 'action', id: 'emptyTrash' } },
  { id: 'page:changelog', group: 'commands', label: 'common:ninja.commands.changelog', icon: Megaphone, to: { kind: 'page', path: '/changelog' } },
  { id: 'page:help', group: 'commands', label: 'notes:settings.helpLabel', icon: Question, to: { kind: 'page', path: '/help' } },
  { id: 'page:themes', group: 'commands', label: 'common:ninja.commands.themesPage', icon: PaintBrush, to: { kind: 'page', path: '/themes' } },
  { id: 'page:home', group: 'commands', label: 'common:ninja.commands.website', icon: Globe, to: { kind: 'page', path: '/' } },
];

/** The settings sections a Features row already opens: ">" lists them once. */
export const SECTIONS_IN_FEATURES: ReadonlySet<string> = new Set(
  NINJA_DOORS.flatMap((d) => (d.group === 'features' && d.to.kind === 'settings' && d.to.entry.startsWith('section.') ? [d.to.entry] : [])),
);

/**
 * The views "Open a random item" picks in (#801). One rule: the list on
 * screen, and the pick opens as a click on its row opens it. Home has no
 * list and picks from the All list. Bookmarks is the one list where the pick
 * is a bookmark, and it opens the website, under its own label ("Open a
 * random bookmark"); every other list leaves its bookmarks out, so a pick
 * there never opens a website (owner, 2026-11-19). Tasks picks from its
 * items with tasks, Calendar from every item on the calendar. Not offered in
 * Trash (deleted items are not there to read again), or in Files and
 * Markdown, whose lists live inside their panes (owner, 2026-11-19: no new
 * plumbing for this command).
 * Spec: docs/internal/specs/ninja-features.md (section 10)
 */
const RANDOM_ITEM_VIEWS: ReadonlySet<View> = new Set<View>(['dashboard', 'home', 'all', 'starred', 'journal', 'tasks', 'calendar', 'contacts', 'drawings', 'vault', 'archive', 'bookmarks']);

/**
 * What "Open a random item" can open: the list on screen, as it is filtered
 * (search, tag, folder, space, the vault kind, the read-only and protected
 * switches; on Home the All list, in Tasks its items with tasks and in
 * Calendar the items on the calendar, which the caller hands in as `shown`),
 * less the open item, so every pick is a new one, and less an item behind a
 * shut gate, which would open on a PIN prompt (a shut bookmark keeps its
 * address behind the PIN). Bookmarks only in Bookmarks, none elsewhere.
 * Empty in a view that is not in `RANDOM_ITEM_VIEWS`, and the command is not
 * offered there.
 */
export function randomItemPool<T extends { id: string; type: string }>(
  view: View,
  shown: readonly T[],
  openId: string | null,
  gated: (item: T) => boolean,
): T[] {
  if (!RANDOM_ITEM_VIEWS.has(view)) return [];
  return shown.filter((n) => n.id !== openId && (n.type === 'link') === (view === 'bookmarks') && !gated(n));
}

/** One item of the pool, each as likely; none from an empty pool. */
export function pickRandom<T>(pool: readonly T[], random: () => number = Math.random): T | undefined {
  return pool[Math.floor(random() * pool.length)];
}

const RECENT_KEY = 'privacynotes.ninja.recentCommands';
/** How many commands ">" keeps as recent. */
const RECENT_COMMANDS_MAX = 5;

/** The ids of the commands run last in ">", newest first; empty when storage is closed. */
export function readRecentCommands(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, RECENT_COMMANDS_MAX) : [];
  } catch {
    return [];
  }
}

/** Put a command first in the recent list. */
export function noteRecentCommand(id: string): void {
  try {
    const next = [id, ...readRecentCommands().filter((x) => x !== id)].slice(0, RECENT_COMMANDS_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // A private window or blocked storage: the list stays as it was.
  }
}
