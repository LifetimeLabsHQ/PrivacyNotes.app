/**
 * The two windows of Home's edit mode: the redesigned visual widget gallery
 * (search, category rail, mini previews) and the chooser of what a note, tag,
 * folder, tracker, counter or item-list widget shows. A widget that points at
 * something is only made once the person picks, so a cancel adds nothing.
 * Spec: docs/internal/specs/dashboard.md (section 6)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge, Button, Checkbox, DeleteButton, EmptyState, Modal, ModalFooter, ProMark, SectionEyebrow, SETTINGS_HELP, SettingsSegmented, useProGate,
} from '../ui';
import { CalendarDots, ChartLineUp, Check, Folder, Graph, Hash, ListBullets, Package, SquaresFour, Tag, type Icon } from '../icons';
import { ListSearchInput } from '../ListSearchInput';
import NoteRow from '../NoteRow';
import { ItemList, useItemList } from '../itemList';
import { textMatcher } from '../textMatch';
import { editedAtOf } from '../notesViewUtils';
import { MARKDOWN_NOTE_TYPES } from '../noteTypes';
import { trackerName } from '../stats/wellnessModel';
import { TrackerTile } from '../stats/statsParts';
import { CustomTrackerGlyph } from '../trackers/CustomTrackerGlyph';
import { activeCustomTrackers } from '../trackerTypes';
import { WIDGETS, WIDGET_KINDS, formatItemTypes, parseItemTypes, type WidgetGroup, type WidgetKind, type WidgetTarget } from './dashboardLayout';
import { itemTypeViewRows } from '../viewRows';
import type { View } from '../views';
import { useDashboardEnv } from './env';
import { GROUP_KEY, WidgetGlyph, widgetNameKey } from './widgetGlyphs';
import { WidgetPreview } from './WidgetPreview';
import type { TrackerDescriptor } from '../wellnessTypes';

export type ChooserKind = WidgetTarget;

const GROUPS: readonly WidgetGroup[] = ['today', 'notes', 'graph', 'stats', 'keep'];
/** The kinds that point at something can be on Home more than once. */
const MANY: ReadonlySet<WidgetKind> = new Set(['note', 'tag', 'folder', 'tracker', 'counter', 'types']);

const GROUP_ICON: Record<WidgetGroup, Icon> = {
  today: CalendarDots,
  notes: ListBullets,
  graph: Graph,
  stats: ChartLineUp,
  keep: Package,
};

