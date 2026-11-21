import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChartBar, EyeSlash, Heartbeat, MagnifyingGlass } from './icons';
import { HoverLabel } from './HoverLabel';
import { Switch } from './Switch';
import { Button, Popover, SETTINGS_EYEBROW, TextField } from './ui';
import { PILL_TONE, type PillTone } from './trackerTone';
import { textMatcher } from './textMatch';
import { formatDay } from './intlFormat';
import { TrackerIcon } from './trackers/TrackerIcon';
import type { DayMark } from './trackerFocus';
import type { TrackerDescriptor } from './wellnessTypes';

/**
 * The trackers the Calendar shows on its days. A day with values shows one
 * small button beside its number: the tracker's icon and value when one
 * tracker is on, the icons alone (in the tone of each value) when several
 * are, and a count past the room. A tap lists the day's values in a popover,
 * with the entry that holds them. The legend's Trackers button switches the
 * trackers, several at once, kept on this device.
 * Spec: docs/internal/specs/tracker-focus-771.md (section 6)
 */
export type CalendarTrackers = {
  /** The trackers with data, newest logged first, stopped ones last. */
  choices: readonly { id: string; d: TrackerDescriptor; name: string; stopped: boolean }[];
  shown: readonly string[];
  onChange: (ids: string[]) => void;
  /** The marks of a day, in the order of `shown`. */
  marks: (day: string) => readonly DayMark[];
  /** Opens Statistics, on the first tracker shown. */
  onOpenStats: () => void;
  /** Opens the journal entry a day's marks come from. */
  onOpenEntry: (id: string) => void;
};

const TONE_TEXT: Record<PillTone, string> = { good: 'text-success', bad: 'text-danger', warn: 'text-warning', neutral: 'text-pn' };

/** In a month cell, how many icons fit at each cell width: one, two from
 *  96 px, three from 124 px (the cell's inner width). The count after them says the rest. */
const CELL_STEPS = [
  { icon: '', count: '@min-[96px]/cell:hidden' },
  { icon: 'hidden @min-[96px]/cell:block', count: 'hidden @min-[96px]/cell:inline @min-[124px]/cell:hidden' },
  { icon: 'hidden @min-[124px]/cell:block', count: 'hidden @min-[124px]/cell:inline' },
] as const;

/** A day's tracker button and its popover of values. `max` is how many icons
 *  show before the count; `cell` fits them to a month cell's width instead. */
