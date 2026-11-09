import { Trans, useTranslation } from 'react-i18next';
import { Archive, DotsThreeOutlineVertical, PencilSimpleSlash } from './icons';

/**
 * The line over a read-only item that says where the switch is. One copy for
 * the editor, the forms and the drawing; the caller sets the spacing.
 */
export function ReadOnlyHint({ className = '' }: { className?: string }) {
  const { t } = useTranslation('notes');
  return (
    <div className={`flex items-center gap-2 text-compact text-warning ${className}`}>
      <PencilSimpleSlash className="shrink-0" aria-hidden="true" />
      <span className="truncate">{t('editor.readOnlyToggle')}</span>
      <span className="inline-flex items-center gap-1 shrink-0">
        <DotsThreeOutlineVertical aria-hidden="true" />
        {t('editor.menu')}
      </span>
    </div>
  );
}

/**
 * The line over an archived item, in the read-only hint's slot, so a note
 * reached by a note-link, a search or in Zen says it is archived (#712).
 * Muted, not the warning tone: archived is a state, not a problem. No
 * button: Unarchive stays in the "..." menu beside Archive.
 */
export function ArchivedHint({ className = '' }: { className?: string }) {
  const { t } = useTranslation('notes');
  return (
    <div className={`flex items-center gap-2 text-compact text-pn-muted ${className}`}>
      <Archive className="shrink-0" aria-hidden="true" />
      <span className="truncate">{t('noteRow.archived')}</span>
    </div>
  );
}

/**
 * Says how many of the items a confirm modal asks about are read-only and
 * will therefore stay where they are. Renders nothing when none of them
 * are, so a caller can hand it a raw count without a guard of its own.
 */
export function ReadOnlySkipNotice({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border border-divider bg-surface-1 text-compact leading-snug p-3">
      <PencilSimpleSlash className="shrink-0 mt-0.5" />
      <span>
        <Trans
          i18nKey="notes:bulkTrash.readOnlySkipped"
          count={count}
          values={{ count }}
          components={{ highlight: <span className="font-medium text-pn" /> }}
        />
      </span>
    </div>
  );
}