export function WidgetCatalog({ onHomeCounts, isPro, unlocked, onUpgrade, trackersExist, onAdd, onRemove, onClose }: {
  /** How many widgets of each kind sit on Home now. */
  onHomeCounts: ReadonlyMap<string, number>;
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
  const { t } = useTranslation(['shell', 'notes', 'stats', 'common', 'trackers']);
  const env = useDashboardEnv();
  const gate = useProGate(unlocked, onUpgrade);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | WidgetGroup>('all');
  const [filterMode, setFilterMode] = useState<'all' | 'onHome'>('all');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    gridRef.current?.scrollTo({ top: 0 });
  }, [category, filterMode]);

  const hasJournal = useMemo(() => env.pool.some((n) => n.type === 'journal'), [env.pool]);
  const offered = useMemo(() => {
    return WIDGET_KINDS.filter((k) => {
      if (k === 'onThisDay' && !hasJournal) return false;
      if (k === 'tracker' && !trackersExist) return false;
      return true;
    });
  }, [hasJournal, trackersExist]);

  const match = useMemo(() => textMatcher(query), [query]);
  const q = query.trim();

  const matchesSearch = (k: WidgetKind) => {
    if (filterMode === 'onHome' && (onHomeCounts.get(k) ?? 0) === 0) return false;
    if (!q) return true;
    return match(t(widgetNameKey(k))) !== null || match(t(`shell:dashboard.w.${k}.help`)) !== null;
  };

  const visibleByGroup = useMemo(() => {
    const map = new Map<WidgetGroup, WidgetKind[]>();
    for (const g of GROUPS) map.set(g, []);
    for (const k of offered) {
      if (!matchesSearch(k)) continue;
      map.get(WIDGETS[k].group)?.push(k);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matchesSearch closes over query/filterMode/onHomeCounts
  }, [offered, q, match, filterMode, onHomeCounts, t]);

  const totalMatches = useMemo(
    () => [...visibleByGroup.values()].reduce((sum, list) => sum + list.length, 0),
    [visibleByGroup],
  );
  const onHomeTotal = useMemo(
    () => offered.filter((k) => (onHomeCounts.get(k) ?? 0) > 0).length,
    [offered, onHomeCounts],
  );

  const shownGroups = category === 'all' ? GROUPS : [category];
  const hasAnyInView = shownGroups.some((g) => (visibleByGroup.get(g)?.length ?? 0) > 0);

  return (
    <Modal title={t('shell:dashboard.catalogTitle')} onClose={onClose} header="bar" className="max-w-lg md:max-w-4xl xl:max-w-5xl h-[min(85dvh,46rem)] flex flex-col">
      {/* Search + All / On Home bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider px-5 py-3">
        <div className="min-w-[12rem] flex-1">
          <ListSearchInput
            inputRef={searchRef}
            value={query}
            onChange={setQuery}
            placeholder={t('shell:dashboard.catalogSearch')}
            ariaLabel={t('shell:dashboard.catalogSearch')}
          />
        </div>
        <SettingsSegmented
          label={t('shell:dashboard.catalogFilter')}
          value={filterMode}
          onChange={(v) => setFilterMode(v as 'all' | 'onHome')}
          options={[
            { value: 'all', label: t('stats:wellness.subTabs.all') },
            { value: 'onHome', label: t('shell:dashboard.onHomeCount', { count: onHomeTotal }) },
          ]}
        />
      </div>

      {/* Category chips on narrow screens */}
      <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-divider px-5 py-2 md:hidden">
        <button
          type="button"
          onClick={() => setCategory('all')}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-small font-medium transition ${
            category === 'all' ? 'bg-accent/15 text-accent' : 'bg-track text-pn-muted hover:text-pn'
          }`}
        >
          <span>{t('stats:wellness.subTabs.all')}</span>
          <span className="text-meta tabular-nums opacity-75">{totalMatches}</span>
        </button>
        {GROUPS.map((g) => {
          const count = visibleByGroup.get(g)?.length ?? 0;
          return (
            <button
              key={g}
              type="button"
              onClick={() => setCategory(g)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-small font-medium transition ${
                category === g ? 'bg-accent/15 text-accent' : 'bg-track text-pn-muted hover:text-pn'
              }`}
            >
              <span>{t(GROUP_KEY[g])}</span>
              <span className="text-meta tabular-nums opacity-75">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Category rail on desktop */}
        <nav aria-label={t('shell:dashboard.catalogTitle')} className="hidden w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-e border-divider bg-track/35 p-3 md:flex">
          <button
            type="button"
            onClick={() => setCategory('all')}
            aria-current={category === 'all' ? 'page' : undefined}
            className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-compact font-medium transition ${
              category === 'all' ? 'bg-surface-2 text-pn shadow-xs ring-1 ring-divider' : 'text-pn-muted hover:bg-pn/5 hover:text-pn'
            }`}
          >
            <SquaresFour aria-hidden="true" className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate">{t('shell:dashboard.allWidgets')}</span>
            <span className="text-meta tabular-nums text-pn-muted">{totalMatches}</span>
          </button>
          {GROUPS.map((g) => {
            const IconComp = GROUP_ICON[g];
            const count = visibleByGroup.get(g)?.length ?? 0;
            return (
              <button
                key={g}
                type="button"
                onClick={() => setCategory(g)}
                aria-current={category === g ? 'page' : undefined}
                className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-compact font-medium transition ${
                  category === g ? 'bg-surface-2 text-pn shadow-xs ring-1 ring-divider' : 'text-pn-muted hover:bg-pn/5 hover:text-pn'
                }`}
              >
                <IconComp aria-hidden="true" className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">{t(GROUP_KEY[g])}</span>
                <span className="text-meta tabular-nums text-pn-muted">{count}</span>
              </button>
            );
          })}
        </nav>

        {/* Visual card grid */}
        <div ref={gridRef} className="@container flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          {!hasAnyInView ? (
            <EmptyState compact>{t('notes:empty.noMatches')}</EmptyState>
          ) : (
            shownGroups.map((group) => {
              const kinds = visibleByGroup.get(group) ?? [];
              if (!kinds.length) return null;
              return (
                <section key={group}>
                  <SectionEyebrow icon={GROUP_ICON[group]} className="mb-2.5">{t(GROUP_KEY[group])}</SectionEyebrow>
                  <ul className="grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
                    {kinds.map((k) => {
                      const def = WIDGETS[k];
                      const count = onHomeCounts.get(k) ?? 0;
                      const repeatable = MANY.has(k);
                      const there = !repeatable && count > 0;
                      return (
                        <li
                          key={k}
                          className={`flex min-w-0 flex-col gap-2.5 rounded-xl border p-2.5 transition ${
                            there ? 'border-accent/45 bg-surface-2' : 'border-divider bg-surface-2'
                          }`}
                        >
                          <WidgetPreview kind={k} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="shrink-0 text-accent"><WidgetGlyph kind={k} /></span>
                              <span className="truncate text-compact font-medium text-pn">{t(widgetNameKey(k))}</span>
                              {def.pro && !isPro && <ProMark />}
                              {repeatable && count > 0 && (
                                <Badge tone="info"><span className="tabular-nums">{count}</span></Badge>
                              )}
                            </div>
                            <p className={`mt-1 line-clamp-2 ${SETTINGS_HELP}`}>{t(`shell:dashboard.w.${k}.help`)}</p>
                          </div>
                          <div className="flex items-center justify-between gap-2 pt-0.5">
                            {there ? (
                              <span className="inline-flex items-center gap-1 text-small font-medium text-accent">
                                <Check aria-hidden="true" className="shrink-0" />
                                {t('shell:dashboard.onHomeLabel')}
                              </span>
                            ) : <span />}
                            {there ? (
                              <DeleteButton
                                kind="remove"
                                position="above-end"
                                label={`${t('shell:dashboard.removeFromHome')}: ${t(widgetNameKey(k))}`}
                                onConfirm={() => onRemove(k)}
                              />
                            ) : (
                              <Button
                                action="add"
                                onClick={def.pro ? gate(() => onAdd(k)) : () => onAdd(k)}
                                aria-label={`${t('shell:dashboard.addWidget')}: ${t(widgetNameKey(k))}`}
                              />
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
}

const TITLE: Record<ChooserKind, string> = {
  note: 'dashboard.chooseNote',
  tag: 'dashboard.chooseTag',
  folder: 'dashboard.chooseFolder',
  tracker: 'dashboard.chooseTracker',
  counter: 'dashboard.chooseCounter',
  types: 'dashboard.chooseTypes',
};

const MULTI_TITLE: Record<Exclude<ChooserKind, 'types'>, string> = {
  note: 'dashboard.chooseNotes',
  tag: 'dashboard.chooseTags',
  folder: 'dashboard.chooseFolders',
  tracker: 'checkIn.chooseTrackers',
  counter: 'dashboard.chooseCounters',
};

/** Shared multi-select state for every Home target chooser (item types, notes,
 *  tags, folders, trackers, counters). Keeps picks across search filtering and
 *  tracks whether anything changed from the initial active set. */
function useMultiPick(initial: readonly string[]) {
  const initialKey = initial.join('\0');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on initialKey
  const initialSet = useMemo(() => new Set(initial), [initialKey]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial));
  useEffect(() => {
    setPicked(new Set(initial));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on initialKey
  }, [initialKey]);

  const toggle = (value: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const hasInitial = initialSet.size > 0;
  const changed = picked.size !== initialSet.size || [...picked].some((v) => !initialSet.has(v));
  const submitDisabled = hasInitial ? !changed : picked.size === 0;
  return { picked, toggle, hasInitial, submitDisabled };
}

/** Pick the note, tag, folder, tracker, counter or item types a widget shows. */
export function TargetChooser(props: {
  kind: ChooserKind;
  /** Existing target value when editing a widget's choice in place. */
  initial?: string;
  /** Targets of this kind already on Home (for multi-select add/manage). */
  activeTargets?: readonly string[];
  trackers: TrackerDescriptor[];
  onPick: (value: string) => void;
  onPickMany?: (values: string[]) => void;
  onClose: () => void;
}) {
  if (props.kind === 'types') {
    return <TypesChooser initial={props.initial} onPick={props.onPick} onClose={props.onClose} />;
  }
  return (
    <OptionTargetChooser
      kind={props.kind}
      activeTargets={props.activeTargets}
      trackers={props.trackers}
      onPick={props.onPick}
      onPickMany={props.onPickMany}
      onClose={props.onClose}
    />
  );
}

/** Pick one or more item types for a Home Item list widget. */
function TypesChooser({ initial, onPick, onClose }: {
  initial?: string;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('shell');
  const initialTypes = useMemo(() => parseItemTypes(initial), [initial]);
  const { picked, toggle } = useMultiPick(initialTypes);
  const typeRows = useMemo(() => itemTypeViewRows(t), [t]);
  const save = () => {
    const ordered = typeRows.filter((row) => picked.has(row.key)).map((row) => row.key);
    if (ordered.length) onPick(formatItemTypes(ordered));
  };

  return (
    <Modal title={t(TITLE.types)} onClose={onClose} header="bar" className="max-w-md max-h-[85dvh] flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <ul className="space-y-0.5">
          {typeRows.map((row) => (
            <li key={row.key}>
              <Checkbox
                checked={picked.has(row.key)}
                onChange={() => toggle(row.key)}
                label={
                  <span className="inline-flex items-center gap-2">
                    <row.icon className="shrink-0 text-accent" aria-hidden="true" />
                    <span>{row.label}</span>
                  </span>
                }
                className="rounded-md px-3 py-2 hover:bg-pn/5 transition"
              />
            </li>
          ))}
        </ul>
      </div>
      <ModalFooter bar>
        <Button action="cancel" onClick={onClose} />
        <Button action={initial ? 'save' : 'add'} disabled={picked.size === 0} onClick={save} />
      </ModalFooter>
    </Modal>
  );
}

/** Shared searchable chooser for notes, tags, folders, trackers and counters.
 *  When `onPickMany` is passed (adding/managing from the catalog), every kind
 *  becomes a multi-select checkbox list backed by `useMultiPick` with a
 *  Cancel / Add-or-Save footer; when omitted (retargeting one widget via its
 *  grip menu), a click picks that single target right away. */
function OptionTargetChooser({ kind, activeTargets, trackers, onPick, onPickMany, onClose }: {
  kind: Exclude<ChooserKind, 'types'>;
  activeTargets?: readonly string[];
  trackers: TrackerDescriptor[];
  onPick: (value: string) => void;
  onPickMany?: (values: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(['shell', 'notes', 'stats', 'trackers']);
  const { t: tStats } = useTranslation('stats');
  const env = useDashboardEnv();
  const multi = !!onPickMany;
  const { picked, toggle, hasInitial, submitDisabled } = useMultiPick(multi ? (activeTargets ?? []) : []);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // The field takes the keyboard when the window opens, as a picker does.
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => field.current?.focus(), []);

  const match = useMemo(() => textMatcher(query), [query]);
  const allNotes = useMemo(() => {
    if (kind !== 'note') return [];
    return env.pool
      .filter((n) => MARKDOWN_NOTE_TYPES.includes(n.type))
      .sort((a, b) => editedAtOf(b).localeCompare(editedAtOf(a)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, env.pool, env.gatedKey]);
  const notes = useMemo(() => {
    if (kind !== 'note') return [];
    // A gated item's title is part of what its gate keeps: a search does not reach it.
    return allNotes.filter((n) => !q || (!env.isNoteLocked(n) && match(n.title) !== null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, allNotes, env.gatedKey, q, match]);
  const list = useItemList([kind, q], notes.length);

  const options = useMemo((): { value: string; label: string; count?: number; tracker?: TrackerDescriptor; counterIcon?: string }[] => {
    if (kind === 'tag') {
      const counts = new Map<string, number>();
      for (const n of env.pool) for (const tag of n.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ value: tag, label: `#${tag}`, count }));
    }
    if (kind === 'folder') return [...env.folders].sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ value: f.id, label: f.name }));
    if (kind === 'tracker') return trackers.map((d) => ({ value: d.id, label: trackerName(d, tStats), tracker: d }));
    if (kind === 'counter') {
      return activeCustomTrackers(env.trackerSettings.customTrackers)
        .filter((c) => c.type === 'counter')
        .map((c) => ({ value: c.id, label: c.name, counterIcon: c.icon }));
    }
    return [];
  }, [kind, env.pool, env.folders, env.trackerSettings.customTrackers, trackers, tStats]);
  const shown = useMemo(() => options.filter((o) => !q || match(o.label) !== null), [options, q, match]);
  const Glyph = kind === 'tag' ? Tag : kind === 'counter' ? Hash : Folder;
  const titleKey = multi ? MULTI_TITLE[kind] : TITLE[kind];
  const hasAny = kind === 'note' ? allNotes.length > 0 : options.length > 0;

  const saveMany = () => {
    if (!onPickMany) return;
    if (kind === 'note') {
      const ordered = allNotes.filter((n) => picked.has(n.id)).map((n) => n.id);
      // Preserve any already-active ids that are outside the current space/filter.
      for (const id of picked) if (!ordered.includes(id)) ordered.push(id);
      onPickMany(ordered);
      return;
    }
    const ordered = options.filter((o) => picked.has(o.value)).map((o) => o.value);
    for (const v of picked) if (!ordered.includes(v)) ordered.push(v);
    onPickMany(ordered);
  };

  return (
    <Modal
      title={t(`shell:${titleKey}`)}
      onClose={onClose}
      header="bar"
      className="max-w-md max-h-[85dvh] flex flex-col"
    >
      {hasAny && (
        <div className="shrink-0 px-4 pt-3 pb-2">
          <ListSearchInput inputRef={field} value={query} onChange={setQuery} placeholder={t(`shell:${titleKey}`)} ariaLabel={t(`shell:${titleKey}`)} />
        </div>
      )}
      {kind === 'note' && notes.length > 0 ? (
        <ItemList list={list} grid={false} className="min-h-0 flex-1 px-3 pb-3">
          {notes.slice(0, list.reveal.visible).map((n) => (
            <NoteRow
              key={n.id}
              note={n}
              isOpen={false}
              listPrefs={{ ...env.listPrefs, showPreview: false, showTags: false }}
              isNoteLocked={env.isNoteLocked(n)}
              selectionMode={multi}
              isMultiSelected={multi && picked.has(n.id)}
              onToggleSelect={multi ? () => toggle(n.id) : undefined}
              onClick={() => (multi ? toggle(n.id) : onPick(n.id))}
            />
          ))}
        </ItemList>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
          {kind === 'note' ? (
            <EmptyState compact>{t(q ? 'notes:empty.noMatches' : 'shell:dashboard.noneToChoose')}</EmptyState>
          ) : shown.length > 0 ? (
            <ul className="space-y-0.5">
              {shown.map((o) => {
                const glyph = o.tracker ? (
                  <TrackerTile d={o.tracker} size={22} />
                ) : o.counterIcon ? (
                  <CustomTrackerGlyph icon={o.counterIcon} />
                ) : (
                  <Glyph className="shrink-0 text-accent" aria-hidden="true" />
                );
                if (multi) {
                  return (
                    <li key={o.value}>
                      <Checkbox
                        checked={picked.has(o.value)}
                        onChange={() => toggle(o.value)}
                        label={
                          <span className="flex w-full min-w-0 items-center gap-2">
                            {glyph}
                            <span className="min-w-0 flex-1 truncate" dir="auto">{o.label}</span>
                            {o.count !== undefined && <span className="shrink-0 text-meta text-pn-muted tabular-nums">{o.count}</span>}
                          </span>
                        }
                        className="rounded-md px-3 py-2 hover:bg-pn/5 transition [&>span]:flex-1"
                      />
                    </li>
                  );
                }
                return (
                  <li key={o.value}>
                    <button type="button" onClick={() => onPick(o.value)} className="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-start text-body text-pn hover:bg-pn/5 transition">
                      {glyph}
                      <span className="min-w-0 flex-1 truncate" dir="auto">{o.label}</span>
                      {o.count !== undefined && <span className="shrink-0 text-meta text-pn-muted tabular-nums">{o.count}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : kind === 'counter' && !q ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <EmptyState compact flush>{t('shell:dashboard.empty.counter')}</EmptyState>
              <Button
                action="open"
                onClick={() => {
                  onClose();
                  env.openTrackers('custom');
                }}
              >
                {t('shell:dashboard.setupCounter')}
              </Button>
            </div>
          ) : (
            <EmptyState compact>{t(q ? 'notes:empty.noMatches' : 'shell:dashboard.noneToChoose')}</EmptyState>
          )}
        </div>
      )}
      {multi && hasAny && (
        <ModalFooter bar>
          <Button action="cancel" onClick={onClose} />
          <Button action={hasInitial ? 'save' : 'add'} disabled={submitDisabled} onClick={saveMany} />
        </ModalFooter>
      )}
    </Modal>
  );
}
