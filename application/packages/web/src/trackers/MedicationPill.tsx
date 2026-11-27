import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SKIP_REASONS,
  activeMedications,
  type MedicationLogEntry,
  type MedicationStatus,
  type MedicationTemplate,
  type SkipReason,
} from '../trackerTypes';
import { PillShell } from './PillShell';
import { MedicationGlyph, TRACKER_ICONS } from './icons';
import { PanelQuestion, chipClass } from './panelUI';
import { Check, Gear, Plus, SkipForward, X } from '../icons';
import { HoverLabel } from '../HoverLabel';
import { Badge } from '../ui';
import { formatDay, toLocalIso } from '../intlFormat';
import { hhmm } from '../localDate';
import { timeLabel } from '../JournalCalendar';
import { useTrackerHistory } from '../trackerLastLogged';
import {
  LOW_SUPPLY_DAYS,
  daysLeft,
  doseLogId,
  groupScheduledDoses,
  logDoseId,
  logsOf,
  medicationRowsOn,
  newDoseId,
  runsOutOn,
  splitScheduledGroups,
  supplyLeft,
  takenOfRows,
  type ScheduledDoseItem,
} from '../medicationDoses';

type RowsProps = {
  value?: MedicationLogEntry[];
  /** The entry's day; today when the entry carries none. */
  day?: string;
  onChange: (v: MedicationLogEntry[]) => void;
  templates: MedicationTemplate[];
  /** Opens Settings > Trackers > Medication: the one place medications are
   *  added, edited and removed. */
  onEditMedications?: () => void;
  /** Pro or the demo: the low-supply badge shows (section 6.7). */
  supplyUnlocked?: boolean;
  readOnly?: boolean;
};

/**
 * Medication pill - flat checklist grouped by time of day (Morning, Afternoon,
 * Evening, Anytime, As needed), with a one-tap check circle, quiet Skip with
 * inline reason chips, Take all per time group, and inline low-supply badges.
 * It only logs: medications are added, edited and removed in Settings >
 * Trackers > Medication, which "Change these medications" opens.
 * Spec: docs/internal/mood-wellness-tracker.md section 6.7
 */
