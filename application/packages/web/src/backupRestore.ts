import { readCustomHabits } from './habitList';
import { applyRestoredFolders, validateFolders } from './folders';
import { deletedFolderIds, itemStylesEqual, mergeItemStyles, validateItemStyles } from './itemStyles';
import { customThemesEqual, mergeCustomThemes, validateCustomThemes } from './customThemes';
import type { UserSettings } from './userSettings';
import {
  CAFFEINE_UNITS, defaultTrackerSettings, readCustomTrackerTemplates, readFactors, readHabits, readMedicationTemplates,
  WATER_UNITS, WEIGHT_UNITS, type CustomTrackerTemplate, type FactorDef, type MedicationTemplate, type TrackerSettings,
} from './trackerTypes';
import { mergeCalendarFeeds, validateCalendarFeeds, type CalendarFeeds } from './calendarFeeds';
import { mergeDashboardSettings, validateDashboardSetting, type DashboardSetting } from './dashboard/dashboardLayout';
import type { ItemStyles } from './itemStyles';
import type { CustomThemes } from './customThemes';
import type { CustomHabitDef } from './habitList';

/** The tracker setup beside the definitions: what is switched on, and the units. */
type TrackerSetup = Pick<TrackerSettings, 'activeBuiltins' | 'habits' | 'archivedMedications' | 'weightUnit' | 'waterUnit' | 'caffeineUnit'>;

/** The settings a full backup carries beside the items (`buildFullBackupZip`
 *  in export.ts). tests/backupSettingsInventory.test.ts holds every settings
 *  key to this list or to a written reason for staying out. */
export interface CarriedSettings {
  itemStyles?: ItemStyles;
  customThemes?: CustomThemes;
  factors?: FactorDef[];
  customHabits?: CustomHabitDef[];
  medications?: MedicationTemplate[];
  customTrackers?: CustomTrackerTemplate[];
  favoriteTags?: string[];
  calendarFeeds?: CalendarFeeds;
  dashboard?: DashboardSetting;
  agentFolder?: string | null;
  trackerSetup?: TrackerSetup;
}

/** What a backup made now carries, from the settings as they stand. One
 *  function, so the manual export and the automatic backup write the same. */
export function carriedSettings(s: UserSettings): CarriedSettings {
  // Settings from an older envelope can lack the tracker block; the export
  // read it with `?.` before this list existed, and must still not throw.
  // Without it the backup carries no tracker setup, and a restore keeps the
  // account's own.
  const t = s.trackerSettings as UserSettings['trackerSettings'] | undefined;
  return {
    itemStyles: s.itemStyles,
    customThemes: s.customThemes,
    factors: s.factors,
    customHabits: s.customHabits,
    medications: s.medications,
    customTrackers: t?.customTrackers,
    favoriteTags: s.favoriteTags,
    calendarFeeds: s.calendarFeeds,
    dashboard: s.dashboard,
    agentFolder: s.agentFolder,
    ...(t ? {
      trackerSetup: {
        activeBuiltins: t.activeBuiltins, habits: t.habits, archivedMedications: t.archivedMedications,
        weightUnit: t.weightUnit, waterUnit: t.waterUnit, caffeineUnit: t.caffeineUnit,
      },
    } : {}),
  };
}

/** The settings a backup holds, as text: the folders and `carriedSettings`.
 *  The automatic backup hashes it for "no changes", so a write to any other
 *  setting (a dismissed hint, a milestone, this counter's `settingsRev`), or
 *  a restore that changes nothing, does not make the next run write a file.
 *  Spec: docs/internal/plans/auto-backup.md (section 6, No changes) */
