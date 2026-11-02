/**
 * The two windows of Home's edit mode: the catalog that adds a widget, and
 * the chooser of what a note, tag, folder or tracker widget shows. A widget
 * that points at something is only made once the person picks, so a cancel
 * adds nothing.
 * Spec: docs/internal/specs/dashboard.md (section 6)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, EmptyState, Modal, SectionEyebrow, SETTINGS_HELP, useProGate } from '../ui';
import { HoverLabel } from '../HoverLabel';
import { Minus } from '../icons';
import { ListSearchInput } from '../ListSearchInput';
import NoteRow from '../NoteRow';
import { ItemList, useItemList } from '../itemList';
import { textMatcher } from '../textMatch';
import { Folder, Tag } from '../icons';
import { editedAtOf } from '../notesViewUtils';
import { MARKDOWN_NOTE_TYPES } from '../noteTypes';
import { trackerName } from '../stats/wellnessModel';
import { TrackerTile } from '../stats/statsParts';
import { WIDGETS, WIDGET_KINDS, type WidgetGroup, type WidgetKind, type WidgetTarget } from './dashboardLayout';
import { useDashboardEnv } from './env';
import { GROUP_KEY, WidgetGlyph, widgetNameKey } from './widgetGlyphs';
import type { TrackerDescriptor } from '../wellnessTypes';

export type ChooserKind = WidgetTarget;

const GROUPS: readonly WidgetGroup[] = ['today', 'notes', 'stats', 'keep'];
/** The kinds that point at something can be on Home more than once. */
const MANY: ReadonlySet<WidgetKind> = new Set(['note', 'tag', 'folder', 'tracker']);

