import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalNote } from './db';
import { closedMenuJustNow, type ContextMenuItem } from './ContextMenu';
import { Check, EyeSlash, Gear, LockSimple, Pill } from './icons';
import { CardGear, Shell } from './CheckInCard';
import { setMedicationCardShown } from './checkInCardSwitch';
import { checkInEntry } from './checkIn';
import { useToday } from './ListGroupHeader';
import { activeLocale } from './i18n';
import { MedicationRows } from './trackers/MedicationPill';
import { medicationRowsOn, takenOfRows } from './medicationDoses';
import { Badge, Button, EmptyState, ProgressBar, Snackbar } from './ui';
import type { JournalTrackerData, MedicationLogEntry, MedicationTemplate } from './trackerTypes';
import type { TrackerSetupTab } from './TrackerConfig';

/**
 * The medication card under the check-in card (GitHub #649): today's doses
 * with Taken and Skip, without the mood step first. It shows only while
 * the medication tracker is on and today asks about a medication, so a
 * person with none never sees it. On Home (`home`) it stays in its tile even
 * when folded or empty, and carries Home's arranging tools (`controls`).
 * Every write goes through the check-in's save (`onSave`), as the pill in
 * the entry would. A guarded entry shows a lock, and a tap opens the entry
 * and its gate. With every scheduled dose taken it folds to one line, and a
 * tap opens it again, for an as-needed dose too.
 * Spec: docs/internal/mood-wellness-tracker.md section 6.7, docs/internal/issues/0439.md (Spec)
 */
type Props = {
  grid: boolean;
  /** On Home: every state keeps the tile, and empty shows a setup link. */
  home?: boolean;
  /** Home's placement of the tile in its grid. */
  style?: CSSProperties;
  /** Home's state of the tile: the fade while dragged, the ring while resized. */
  className?: string;
  /** Home's arranging tools (grip tab, resize corner), drawn in the tile. */
  controls?: ReactNode;
  /** Home's id for the tile, which its reorder finds by. */
  reorderId?: string;
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

  const shell = (children: ReactNode, line = false, center = false) => (
    <Shell
      grid={p.grid}
      line={p.home ? false : line}
      rootRef={rootRef}
      onRoot={() => {}}
      style={p.style}
      className={p.className}
      center={Boolean(p.home && center)}
      reorderId={p.reorderId}
    >
      {children}
      {p.controls}
    </Shell>
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
  if (rows.length === 0) {
    if (!p.home) return null;
    return shell(
      <div className="flex h-full flex-col items-center justify-center gap-2 py-2 text-center">
        <EmptyState compact flush>{t('dashboard.empty.medication')}</EmptyState>
        <Button action="open" onClick={() => p.onOpenTrackers('medications')}>
          {t('dashboard.setupMedication')}
        </Button>
      </div>,
      false,
      true,
    );
  }

  function openGear(e: React.MouseEvent<HTMLButtonElement>) {
    if (closedMenuJustNow(e.currentTarget)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const rtl = document.documentElement.dir === 'rtl';
    const items: ContextMenuItem[] = [
      ...(p.home ? [] : [
        { label: t('checkIn.hide'), icon: <EyeSlash />, onSelect: () => { pendingHide.current = true; setHidden(true); } },
        { type: 'separator' as const },
      ]),
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
      true,
    );
  }

  return shell(
    <div className="@container/checkin group/checkin w-full">
      <div className="relative flex items-center gap-2 min-h-8">
        <span className="min-w-0 flex items-center gap-1.5 text-compact font-medium text-pn">
          <Pill aria-hidden="true" className="shrink-0 text-accent" />
          <span className="truncate">{t('trackers:labels.medication')}</span>
        </span>
        {expected > 0 && (
          <Badge tone={taken === expected ? 'success' : 'neutral'}>
            <span className="tabular-nums">{taken}/{expected}</span>
          </Badge>
        )}
        <span className="flex-1" />
        {gear}
      </div>
      {expected > 0 && (
        <div className="pt-1 pb-2">
          <ProgressBar value={taken / expected} tone="success" label={t('medicationCard.title')} />
        </div>
      )}
      <div className={expected > 0 ? '' : 'pt-1.5'}>
        <MedicationRows
          bare
          value={logs}
          day={today}
          onChange={(next: MedicationLogEntry[]) => {
            // Auto-fold only when completing the final scheduled dose; keep the
            // reopened card open when logging as-needed doses or adjusting rows.
            if (expected > 0 && taken < expected && takenOfRows(rows, next).taken === expected) setOpen(false);
            void p.onSave(today, { medications: next });
          }}
          templates={p.medications}
          supplyUnlocked={p.supplyUnlocked}
        />
      </div>
    </div>,
    false,
    false,
  );
}