export function MedicationPill({ expanded, onToggle, ...rest }: RowsProps & { expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation('trackers');
  const entryDay = rest.day ?? toLocalIso(new Date());
  const rows = medicationRowsOn(rest.templates, rest.value, entryDay);
  // The count on the pill.
  const { expected, taken } = takenOfRows(rows, rest.value);
  const filledLabel =
    expected === 0
      ? undefined
      : taken === expected
        ? t('medication.takenCount', { count: taken })
        : `${taken}/${expected}`;

  return (
    <PillShell
      label={t('labels.meds')}
      filled={rows.length > 0 && (rest.value?.length ?? 0) > 0}
      expanded={expanded}
      onToggle={onToggle}
      filledLabel={filledLabel}
      icon={TRACKER_ICONS.medication}
      readOnly={rest.readOnly}
    >
      <MedicationRows {...rest} />
    </PillShell>
  );
}

/** The pill's panel: the question, the time-grouped checklist and as-needed
 *  rows. The medication card shows it without the question (`bare`). */
export function MedicationRows({
  value,
  day,
  onChange,
  templates,
  onEditMedications,
  supplyUnlocked = false,
  readOnly,
  bare = false,
}: RowsProps & { bare?: boolean }) {
  const { t } = useTranslation('trackers');
  const history = useTrackerHistory();

  const today = toLocalIso(new Date());
  const entryDay = day ?? today;
  const isToday = entryDay === today;
  const rows = medicationRowsOn(templates, value, entryDay);
  const hasAny = activeMedications(templates).length > 0;
  const scheduledGroups = groupScheduledDoses(rows);
  const prnRows = rows.filter((r) => r.asNeeded);

  const setStatus = (logId: string, status: MedicationStatus) => {
    const current = value ?? [];
    const idx = current.findIndex((e) => e.medicationId === logId);
    // A Taken tap on today's entry records when; a tap on another day does
    // not, because the time it happened is unknown.
    // `ts` lets the merge keep the newer of two taps on one dose.
    const entry: MedicationLogEntry = { medicationId: logId, status, ...(status === 'taken' && isToday ? { at: hhmm(new Date()) } : {}), ts: new Date().toISOString() };
    if (idx < 0) {
      onChange([...current, entry]);
      return;
    }
    // Tapping the status a medication already carries clears it.
    const next = [...current];
    if (current[idx]!.status === status) {
      next.splice(idx, 1);
    } else {
      next[idx] = entry;
    }
    onChange(next);
  };

  /** Mark every untaken dose in a time group as taken in one atomic write,
   *  leaving already-taken doses and their timestamps untouched. */
  const takeGroup = (items: readonly ScheduledDoseItem[]) => {
    const now = new Date();
    const at = isToday ? hhmm(now) : undefined;
    const ts = now.toISOString();
    const next = [...(value ?? [])];
    let changed = false;
    for (const item of items) {
      const idx = next.findIndex((e) => e.medicationId === item.logId);
      if (idx >= 0 && next[idx]!.status === 'taken') continue;
      const entry: MedicationLogEntry = { medicationId: item.logId, status: 'taken', ...(at ? { at } : {}), ts };
      if (idx < 0) next.push(entry);
      else next[idx] = entry;
      changed = true;
    }
    if (changed) onChange(next);
  };

  const setReason = (logId: string, reason: SkipReason) => {
    const current = value ?? [];
    onChange(current.map((e) => {
      if (e.medicationId !== logId) return e;
      const ts = new Date().toISOString();
      if (e.reason === reason) { const { reason: _, ...rest } = e; return { ...rest, ts }; }
      return { ...e, reason, ts };
    }));
  };

  // An as-needed dose is a fact of its own, with its own id, so two devices
  // that each log one keep both.
  const logDose = (medId: string) => {
    onChange([...(value ?? []), { medicationId: doseLogId(medId, newDoseId()), status: 'taken', ...(isToday ? { at: hhmm(new Date()) } : {}), ts: new Date().toISOString() }]);
  };
  const removeDose = (logId: string) => onChange((value ?? []).filter((e) => e.medicationId !== logId));

  // Low-supply map (Pro or demo): attached inline to the medication's first
  // scheduled dose row so the warning sits right on the medication it names.
  const supplyDays = history.map((d) => ({ date: typeof d.journalDate === 'string' ? d.journalDate : '', logs: d.medications }));
  const lowByMed = new Map<string, { left: number; tip: string }>();
  if (supplyUnlocked) {
    for (const { med } of rows) {
      if (lowByMed.has(med.id)) continue;
      const count = supplyLeft(med, supplyDays);
      const left = daysLeft(med, count);
      if (left !== null && left < LOW_SUPPLY_DAYS) {
        const date = runsOutOn(med, count, today);
        const tip = date
          ? t('medication.lowSupplyOn', { name: med.name, count: left, date: formatDay(date, 'date') })
          : t('medication.lowSupply', { name: med.name, count: left });
        lowByMed.set(med.id, { left, tip });
      }
    }
  }
  const shownLow = new Set<string>();

  // Hide the redundant "Anytime" label when a single untimed medication is the
  // only thing in the list; show headers whenever timed groups, Take all, or
  // multiple sections exist.
  const showScheduledHeader = (group: ScheduledDoseItem['group'], count: number) =>
    group !== 'anytime' || scheduledGroups.length > 1 || prnRows.length > 0 || count > 1;

  const twoColGroups = scheduledGroups.length >= 2;
  const twoColSingleGroup = scheduledGroups.length === 1 && scheduledGroups[0]!.items.length >= 2;
  const twoColPrn = prnRows.length >= 2;
  const [leftGroups, rightGroups] = twoColGroups ? splitScheduledGroups(scheduledGroups) : [scheduledGroups, []];

  const renderGroup = ({ group, items }: { group: ScheduledDoseItem['group']; items: ScheduledDoseItem[] }, itemGrid: boolean) => {
    const untaken = items.filter((item) => value?.find((e) => e.medicationId === item.logId)?.status !== 'taken').length;
    const header = showScheduledHeader(group, items.length);
    const compactWide = twoColGroups || itemGrid;
    return (
      <div key={group} className="flex flex-col min-w-0">
        {header && (
          <div className="flex items-center justify-between gap-2 pb-1">
            <span className="text-meta font-semibold text-pn-muted">{t(`medication.groups.${group}`)}</span>
            {!readOnly && items.length > 1 && untaken > 0 && (
              <button
                type="button"
                onClick={() => takeGroup(items)}
                className="text-meta font-medium text-accent hover:underline shrink-0"
              >
                {t('medication.takeAll')}
              </button>
            )}
          </div>
        )}
        <div className={itemGrid ? 'grid grid-cols-1 @[28rem]/meds:grid-cols-2 @[28rem]/meds:gap-x-6 divide-y divide-divider/60 @[28rem]/meds:divide-y-0' : 'flex flex-col divide-y divide-divider/60'}>
          {items.map((item, idx) => {
            const { med, dose, index, total, logId } = item;
            const log = value?.find((e) => e.medicationId === logId);
            const taken = log?.status === 'taken';
            const skipped = log?.status === 'skipped';
            const when = dose.time ? timeLabel(entryDay, dose.time) : total > 1 ? t('medication.doseN', { n: index + 1 }) : '';
            const sub = [
              strengthOn(med, entryDay),
              taken && log?.at ? t('medication.takenAt', { time: timeLabel(entryDay, log.at) }) : when,
            ].filter(Boolean).join(' · ');
            const low = !shownLow.has(med.id) ? lowByMed.get(med.id) : undefined;
            if (low) shownLow.add(med.id);
            const doseAria = when ? `${med.name}, ${when}` : med.name;
            const circleStyle: CSSProperties | undefined = !taken && !skipped && med.color
              ? { borderColor: med.color, backgroundColor: `color-mix(in srgb, ${med.color} 14%, transparent)`, color: med.color }
              : undefined;

            return (
              <div key={logId} className={`group/med min-w-0 ${itemGrid && idx >= 2 ? '@[28rem]/meds:border-t @[28rem]/meds:border-divider/60' : ''}`}>
                <div className="flex items-center gap-2.5 py-1.5 px-1 -mx-1 rounded-lg transition-colors hover:bg-pn/[0.04]">
                  <button
                    type="button"
                    disabled={readOnly}
                    aria-pressed={taken}
                    aria-label={`${doseAria} - ${t('medication.taken')}`}
                    onClick={() => !readOnly && setStatus(logId, 'taken')}
                    style={circleStyle}
                    className={`w-[22px] h-[22px] shrink-0 rounded-full border-[1.75px] inline-flex items-center justify-center transition ${
                      taken
                        ? 'border-success bg-success text-white'
                        : skipped
                          ? 'border-warning bg-warning/15 text-warning'
                          : med.color
                            ? ''
                            : 'border-accent bg-accent/10 text-accent'
                    } ${readOnly ? 'cursor-default' : 'active:scale-90'}`}
                  >
                    {taken ? (
                      <Check weight="bold" size={12} aria-hidden="true" />
                    ) : skipped ? (
                      <SkipForward size={11} aria-hidden="true" />
                    ) : !readOnly ? (
                      <Check weight="bold" size={11} aria-hidden="true" className="opacity-0 group-hover/med:opacity-45 transition-opacity" />
                    ) : null}
                  </button>
                  <button
                    type="button"
                    disabled={readOnly}
                    aria-pressed={taken}
                    onClick={() => !readOnly && setStatus(logId, 'taken')}
                    className={`min-w-0 flex-1 text-start ${readOnly ? 'cursor-default' : ''}`}
                  >
                    <span className={`block truncate text-compact font-medium ${taken ? 'text-pn-muted line-through decoration-pn-muted/45' : skipped ? 'text-pn-muted' : 'text-pn'}`}>
                      {med.name}
                    </span>
                    {(sub || low) && (
                      <span className="flex items-center gap-1.5 min-w-0 text-meta text-pn-muted">
                        {sub && <span className="min-w-0 truncate">{sub}</span>}
                        {low && (
                          <HoverLabel label={low.tip}>
                            <Badge tone="warning">{t('medication.daysLeftShort', { count: low.left })}</Badge>
                          </HoverLabel>
                        )}
                      </span>
                    )}
                  </button>
                  {!readOnly && (
                    <HoverLabel label={skipped ? t('medication.skipped') : t('medication.skip')} position="above-end">
                      <button
                        type="button"
                        aria-pressed={skipped}
                        aria-label={`${doseAria} - ${skipped ? t('medication.skipped') : t('medication.skip')}`}
                        onClick={() => setStatus(logId, 'skipped')}
                        className={`shrink-0 inline-flex items-center justify-center gap-1 h-7 px-1.5 ${compactWide ? '@[18rem]/meds:px-2 @[28rem]/meds:px-1.5' : '@[18rem]/meds:px-2'} rounded-md text-meta font-medium transition ${
                          skipped
                            ? 'bg-warning/15 text-warning'
                            : 'text-pn-muted opacity-65 group-hover/med:opacity-100 [@media(hover:none)]:opacity-90 hover:bg-pn/10 hover:text-pn'
                        }`}
                      >
                        <SkipForward aria-hidden="true" />
                        <span className={`hidden @[18rem]/meds:inline ${compactWide ? '@[28rem]/meds:hidden' : ''}`}>{skipped ? t('medication.skipped') : t('medication.skip')}</span>
                      </button>
                    </HoverLabel>
                  )}
                </div>
                {skipped && !readOnly && (
                  <div role="group" aria-label={t('medication.skipWhy')} className="flex flex-wrap items-center gap-1.5 pb-2 ps-8 @max-[16rem]/meds:ps-1">
                    <span className="text-meta text-pn-muted me-0.5">{t('medication.skipWhy')}</span>
                    {SKIP_REASONS.map((r) => (
                      <button key={r} type="button" aria-pressed={log.reason === r} onClick={() => setReason(logId, r)} className={chipClass(log.reason === r)}>
                        {t(`medication.reasons.${r}`)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className={`@container/meds flex flex-col gap-2.5 ${bare ? '' : 'max-w-[460px]'}`}>
      {!bare && <PanelQuestion>{t('medication.prompt')}</PanelQuestion>}
      {onEditMedications && !readOnly && !bare && (
        <button
          type="button"
          onClick={onEditMedications}
          className="-mt-3 mb-0.5 self-start inline-flex items-center gap-1.5 text-small font-medium text-accent hover:underline"
        >
          <Gear aria-hidden="true" />
          {t(hasAny ? 'medication.editList' : 'medication.add')}
        </button>
      )}
      {/* No row: either no medication at all, or none is due on this day
          (before its start, after its end, a day its repeat skips). */}
      {rows.length === 0 && (
        <p className="text-small text-pn-muted">{t(hasAny ? 'medication.noneThisDay' : onEditMedications ? 'medication.emptyAdd' : 'medication.empty')}</p>
      )}
      {twoColGroups ? (
        <div className="grid grid-cols-1 @[28rem]/meds:grid-cols-2 gap-y-2.5 @[28rem]/meds:gap-x-6 items-start">
          <div className="flex flex-col gap-2.5 min-w-0">
            {leftGroups.map((g) => renderGroup(g, false))}
          </div>
          <div className="flex flex-col gap-2.5 min-w-0">
            {rightGroups.map((g) => renderGroup(g, false))}
          </div>
        </div>
      ) : (
        scheduledGroups.map((g) => renderGroup(g, twoColSingleGroup))
      )}
      {prnRows.length > 0 && (
        <div className={`flex flex-col ${scheduledGroups.length > 0 ? '@[28rem]/meds:border-t @[28rem]/meds:border-divider/60 @[28rem]/meds:pt-2' : ''}`}>
          <div className="flex items-center justify-between gap-2 pb-1">
            <span className="text-meta font-semibold text-pn-muted">{t('medication.asNeeded')}</span>
          </div>
          <div className={twoColPrn ? 'grid grid-cols-1 @[28rem]/meds:grid-cols-2 @[28rem]/meds:gap-x-6 divide-y divide-divider/60 @[28rem]/meds:divide-y-0' : 'flex flex-col divide-y divide-divider/60'}>
            {prnRows.map(({ med }, idx) => {
              const logged = logsOf(value, med.id).filter((l) => l.status === 'taken');
              const max = med.maxPerDay;
              const sub = [strengthOn(med, entryDay), max ? t('medication.todayCount', { count: logged.length, max }) : t('medication.asNeeded')].filter(Boolean).join(' · ');
              const glyphStyle: CSSProperties | undefined = med.color
                ? { backgroundColor: `color-mix(in srgb, ${med.color} 14%, transparent)`, color: med.color }
                : undefined;
              return (
                <div key={med.id} className={`min-w-0 ${twoColPrn && idx >= 2 ? '@[28rem]/meds:border-t @[28rem]/meds:border-divider/60' : ''}`}>
                  <div className="flex items-center gap-2.5 py-1.5 px-1 -mx-1 rounded-lg transition-colors hover:bg-pn/[0.04]">
                    <span
                      aria-hidden="true"
                      style={glyphStyle}
                      className={`w-[22px] h-[22px] shrink-0 rounded-md inline-flex items-center justify-center ${med.color ? '' : 'bg-accent/10 text-accent'}`}
                    >
                      <MedicationGlyph form={med.form} size={13} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-compact font-medium text-pn">{med.name}</span>
                      <span className="block truncate text-meta text-pn-muted">{sub}</span>
                    </div>
                    {!readOnly && (
                      <HoverLabel label={t('medication.logDose')} position="above-end">
                        <button
                          type="button"
                          onClick={() => logDose(med.id)}
                          aria-label={`${t('medication.logDose')} - ${med.name}`}
                          className="shrink-0 inline-flex items-center justify-center gap-1 h-7 px-2 @[17rem]/meds:px-2.5 rounded-md bg-surface-0 text-small font-medium text-pn-soft hover:bg-accent/10 hover:text-accent transition"
                        >
                          <Plus size={12} aria-hidden="true" />
                          <span className="hidden @[17rem]/meds:inline">{t('medication.logShort')}</span>
                        </button>
                      </HoverLabel>
                    )}
                  </div>
                  {logged.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pb-2 ps-8 @max-[16rem]/meds:ps-1">
                      {logged.map((l) => {
                        const label = l.at ? timeLabel(entryDay, l.at) : t('medication.dose');
                        return (
                          <span key={l.medicationId} className={chipClass(true)}>
                            {label}
                            {!readOnly && (
                              <button type="button" onClick={() => removeDose(l.medicationId)} aria-label={t('medication.removeDose', { time: label })} className="ms-1 -me-1 inline-flex items-center justify-center w-4 h-4 rounded hover:bg-pn/10">
                                <X size={10} aria-hidden="true" />
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {max !== undefined && logged.length >= max && (
                    <p className="pb-1.5 ps-8 @max-[16rem]/meds:ps-1 text-meta text-warning">{t('medication.limitReached')}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** The strength a day was taken at: the last dose change on or before it,
 *  so a past entry keeps the dose of its day after a change. */
function strengthOn(med: MedicationTemplate, day: string): string {
  let at = '';
  for (const h of med.dosageHistory) if (h.changedAt <= day) at = h.dosage;
  return at || med.dosage;
}