export function WidgetCatalog({ onHome, isPro, unlocked, onUpgrade, trackersExist, onAdd, onRemove, onClose }: {
  /** The kinds on Home now. */
  onHome: ReadonlySet<string>;
  /** The Pro mark shows for an account without Pro, the demo included. */
  isPro: boolean;
  /** Pro or the demo: the gate. */
  unlocked: boolean;
  onUpgrade: () => void;
  trackersExist: boolean;
  onAdd: (kind: WidgetKind) => void;
  /** Takes the one widget of a kind off Home; the window stays open. */
  onRemove: (kind: WidgetKind) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(['shell', 'notes', 'stats']);
  const env = useDashboardEnv();
  const gate = useProGate(unlocked, onUpgrade);
  const hasJournal = useMemo(() => env.pool.some((n) => n.type === 'journal'), [env.pool]);
  const offered = (k: WidgetKind) => {
    if (k === 'onThisDay' && !hasJournal) return false;
    if (k === 'tracker' && !trackersExist) return false;
    return true;
  };
  return (
    // Wide on a big screen, so the catalog reads at a glance: each group's
    // rows in two or three columns (the scroll area is the container).
    <Modal title={t('dashboard.catalogTitle')} onClose={onClose} header="bar" className="max-w-lg md:max-w-3xl xl:max-w-5xl max-h-[85dvh] flex flex-col">
      <div className="@container flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-5">
        {GROUPS.map((group) => {
          const kinds = WIDGET_KINDS.filter((k) => WIDGETS[k].group === group && offered(k));
          if (!kinds.length) return null;
          return (
            <section key={group}>
              <SectionEyebrow className="mb-2">{t(GROUP_KEY[group])}</SectionEyebrow>
              <ul className="grid gap-x-6 gap-y-1 @2xl:grid-cols-2 @4xl:grid-cols-3">
                {kinds.map((k) => {
                  const def = WIDGETS[k];
                  const there = !MANY.has(k) && onHome.has(k);
                  return (
                    <li key={k} className="flex items-center gap-3 min-w-0 py-1.5">
                      <span className="shrink-0 text-accent"><WidgetGlyph kind={k} /></span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-body text-pn truncate">{t(widgetNameKey(k))}</span>
                        <span className={`block line-clamp-2 ${SETTINGS_HELP}`}>{t(`dashboard.w.${k}.help`)}</span>
                      </span>
                      {/* One square toggle, no words to translate: a filled
                          plus adds, an outlined minus takes the widget off
                          Home again. A kind that can be on Home more than
                          once (it points at something) always adds. */}
                      {there ? (
                        <HoverLabel label={t('dashboard.removeFromHome')} position="above-end">
                          <Button icon={<Minus aria-hidden="true" />} onClick={() => onRemove(k)} aria-label={`${t('dashboard.removeFromHome')}: ${t(widgetNameKey(k))}`} className="!px-2.5">
                            {''}
                          </Button>
                        </HoverLabel>
                      ) : (
                        <HoverLabel label={t('dashboard.addWidget')} position="above-end">
                          <Button action="add" pro={def.pro && !isPro} onClick={def.pro ? gate(() => onAdd(k)) : () => onAdd(k)} aria-label={`${t('dashboard.addWidget')}: ${t(widgetNameKey(k))}`} className="!px-2.5">
                            {''}
                          </Button>
                        </HoverLabel>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}

const TITLE: Record<ChooserKind, string> = {
  note: 'dashboard.chooseNote',
  tag: 'dashboard.chooseTag',
  folder: 'dashboard.chooseFolder',
  tracker: 'dashboard.chooseTracker',
};

/** Pick the note, tag, folder or tracker a widget shows. */
export function TargetChooser({ kind, trackers, onPick, onClose }: {
  kind: ChooserKind;
  trackers: TrackerDescriptor[];
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('shell');
  const { t: tStats } = useTranslation('stats');
  const env = useDashboardEnv();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // The field takes the keyboard when the window opens, as a picker does.
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => field.current?.focus(), []);

  const match = useMemo(() => textMatcher(query), [query]);
  const notes = useMemo(() => {
    if (kind !== 'note') return [];
    // A gated item's title is part of what its gate keeps: a search does not reach it.
    return env.pool
      .filter((n) => MARKDOWN_NOTE_TYPES.includes(n.type) && (!q || (!env.isNoteLocked(n) && match(n.title) !== null)))
      .sort((a, b) => editedAtOf(b).localeCompare(editedAtOf(a)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, env.pool, env.gatedKey, q, match]);
  const list = useItemList([kind, q], notes.length);

  const options = useMemo((): { value: string; label: string; count?: number; tracker?: TrackerDescriptor }[] => {
    if (kind === 'tag') {
      const counts = new Map<string, number>();
      for (const n of env.pool) for (const tag of n.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ value: tag, label: `#${tag}`, count }));
    }
    if (kind === 'folder') return [...env.folders].sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ value: f.id, label: f.name }));
    if (kind === 'tracker') return trackers.map((d) => ({ value: d.id, label: trackerName(d, tStats), tracker: d }));
    return [];
  }, [kind, env.pool, env.folders, trackers, tStats]);
  const shown = options.filter((o) => !q || match(o.label) !== null);
  const Glyph = kind === 'tag' ? Tag : Folder;

  return (
    <Modal title={t(TITLE[kind])} onClose={onClose} header="bar" className="max-w-lg max-h-[85dvh] flex flex-col">
      <div className="shrink-0 px-6 pt-4 pb-2">
        <ListSearchInput inputRef={field} value={query} onChange={setQuery} placeholder={t(TITLE[kind])} ariaLabel={t(TITLE[kind])} />
      </div>
      {kind === 'note' && notes.length ? (
        <ItemList list={list} grid={false} className="min-h-0 px-3 pb-4">
          {notes.slice(0, list.reveal.visible).map((n) => (
            <NoteRow key={n.id} note={n} isOpen={false} listPrefs={{ ...env.listPrefs, showPreview: false, showTags: false }} isNoteLocked={env.isNoteLocked(n)} onClick={() => onPick(n.id)} />
          ))}
        </ItemList>
      ) : (
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4">
        {kind === 'note' ? (
          <EmptyState compact>{t(q ? 'notes:empty.noMatches' : 'dashboard.noneToChoose')}</EmptyState>
        ) : shown.length ? (
          <ul>
            {shown.map((o) => (
              <li key={o.value}>
                <button type="button" onClick={() => onPick(o.value)} className="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-start text-body text-pn hover:bg-pn/5 transition">
                  {o.tracker ? <TrackerTile d={o.tracker} size={22} /> : <Glyph className="shrink-0 text-accent" aria-hidden="true" />}
                  <span className="min-w-0 flex-1 truncate" dir="auto">{o.label}</span>
                  {o.count !== undefined && <span className="shrink-0 text-meta text-pn-muted tabular-nums">{o.count}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState compact>{t(q ? 'notes:empty.noMatches' : 'dashboard.noneToChoose')}</EmptyState>
        )}
      </div>
      )}
    </Modal>
  );
}
