import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { liveQuery } from 'dexie';
import type { ReplacedCopy } from '../db';
import { Button } from '../ui';
import { formatRelative } from '../intlFormat';
import { listCopiesOfGoneNotes, REPLACED_COPY_DAYS, restoreCopyAsNote } from '../replacedCopies';

/**
 * The Trash's list of replaced copies whose note no longer exists
 * (replacedCopies.ts, beta #203 item 2): the text a sync replaced on this
 * device, kept 30 days, which the note's History window can no longer show
 * once the note is gone. Restore brings one back as a new note and opens it.
 * Shown only while there is one.
 * Spec: docs/internal/design/ui-patterns.md section 193
 */
export function TrashReplacedCopies({ onRestored }: { onRestored: (id: string) => void }) {
  const { t } = useTranslation('notes');
  const [copies, setCopies] = useState<ReplacedCopy[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const sub = liveQuery(() => listCopiesOfGoneNotes()).subscribe({ next: setCopies, error: () => setCopies([]) });
    return () => sub.unsubscribe();
  }, []);
  if (copies.length === 0) return null;

  const restore = async (copy: ReplacedCopy) => {
    setBusy(copy.id);
    try {
      onRestored((await restoreCopyAsNote(copy)).id);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="shrink-0 border-b border-divider px-4 py-2" aria-label={t('trash.replacedTitle')}>
      <p className="text-small font-medium text-pn">{t('trash.replacedTitle')}</p>
      <p className="text-meta text-pn-muted">{t('billing:history.replacedSubtitle', { days: REPLACED_COPY_DAYS })}</p>
      <ul className="mt-1.5 max-h-48 space-y-1 overflow-y-auto">
        {copies.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-compact" dir="auto">{c.title.trim() || t('common:state.untitled')}</span>
              <span className="block text-meta text-pn-muted">{formatRelative(c.at)}</span>
            </span>
            <Button action="restore" variant="secondary" disabled={busy !== null} onClick={() => void restore(c)}>
              {t('shell:contextMenu.restore')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
