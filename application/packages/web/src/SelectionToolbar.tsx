/**
 * Selection toolbar - replaces the NotesView list header while one or
 * more notes are multi-selected, in the list and in the grid alike. Two modes:
 *
 *   - 'normal': bulk Export / Pin / Archive / Tag / Move / Delete (move to trash)
 *   - 'trash':  bulk Restore / Delete Forever
 *
 * Layout matches the header it replaces: h-14 and the same bottom border,
 * so there's no vertical jump when it swaps in.
 *
 * The actions stand in priority order, lowest first. When the pane is too
 * narrow for all of them, they fold from the left into the More menu, whose
 * button ends the row, so Delete is always the last to go and every action
 * stays one menu away. At LIST_WIDTH_MIN (200 px) the row holds the exit X,
 * Move, Delete and the menu button. A list that passes `moreItems` keeps the menu button on
 * the bar at every width: below the folded actions it lists the bulk actions
 * that have no button, such as Read-only, Protect and Duplicate.
 * Spec: docs/internal/design/ui-patterns.md (toolbar icon-only buttons, section 194)
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { HoverLabel } from './HoverLabel';
import { keyText } from './shortcutMatch';
import { TagPicker } from './TagPicker';
import { IconUpgrade } from './ui';
import { ContextMenu, useContextMenu, type ContextMenuItem } from './ContextMenu';
import { X, PushPin, Tag, Folder, Download, Trash, ArrowCounterClockwise, DotsThreeOutlineVertical, iconArchive } from './icons';

type Mode = 'normal' | 'trash';

type Props = {
  mode: Mode;
  /** True iff every selected note is currently starred. Drives the
   *  favorite button label / icon fill. Mixed selections treat as
   *  "not all starred" → clicking favorites all of them. */
  allStarred: boolean;
  /** True iff every selected note is archived: the button then unarchives. */
  allArchived: boolean;
  onClear: () => void;
  onFavorite: () => void;
  onArchive: () => void;
  onTag: (tag: string) => void;
  /** Bulk move to folder (Pro). Opens the shared folder picker, or the
   *  folders upsell when the plan doesn't include them. */
  onMoveToFolder: () => void;
  /** False renders the Pro badge on the move-to-folder button; the click
   *  still fires, the handler routes it to the upsell. */
  foldersUnlocked: boolean;
  onExport: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onDeleteForever: () => void;
  /** All existing tags with note counts, for the tag picker. */
  allTags?: [string, number][];
  /** The bulk actions the bar has no button for, read when More opens. With
   *  it, More is always on the bar in the normal mode, so a phone reaches
   *  every action of the selection's right-click menu (#805). */
  moreItems?: () => ContextMenuItem[];
};

type Action = {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  tone?: 'default' | 'danger' | 'success';
  pro?: boolean;
};

// The row geometry the fold reads: px-3 on each side, the w-8 buttons and the
// gap-1 between every two of them, the exit X included.
const PAD = 24;
const BUTTON = 32;
const GAP = 4;

/** How many actions stay on the bar, counted from the right, in a row whose
 *  inner width is `width`. The last action always stays. `more` says the
 *  More button is there whatever folds, so its slot is always counted. */
function fittingCount(width: number, total: number, more: boolean): number {
  const room = width - PAD - BUTTON - GAP;
  for (let k = total; k > 1; k--) {
    const slots = k + (k < total || more ? 1 : 0);
    if (slots * BUTTON + (slots - 1) * GAP <= room) return k;
  }
  return 1;
}

