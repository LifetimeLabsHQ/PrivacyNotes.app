import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { PencilSimpleSlash, Shield, ClockCounterClockwise, Copy, Repeat } from '../icons';
import type { LocalNote } from '../db';
import { HoverLabel, ProGlyph } from '../ui';
import { noteActionGuards, type NoteActionGuardDeps } from '../noteActionGuards';
import { proUnlocked } from '../demo';
import { isConvertSource } from '../noteTypes';

/**
 * Editor header width thresholds, measured on the header row itself rather
 * than the viewport, because the sidebar and the notes list are drag-resizable
 * and the row wears `.pn-content-col` (896px at Default, 1344px at Wide, full
 * pane at Full).
 *
 * Five steps:
 * - < 560px (Compact): prev/next, Share and Calendar leave the bar; Share
 *   moves into the "..." menu strip and Calendar stays in "..." under Date &
 *   reminders / Entry date.
 * - 560-679px (Narrow): prev/next and Share appear; Calendar stays in "...".
 * - 680-959px (Default): Calendar joins the bar (date pill or Add to calendar).
 * - 960-1279px (Wide): Tier 1 Pro shortcuts appear (Read-only, Protect, History).
 * - >= 1280px (Full): Tier 2 shortcuts join (Duplicate, Convert to).
 *
 * Move to folder stays off the header because the Folder chip sits directly
 * below it in the tag row, and Full screen stays in "..." (with its shortcut).
 * Spec: docs/internal/design/ui-patterns.md (section 80)
 */
export const HEADER_COMPACT_PX = 560;
export const HEADER_CALENDAR_PX = 680;
export const QUICK_ACTIONS_CORE_PX = 960;
export const QUICK_ACTIONS_ALL_PX = 1280;

export type QuickActionsTier = 0 | 1 | 2;

export function headerLayoutForWidth(width: number): {
  compact: boolean;
  showCalendar: boolean;
  quickActionsTier: QuickActionsTier;
} {
  return {
    compact: width < HEADER_COMPACT_PX,
    showCalendar: width >= HEADER_CALENDAR_PX,
    quickActionsTier: width >= QUICK_ACTIONS_ALL_PX ? 2 : width >= QUICK_ACTIONS_CORE_PX ? 1 : 0,
  };
}

/**
 * The per-note actions the editor header shows as bare icons once the
 * header row is wide enough to hold them.
 *
 * These same actions live in the "..." menu at every width, and they stay
 * there. That is the one deliberate difference from the menu's icon strip,
 * which appears only while the header hides share: the strip stands IN FOR a
 * hidden row, while this row is a shortcut to a menu the user may keep using
 * exactly as before. Nobody's habit breaks when the window gets wider.
 * Spec: docs/internal/design/ui-patterns.md (section 80)
 *
 * Order is by gate, not by menu order: the three Pro actions sit together,
 * then a hairline, then the two anyone can use, then a hairline before the
 * trailing Share / Calendar / "..." cluster.
 */
type Props = {
  note: LocalNote;
  isPro: boolean;
  tier: QuickActionsTier;
  guards: NoteActionGuardDeps;
  onDuplicate: () => void;
  /** Open the "..." menu on its Convert to view. */
  onConvertType?: () => void;
};

export function NoteQuickActions({
  note,
  isPro,
  tier,
  guards,
  onDuplicate,
  onConvertType,
}: Props) {
  const { t } = useTranslation('notes');
  if (tier === 0) return null;

  const act = noteActionGuards(guards);
  const canConvert = !!onConvertType && isConvertSource(note.type);

  return (
    <>
      <div className="shrink-0 flex items-center gap-0.5">
        <QuickButton
          label={t('notes:noteRow.readOnly')}
          onClick={act.toggleLock}
          active={note.locked === 1}
          pro={!isPro}
        >
          <PencilSimpleSlash aria-hidden="true" />
        </QuickButton>
        <QuickButton
          label={t('shell:noteOptionsMenu.protect')}
          onClick={act.toggleProtect}
          active={note.pinProtected === 1}
          pro={!isPro}
        >
          <Shield weight={note.pinProtected === 1 ? 'fill' : undefined} aria-hidden="true" />
        </QuickButton>
        <QuickButton
          label={t('shell:noteOptionsMenu.noteHistory')}
          onClick={act.openHistory}
          pro={!isPro}
          disabled={proUnlocked(isPro) && !guards.onOpenHistory}
        >
          <ClockCounterClockwise aria-hidden="true" />
        </QuickButton>
      </div>

      {tier === 2 && (
        <>
          <HeaderDivider />
          <div className="shrink-0 flex items-center gap-0.5">
            <QuickButton label={t('shell:contextMenu.duplicate')} onClick={onDuplicate}>
              <Copy aria-hidden="true" />
            </QuickButton>
            {canConvert && (
              <QuickButton
                label={t('shell:noteOptionsMenu.convertTo')}
                onClick={onConvertType}
              >
                <Repeat aria-hidden="true" />
              </QuickButton>
            )}
          </div>
        </>
      )}

      <HeaderDivider />
    </>
  );
}

/**
 * The hairline between two groups of header icons. It is what tells the
 * groups apart now that nothing in this row wears a filled container:
 * one button style, one separator, and colour left to mean state.
 * Decorative, so it is hidden from the accessibility tree - every button
 * already names itself, and a rule announced between them is noise.
 */
export function HeaderDivider({ className = 'mx-0.5' }: { className?: string }) {
  return <span aria-hidden="true" className={`shrink-0 h-4 w-px bg-pn-muted/35 ${className}`} />;
}

/** One 32px square. Every button in the editor header wears this box. */
function QuickButton({
  label,
  onClick,
  children,
  active,
  pro,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  /** Pro-gated for this user. Marked with a corner rocket glyph. */
  pro?: boolean;
  disabled?: boolean;
}) {
  return (
    <HoverLabel label={label} pro={pro} position="below">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        className={`relative shrink-0 flex items-center justify-center w-8 h-8 rounded-md transition disabled:opacity-40 disabled:cursor-not-allowed ${
          active
            ? 'text-accent-strong bg-accent/15'
            : 'text-pn-soft [@media(hover:hover)]:hover:text-accent [@media(hover:hover)]:hover:bg-pn/10 active:scale-95'
        }`}
      >
        <ProGlyph pro={!!pro}>{children}</ProGlyph>
      </button>
    </HoverLabel>
  );
}