export function backupSettingsKey(s: UserSettings): string {
  return JSON.stringify({ folders: s.folders, ...carriedSettings(s) });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The setup a backup carries, laid over the account's. A restore repairs
 * what is missing and never turns back what the person set since:
 *   - pinned tags and archived medications: the ones the account lacks are added;
 *   - subscribed calendars and the Home layout: merged entry by entry, the
 *     way two devices merge them, so the newer entry wins;
 *   - the trackers that are on, the habit questions and the units: taken
 *     only while the account still has the value of a new account;
 *   - the command line's folder: taken only while the account has none, and
 *     only when that folder came back (the caller passes its final id).
 * Answers only the fields that change.
 */
function restoredSetup(
  prev: UserSettings,
  backup: { favoriteTags?: unknown; calendarFeeds?: unknown; dashboard?: unknown; agentFolder?: unknown; trackerSetup?: unknown },
  /** The folder tree as this restore leaves it. */
  folders: readonly { id: string }[],
): Partial<UserSettings> {
  const out: Partial<UserSettings> = {};
  if (Array.isArray(backup.favoriteTags)) {
    const have = new Set(prev.favoriteTags);
    const add = backup.favoriteTags.filter((t): t is string => typeof t === 'string' && t.length <= 200 && !have.has(t));
    if (add.length > 0) out.favoriteTags = [...prev.favoriteTags, ...new Set(add)];
  }
  if (backup.calendarFeeds !== undefined) {
    const merged = mergeCalendarFeeds(prev.calendarFeeds, validateCalendarFeeds(backup.calendarFeeds));
    if (!same(merged, prev.calendarFeeds)) out.calendarFeeds = merged;
  }
  if (backup.dashboard !== undefined) {
    const merged = mergeDashboardSettings(prev.dashboard, validateDashboardSetting(backup.dashboard));
    if (!same(merged, prev.dashboard)) out.dashboard = merged;
  }
  if (prev.agentFolder === null && typeof backup.agentFolder === 'string' && folders.some((f) => f.id === backup.agentFolder)) {
    out.agentFolder = backup.agentFolder;
  }
  if (backup.trackerSetup && typeof backup.trackerSetup === 'object') {
    const raw = backup.trackerSetup as Record<string, unknown>;
    const fresh = defaultTrackerSettings();
    const cur = prev.trackerSettings;
    const next: TrackerSettings = { ...cur };
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
    const builtins = strings(raw.activeBuiltins);
    if (builtins && same(cur.activeBuiltins, fresh.activeBuiltins)) next.activeBuiltins = builtins as TrackerSettings['activeBuiltins'];
    if (Array.isArray(raw.habits) && same(cur.habits, fresh.habits)) next.habits = readHabits(raw.habits);
    if (cur.weightUnit === fresh.weightUnit && (WEIGHT_UNITS as readonly unknown[]).includes(raw.weightUnit)) next.weightUnit = raw.weightUnit as TrackerSettings['weightUnit'];
    if (cur.waterUnit === fresh.waterUnit && (WATER_UNITS as readonly unknown[]).includes(raw.waterUnit)) next.waterUnit = raw.waterUnit as TrackerSettings['waterUnit'];
    if (cur.caffeineUnit === fresh.caffeineUnit && (CAFFEINE_UNITS as readonly unknown[]).includes(raw.caffeineUnit)) next.caffeineUnit = raw.caffeineUnit as TrackerSettings['caffeineUnit'];
    const known = new Set([...cur.archivedMedications, ...prev.medications].map((m) => m.id));
    const archived = readMedicationTemplates(raw.archivedMedications).filter((m) => !known.has(m.id));
    if (archived.length > 0) next.archivedMedications = [...cur.archivedMedications, ...archived];
    if (!same(next, cur)) out.trackerSettings = next;
  }
  return out;
}

/**
 * The settings a restore of an encrypted text backup leaves: its folders, the
 * looks of folders and tags, the custom themes and the factor names, each
 * merged the way sync merges them. Folders are additive by id, and one this account deleted stays
 * deleted, because its tombstone is final. Looks and themes merge per value:
 * a later change here wins over the backup's, a value deleted since the backup
 * stays deleted, and a deleted folder does not get its look back. Answers
 * `prev` itself when nothing changes, so a second restore writes nothing.
 */
export function settingsAfterRestore(
  prev: UserSettings,
  backup: { folders?: unknown; itemStyles?: unknown; customThemes?: unknown; factors?: unknown; customHabits?: unknown; medications?: unknown; customTrackers?: unknown; favoriteTags?: unknown; calendarFeeds?: unknown; dashboard?: unknown; agentFolder?: unknown; trackerSetup?: unknown },
): UserSettings {
  const folders = validateFolders(backup.folders);
  const looks = validateItemStyles(backup.itemStyles);
  const themes = validateCustomThemes(backup.customThemes);
  // A factor the account lacks comes back; one it holds keeps this device's
  // copy, its name and its tombstone included.
  const known = new Set(prev.factors.map((f) => f.id));
  const newFactors = readFactors(backup.factors).filter((f) => !known.has(f.id));
  // The person's own habit questions come back the same way.
  const knownHabits = new Set(prev.customHabits.map((h) => h.id));
  const newHabits = readCustomHabits(backup.customHabits).filter((h) => !knownHabits.has(h.id));
  // Medications and custom tracker definitions come back the same way, only
  // in a shape the app draws: the file may not be the person's own.
  const knownMeds = new Set(prev.medications.map((m) => m.id));
  const newMeds = readMedicationTemplates(backup.medications).filter((m) => !knownMeds.has(m.id));
  const knownTrackers = new Set(prev.trackerSettings.customTrackers.map((c) => c.id));
  const newTrackers = readCustomTrackerTemplates(backup.customTrackers).filter((c) => !knownTrackers.has(c.id));
  const result = applyRestoredFolders({ folders: prev.folders, deleted: prev.foldersDeleted }, folders);
  const setup = restoredSetup(prev, backup, result.tree.folders);
  const nothingNew = newFactors.length === 0 && newHabits.length === 0 && newMeds.length === 0 && newTrackers.length === 0 && Object.keys(setup).length === 0;
  if (folders.length === 0 && Object.keys(looks).length === 0 && Object.keys(themes).length === 0 && nothingNew) return prev;
  const itemStyles = mergeItemStyles(prev.itemStyles, looks, deletedFolderIds(result.tree.deleted));
  const customThemes = mergeCustomThemes(prev.customThemes, themes);
  const looksChanged = !itemStylesEqual(itemStyles, prev.itemStyles);
  const themesChanged = !customThemesEqual(customThemes, prev.customThemes);
  if (result.added === 0 && !looksChanged && !themesChanged && nothingNew) return prev;
  // The tracker setup and the new tracker definitions land in one object.
  const trackerBase = setup.trackerSettings ?? prev.trackerSettings;
  return {
    ...prev,
    ...setup,
    folders: result.tree.folders,
    foldersDeleted: result.tree.deleted,
    ...(looksChanged ? { itemStyles } : {}),
    ...(themesChanged ? { customThemes } : {}),
    ...(newFactors.length > 0 ? { factors: [...prev.factors, ...newFactors] } : {}),
    ...(newHabits.length > 0 ? { customHabits: [...prev.customHabits, ...newHabits] } : {}),
    ...(newMeds.length > 0 ? { medications: [...prev.medications, ...newMeds] } : {}),
    ...(newTrackers.length > 0
      ? { trackerSettings: { ...trackerBase, customTrackers: [...trackerBase.customTrackers, ...newTrackers] } }
      : {}),
  };
}

/**
 * The looks of a full backup zip, with each folder look moved to the id the
 * restore gave its folder. The zip rebuilds its folders from the paths its
 * notes carry, so a folder comes back under a new id, or under its saved one
 * when that folder is still live; `savedToFinal` maps one to the other. A
 * look whose folder did not come back is dropped; tag and note looks keep
 * their keys (tags by name, notes by the id the restore keeps).
 */
export function remapFolderLooks(raw: unknown, savedToFinal: ReadonlyMap<string, string>): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const out: [string, unknown][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('f:')) {
      out.push([key, value]);
      continue;
    }
    const final = savedToFinal.get(key.slice(2));
    if (final) out.push([`f:${final}`, value]);
  }
  return Object.fromEntries(out);
}

/** Saved folder id -> the id the restore kept, from the two maps a zip
 *  restore has: rebuilt -> saved (the parser) and rebuilt -> final (the
 *  folder merge). A folder the merge dropped has no entry. */
export function savedToFinalIds(
  originalIds: ReadonlyMap<string, string> | undefined,
  idMap: ReadonlyMap<string, string> | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [rebuilt, saved] of originalIds ?? []) {
    const final = idMap?.get(rebuilt);
    if (final) out.set(saved, final);
  }
  return out;
}