export function DayMarks({ day, marks, onOpenEntry, onOpenStats, max = 3, cell = false }: { day: string; marks: readonly DayMark[]; onOpenEntry: (id: string) => void; onOpenStats: () => void; max?: number; cell?: boolean }) {
  const { t } = useTranslation(['shell', 'stats', 'notes']);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  if (marks.length === 0) return null;
  const one = marks.length === 1 ? marks[0]! : null;
  const icons = marks.slice(0, max);
  const rest = marks.length - icons.length;
  const date = formatDay(day, 'date');
  const entryId = marks[0]!.entryId;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={t('calendar.trackersOn', { date })}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={`pointer-events-auto min-w-0 inline-flex items-center gap-1 h-6 px-1 rounded-md text-meta tabular-nums transition hover:bg-pn/10 ${open ? 'bg-pn/10' : ''}`}
      >
        {one ? (
          <>
            <TrackerIcon d={one.d} className="shrink-0" style={{ color: one.paint }} />
            <span className={`min-w-0 truncate font-semibold ${TONE_TEXT[one.tone]}`}>{one.text}</span>
          </>
        ) : (
          cell ? (
            <>
              {marks.slice(0, CELL_STEPS.length).map((m, i) => <TrackerIcon key={m.id} d={m.d} className={`shrink-0 ${CELL_STEPS[i]!.icon}`} style={{ color: m.paint }} />)}
              {CELL_STEPS.map((step, i) => marks.length > i + 1 && <span key={i} className={`shrink-0 text-pn-muted ${step.count}`}>+{marks.length - i - 1}</span>)}
            </>
          ) : (
            <>
              {icons.map((m) => <TrackerIcon key={m.id} d={m.d} className="shrink-0" style={{ color: m.paint }} />)}
              {rest > 0 && <span className="shrink-0 text-pn-muted">+{rest}</span>}
            </>
          )
        )}
      </button>
      <Popover open={open} anchorRef={anchor} onClose={() => setOpen(false)} title={date}>
        <ul className="max-h-72 overflow-y-auto space-y-1">
          {/* Tag lists last: their longer badges end the list. */}
          {[...marks.filter((m) => !m.tags), ...marks.filter((m) => m.tags)].map((m) => (
            <li key={m.id} className="min-w-0 text-small">
              <div className="flex items-center gap-2 min-w-0">
                <TrackerIcon d={m.d} className="shrink-0" style={{ color: m.d.color }} />
                <span className="flex-1 min-w-0 truncate text-pn">{m.name}</span>
                {!m.tags && <span className={`shrink-0 max-w-[50%] truncate rounded px-1.5 font-semibold tabular-nums ${PILL_TONE[m.tone]}`}>{m.text}</span>}
              </div>
              {/* A tag list (emotions, factors) is one value badge on its own
                  line under the name, never squeezed into the value column. */}
              {m.tags && (
                <div className="pt-1 pb-0.5">
                  <span className={`inline-block max-w-full break-words rounded px-1.5 font-semibold ${PILL_TONE[m.tone]}`}>{m.tags.join(', ')}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
        {/* Two equal columns, Statistics always first; alone it takes the row. */}
        <div className="mt-3 pt-2 border-t border-divider grid grid-cols-2 gap-2">
          <Button variant="secondary" icon={<ChartBar aria-hidden="true" />} onClick={() => { setOpen(false); onOpenStats(); }} className={`w-full ${entryId ? '' : 'col-span-2'}`}>{t('notes:settings.statsLabel')}</Button>
          {entryId && <Button action="open" onClick={() => { setOpen(false); onOpenEntry(entryId); }} className="w-full">{t('stats:home.openEntry')}</Button>}
        </div>
      </Popover>
    </>
  );
}

/** The legend's Trackers button and its list of switches. */
export function TrackersMenu({ trackers }: { trackers: CalendarTrackers }) {
  const { t } = useTranslation(['shell', 'notes', 'stats', 'trackers']);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchor = useRef<HTMLButtonElement | null>(null);
  const on = new Set(trackers.shown);
  const shownChoices = trackers.choices.filter((c) => on.has(c.id));
  const match = textMatcher(query);
  const list = query.trim() ? trackers.choices.filter((c) => match(c.name) !== null) : trackers.choices;
  const label = t('notes:settings.trackersLabel');
  // Grouped as Settings > Trackers groups them: the trackers, the habit
  // questions, the medicines, then what is stopped.
  const live = list.filter((c) => !c.stopped);
  const groups = [
    { key: 'trackers', title: label, items: live.filter((c) => c.d.source !== 'medication' && !c.d.id.startsWith('habit-')) },
    { key: 'habits', title: t('trackers:labels.habits'), items: live.filter((c) => c.d.id.startsWith('habit-')) },
    { key: 'medication', title: t('trackers:labels.medication'), items: live.filter((c) => c.d.source === 'medication') },
    { key: 'stopped', title: t('stats:wellness.trackers.stopped'), items: list.filter((c) => c.stopped) },
  ].filter((g) => g.items.length > 0);
  const row = (c: CalendarTrackers['choices'][number]) => (
    <Switch
      key={c.id}
      label={<span className="flex min-w-0 items-center gap-2"><TrackerIcon d={c.d} className="shrink-0" style={{ color: c.d.color }} /><span className="truncate">{c.name}</span></span>}
      checked={on.has(c.id)}
      onChange={(next) => trackers.onChange(next ? [...trackers.shown, c.id] : trackers.shown.filter((id) => id !== c.id))}
      className="gap-2 py-1"
      labelClassName="text-small text-pn min-w-0"
    />
  );
  return (
    <>
      <HoverLabel label={label} position="below" className="@min-[560px]/calhead:[&>:last-child]:hidden">
        <button
          ref={anchor}
          type="button"
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex items-center gap-1 min-h-6 text-small transition ${shownChoices.length ? 'text-pn' : 'text-pn-muted'} hover:text-pn`}
        >
          {shownChoices.length ? (
            shownChoices.slice(0, 3).map((c) => <TrackerIcon key={c.id} d={c.d} style={{ color: c.d.color }} />)
          ) : (
            <Heartbeat aria-hidden="true" />
          )}
          <span aria-hidden="true" className="hidden @min-[560px]/calhead:inline">{label}</span>
        </button>
      </HoverLabel>
      <Popover open={open} anchorRef={anchor} onClose={() => { setOpen(false); setQuery(''); }} title={label} align="end">
        <div className="max-h-80 overflow-y-auto space-y-0.5">
          {trackers.choices.length > 8 && (
            <TextField
              size="sm"
              icon={<MagnifyingGlass aria-hidden="true" />}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('calendar.findTracker')}
              aria-label={t('calendar.findTracker')}
              className="mb-2"
            />
          )}
          {groups.map((g) => (
            <div key={g.key} className="pt-1">
              {groups.length > 1 && <p className={`pb-1 ${SETTINGS_EYEBROW}`}>{g.title}</p>}
              {g.items.map(row)}
            </div>
          ))}
        </div>
        {/* Two equal columns, Statistics always first; alone it takes the row. */}
        <div className="mt-2 pt-2 border-t border-divider grid grid-cols-2 gap-2">
          <Button variant="secondary" icon={<ChartBar aria-hidden="true" />} onClick={() => { setOpen(false); trackers.onOpenStats(); }} className={`w-full ${trackers.shown.length > 0 ? '' : 'col-span-2'}`}>{t('notes:settings.statsLabel')}</Button>
          {trackers.shown.length > 0 && (
            <Button variant="secondary" icon={<EyeSlash aria-hidden="true" />} onClick={() => trackers.onChange([])} className="w-full">{t('calendar.trackersOff')}</Button>
          )}
        </div>
      </Popover>
    </>
  );
}
