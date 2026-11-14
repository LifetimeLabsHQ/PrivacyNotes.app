import { adoptFactor } from '../factorList';
import { activeLocale } from '../i18n';
import { journalTitle } from '../notesViewUtils';
import { cleanFactorName, type FactorDef } from '../trackerTypes';
import { loadLocalSettings } from '../userSettings';

/**
 * What the mood-journal importers (Daylio, Diarium) share: the person's own
 * factor list, which receives the source's activities, and the title an
 * untitled entry gets, which is the one a new entry of the same day gets.
 * Spec: docs/internal/issues/0494.md (Spec)
 */

/** The account's settings, or null where none are readable (a test, a fresh tab). */
function settings() {
  try {
    return loadLocalSettings();
  } catch {
    return null;
  }
}

/**
 * The factors an import names. A name the person already has keeps its
 * factor (case and accents aside), so a second import or a factor typed by
 * hand never doubles a chip; a new name becomes a new factor, with the
 * source's group kept. `added()` is what the import hands to the settings
 * merge, which adds factors by id.
 */
export class ImportedFactors {
  private list: FactorDef[];
  private readonly before: Set<string>;

  constructor() {
    this.list = [...(settings()?.factors ?? [])];
    this.before = new Set(this.list.map((f) => f.id));
  }

  /** The factor id for a name, or null when the name is empty or the list is full. */
  id(name: string, group?: string): string | null {
    const r = adoptFactor(this.list, name);
    if (!r) return null;
    this.list = r.list;
    const g = group ? cleanFactorName(group) : '';
    if (g && !this.before.has(r.id)) {
      this.list = this.list.map((f) => (f.id === r.id && !f.group ? { ...f, group: g } : f));
    }
    return r.id;
  }

  /** The factors this import made. */
  added(): FactorDef[] {
    return this.list.filter((f) => !this.before.has(f.id));
  }
}

/** The title a new journal entry for `day` gets in this account. */
export function untitledEntryTitle(day: Date): string {
  const s = settings();
  return journalTitle(day, s?.journalTitleFormat ?? 'long', s?.journalTitleSuffix ?? '', activeLocale(), s?.journalTitlePattern ?? '');
}

/** `YYYY-MM-DD` from calendar numbers, or null when they name no real day. */
export function isoDay(year: number, month1: number, day: number): string | null {
  if (![year, month1, day].every(Number.isInteger)) return null;
  if (year < 1900 || year > 2200 || month1 < 1 || month1 > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month1 - 1, day));
  if (d.getUTCMonth() !== month1 - 1) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month1)}-${pad(day)}`;
}

/** Fixed-width blob key, so no key is a prefix of another. */
export function blobKey(prefix: string, index: number): string {
  return `${prefix}:${String(index).padStart(6, '0')}`;
}
