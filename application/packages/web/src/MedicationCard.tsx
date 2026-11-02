import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalNote } from './db';
import { closedMenuJustNow, type ContextMenuItem } from './ContextMenu';
import { Check, EyeSlash, Gear, LockSimple, Pill } from './icons';
import { CardGear, Shell } from './CheckInCard';
import { setMedicationCardShown } from './checkInCardSwitch';
import { checkInEntry } from './checkIn';
import { useToday } from './ListGroupHeader';
import { activeLocale } from './i18n';
import { MedicationRows, medicationRowsOn, takenOfRows } from './trackers/MedicationPill';
import { Snackbar } from './ui';
import type { JournalTrackerData, MedicationLogEntry, MedicationTemplate } from './trackerTypes';
import type { TrackerSetupTab } from './TrackerConfig';

/**
 * The medication card under the check-in card (GitHub #649): today's doses
 * with Taken and Skip, without the mood step first. It shows only while
 * the medication tracker is on and today asks about a medication, so a
 * person with none never sees it. The check-in's frame and options button,
 * so it sits in the list and the grid the way that card does. Every write
 * goes through the check-in's save (`onSave`), as the pill in the entry
 * would. A guarded entry shows a lock, and a tap opens the entry and its
 * gate. With every scheduled dose taken it folds to one line, and a tap
 * opens it again, for an as-needed dose too.
 * Spec: docs/internal/mood-wellness-tracker.md section 6.7, docs/internal/issues/0439.md (Spec)
 */
type Props = {
  grid: boolean;
  /** The live items of the open space; the card finds today's entry here. */
  notes: readonly LocalNote[];
  isGated: (n: LocalNote) => boolean;
  medications: MedicationTemplate[];
  /** Pro or the demo: the low-supply line shows. */
  supplyUnlocked: boolean;
  onSave: (day: string, patch: JournalTrackerData) => Promise<void>;
  onOpenDay: (day: string) => void;
  onOpenTrackers: (tab: TrackerSetupTab) => void;
  openMenu?: (
    e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void },
    items: ContextMenuItem[],
    keyboard?: boolean,
    clear?: () => { top: number; bottom: number },
    alignEnd?: boolean,
  ) => void;
};

export function MedicationCard(p: Props) {
  const { t } = useTranslation('shell');
  const today = useToday();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const rootRef = useRef<HTMLLIElement | null>(null);

  // A hide waits out its Undo and lands on unmount at the latest, like the
  // check-in card's.
  const pendingHide = useRef(false);
  const landHide = () => {
    if (!pendingHide.current) return;
    pendingHide.current = false;
    setMedicationCardShown(false);
  };
  useEffect(() => {
    if (!hidden) return;
    const timer = window.setTimeout(() => { landHide(); setHidden(false); }, 6000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the timer belongs to the notice
  }, [hidden]);
  useEffect(() => () => landHide(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount only
    []);

  const shell = (children: React.ReactNode, line = false) => (
    <Shell grid={p.grid} line={line} rootRef={rootRef} onRoot={() => {}}>{children}</Shell>
  );

  // The card leaves the list at once; the Undo stays at the bottom of the
  // window until the hide lands.
  if (hidden) {
    return (
      <li className="contents">
        <Snackbar actionLabel={t('notes:editor.undo')} onAction={() => { pendingHide.current = false; setHidden(false); }}>
          {t('medicationCard.hidden')}
        </Snackbar>
      </li>
    );
  }

  const entry = checkInEntry(p.notes, today);
  const guarded = !!entry && (p.isGated(entry) || entry.locked === 1);
  const logs = entry && !guarded ? (entry.trackers as JournalTrackerData | undefined)?.medications : undefined;
  const rows = medicationRowsOn(p.medications, logs, today);
  if (rows.length === 0) return null;

  function openGear(e: React.MouseEvent<HTMLButtonElement>) {
    if (closedMenuJustNow(e.currentTarget)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const rtl = document.documentElement.dir === 'rtl';
    const items: ContextMenuItem[] = [
      { label: t('checkIn.hide'), icon: <EyeSlash />, onSelect: () => { pendingHide.current = true; setHidden(true); } },
      { type: 'separator' },
      { label: t('contextMenu.settings'), icon: <Gear />, onSelect: () => p.onOpenTrackers('medications') },
    ];
    p.openMenu?.(
      { clientX: rtl ? r.left : r.right, clientY: r.bottom + 4, preventDefault: () => {}, stopPropagation: () => {} },
      items,
      e.detail === 0,
      undefined,
      !rtl,
    );
  }
  const gear = <CardGear label={t('medicationCard.options')} onClick={openGear} />;

  if (guarded) {
    return shell(
      <div className="flex items-center gap-2 min-h-8">
        <button
          type="button"
          onClick={() => p.onOpenDay(today)}
          className="min-w-0 flex-1 flex items-center gap-2 text-start text-compact text-pn-muted"
        >
          <span className="min-w-0 truncate">{t('checkIn.locked')}</span>
          <LockSimple aria-hidden="true" className="shrink-0" />
        </button>
        {gear}
      </div>,
      true,
    );
  }

  // Folded: every scheduled dose taken. An as-needed one is a tap away.
  const { expected, taken } = takenOfRows(rows, logs);
  if (!open && expected > 0 && taken === expected) {
    return shell(
      <div className="flex items-center gap-2 min-h-8">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t('medicationCard.edit')}
          className="min-w-0 flex-1 flex items-center gap-2 text-start text-compact"
        >
          <span aria-hidden="true" className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center bg-success/15 text-success pn-pop">
            <Check weight="bold" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold text-pn">{t('trackers:medication.takenCount', { count: taken })}</span>
            <span className="block truncate text-meta text-pn-muted">
              {new Intl.ListFormat(activeLocale(), { style: 'narrow', type: 'unit' }).format([...new Set(rows.map((r) => r.med.name))])}
            </span>
          </span>
        </button>
        {gear}
      </div>,
      true,
    );
  }

  return shell(
    <div className={`@container/checkin group/checkin mx-auto w-full ${p.grid ? 'max-w-[420px]' : ''}`}>
      <div className="relative flex items-center gap-2 min-h-8">
        <span className="min-w-0 flex items-center gap-1.5 text-compact font-medium text-pn">
          <Pill aria-hidden="true" className="shrink-0 text-accent" />
          <span className="truncate">{t('medicationCard.title')}</span>
        </span>
        <span className="flex-1" />
        {gear}
      </div>
      <div className="pt-1.5">
        <MedicationRows
          bare
          value={logs}
          day={today}
          onChange={(next: MedicationLogEntry[]) => { setOpen(false); void p.onSave(today, { medications: next }); }}
          templates={p.medications}
          supplyUnlocked={p.supplyUnlocked}
        />
      </div>
    </div>,
  );
}