export function SelectionToolbar({
  mode,
  allStarred,
  allArchived,
  onClear,
  onFavorite,
  onArchive,
  onTag,
  onMoveToFolder,
  foldersUnlocked,
  onExport,
  onDelete,
  onRestore,
  onDeleteForever,
  allTags,
  moreItems,
}: Props) {
  const { t } = useTranslation('shell');
  const [tagOpen, setTagOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menu = useContextMenu();

  const actions: Action[] =
    mode === 'normal'
      ? [
          { key: 'export', label: t('selectionToolbar.export'), onClick: onExport, icon: <Download /> },
          {
            key: 'pin',
            label: allStarred ? t('shell:contextMenu.unpin') : t('shell:contextMenu.pin'),
            onClick: onFavorite,
            icon: <PushPin weight={allStarred ? 'fill' : 'bold'} />,
          },
          {
            key: 'archive',
            label: allArchived ? t('shell:contextMenu.unarchive') : t('shell:contextMenu.archive'),
            onClick: onArchive,
            icon: iconArchive(allArchived, 16),
          },
          { key: 'tag', label: t('selectionToolbar.tag'), onClick: () => setTagOpen((v) => !v), icon: <Tag /> },
          {
            key: 'folder',
            label: t('shell:contextMenu.moveToFolder'),
            onClick: onMoveToFolder,
            pro: !foldersUnlocked,
            icon: <Folder />,
          },
          { key: 'delete', label: t('common:actions.delete'), tone: 'danger', onClick: onDelete, icon: <Trash /> },
        ]
      : [
          {
            key: 'restore',
            label: t('shell:contextMenu.restore'),
            tone: 'success',
            onClick: onRestore,
            icon: <ArrowCounterClockwise />,
          },
          {
            key: 'deleteForever',
            label: t('shell:contextMenu.deleteForever'),
            tone: 'danger',
            onClick: onDeleteForever,
            icon: <Trash />,
          },
        ];

  const [shown, setShown] = useState(actions.length);
  const total = actions.length;
  const alwaysMore = mode === 'normal' && moreItems !== undefined;
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const measure = () => setShown(fittingCount(el.clientWidth, total, alwaysMore));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [total, alwaysMore]);

  const folded = actions.slice(0, total - shown);
  const visible = actions.slice(total - shown);

  const openMore = () => {
    const r = moreRef.current?.getBoundingClientRect();
    if (!r) return;
    const foldedItems: ContextMenuItem[] = folded.map((a) => ({
      label: a.label,
      icon: a.icon,
      pro: a.pro,
      // The tag picker toggles from the bar; from the menu it only opens.
      onSelect: a.key === 'tag' ? () => setTagOpen(true) : a.onClick,
    }));
    const rest = alwaysMore ? moreItems() : [];
    const items = foldedItems.length > 0 && rest.length > 0
      ? [...foldedItems, { type: 'separator' } as const, ...rest]
      : [...foldedItems, ...rest];
    // The button ends the row, so the menu hangs from its end edge and
    // stays over the list pane rather than spilling over the editor.
    const rtl = document.documentElement.dir === 'rtl';
    menu.open(
      { clientX: rtl ? r.left : r.right, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} },
      items,
      false,
      undefined,
      true,
    );
  };

  return (
    <div ref={rowRef} className="shrink-0 h-11 md:h-14 px-3 border-b border-divider flex items-center justify-between gap-1 bg-accent/5 dark:bg-accent/10">
      <HoverLabel label={t('shell:selectionToolbar.exitSelection')} keys={keyText('escape')} position="below">
      <button
        onClick={onClear}
        aria-label={t('selectionToolbar.exitSelection')}
        className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md text-pn-soft hover:bg-pn/5 hover:text-pn transition"
      >
        <X />
      </button>
      </HoverLabel>

      <div className="shrink-0 flex items-center gap-1">
        {visible.map((a) => (
          <ToolbarButton key={a.key} label={a.label} onClick={a.onClick} icon={a.icon} tone={a.tone} pro={a.pro} />
        ))}
        {(folded.length > 0 || alwaysMore) && (
          <HoverLabel label={t('selectionToolbar.more')} position="below">
          <button
            ref={moreRef}
            onClick={openMore}
            aria-label={t('selectionToolbar.more')}
            aria-haspopup="menu"
            aria-expanded={!!menu.state}
            className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md text-pn-soft hover:bg-pn/5 hover:text-pn transition"
          >
            <DotsThreeOutlineVertical />
          </button>
          </HoverLabel>
        )}
      </div>

      {tagOpen && (
        <TagPicker
          allTags={allTags ?? []}
          onSelect={(tag) => {
            setTagOpen(false);
            onTag(tag);
          }}
          onClose={() => setTagOpen(false)}
        />
      )}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </div>
  );
}

// ── Toolbar button ─────────────────────────────────────────────────────

import { forwardRef } from 'react';

const ToolbarButton = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    onClick: () => void;
    icon: React.ReactNode;
    tone?: 'default' | 'danger' | 'success';
    /** Corner upgrade badge, same treatment as the collapsed sidebar's
     *  Folders button. The button stays clickable - the handler routes to
     *  the upsell. */
    pro?: boolean;
  }
>(function ToolbarButton({ label, onClick, icon, tone = 'default', pro = false }, ref) {
  const base =
    'relative shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md transition';
  const toneClass =
    tone === 'danger'
      ? 'bg-red-500/10 hover:bg-red-500/20 text-danger'
      : tone === 'success'
        ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-success'
        : 'bg-accent/10 hover:bg-accent/20 text-accent-strong';
  return (
    <HoverLabel label={label} position="below">
    <button
      ref={ref}
      onClick={onClick}
      aria-label={label}
      className={`${base} ${toneClass}`}
    >
      {icon}
      {pro && (
        <span className="absolute -top-0.5 -end-0.5" aria-hidden="true">
          <IconUpgrade size={11} />
        </span>
      )}
    </button>
    </HoverLabel>
  );
});
