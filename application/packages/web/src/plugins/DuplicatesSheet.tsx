import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from '../icons';
import type { LocalNote } from '../db';
import { folderNamePath, type FolderDef } from '../folders';
import { activeLocale } from '../i18n';
import { formatInstant } from '../intlFormat';
import { editedAtOf } from '../notesViewUtils';
import { countWords } from '../wordCountUtils';
import { hiddenPairs } from '../dismissedSuggestions';
import { suggestionPairKey } from '../relatedLoader';
import { Button, EmptyState, PluginSheet, StatusLine } from '../ui';

/**
 * Find duplicate notes: pairs of notes that say almost the same thing, best
 * first. Journal entries do not take part (D21). "Not duplicates" uses the
 * "Not related" store of Suggested connections, so the pair also leaves the
 * suggestions; after each action the list scans again, so the next pairs
 * move up. A long note is judged by its start, so each side shows its length.
 * Spec: docs/internal/plans/plugins.md (section 6.1)
 */
export function DuplicatesSheet({ notes, folders, dismissed, onNotDuplicates, onOpenBoth, onClose }: {
  notes: readonly LocalNote[];
  folders: readonly FolderDef[];
  dismissed: readonly string[];
  onNotDuplicates: (a: string, b: string) => void;
  onOpenBoth: (a: string, b: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const [pairs, setPairs] = useState<{ a: string; b: string }[] | null>(null);
  const byId = new Map(notes.map((n) => [n.id, n]));

  useEffect(() => {
    const stop = new AbortController();
    setPairs(null);
    const hidden = hiddenPairs(dismissed);
    const take = (id: string) => {
      const n = byId.get(id);
      return !!n && n.type !== 'journal';
    };
    void import('../onDeviceAiModel')
      .then((m) => m.findDuplicates(take, (a, b) => hidden.has(suggestionPairKey(a, b)), stop.signal))
      .then((found) => !stop.signal.aborted && setPairs(found));
    return () => stop.abort();
    // Scans again when a pair is marked or a note changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed, notes]);

  const date = (n: LocalNote) => formatInstant(editedAtOf(n), 'row');
  const facts = (n: LocalNote) => {
    const words = countWords(n.body);
    const parts = [n.folderId ? folderNamePath([...folders], n.folderId).join(' / ') : null, date(n), t('editor:wordCount.words', { count: words, formatted: words.toLocaleString(activeLocale()) })];
    return parts.filter(Boolean).join(' · ');
  };

  return (
    <PluginSheet
      title={t('plugins.smart.duplicates')}
      icon={<Copy />}
      onClose={onClose}
      maxWidth="max-w-xl"
      footer={pairs === null ? <Button action="cancel" onClick={onClose} /> : <Button action="done" onClick={onClose} />}
    >
      {pairs === null ? (
        <StatusLine busy>{t('plugins.smart.reading')}</StatusLine>
      ) : pairs.length === 0 ? (
        <EmptyState icon={<Copy />} title={t('plugins.smart.noDuplicates')} />
      ) : (
        <ul className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          {pairs.map(({ a, b }) => {
            const na = byId.get(a);
            const nb = byId.get(b);
            if (!na || !nb) return null;
            return (
              <li key={`${a}|${b}`} className="rounded-lg border border-divider p-3 flex flex-col gap-2">
                {[na, nb].map((n) => (
                  <div key={n.id} className="min-w-0">
                    <p className="text-body font-medium text-pn truncate" dir="auto">{n.title || t('common:state.untitled')}</p>
                    <p className="text-small text-pn-muted">{facts(n)}</p>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button action="open" variant="secondary" onClick={() => onOpenBoth(a, b)}>{t('plugins.smart.openBoth')}</Button>
                  <Button action="hide" variant="secondary" onClick={() => onNotDuplicates(a, b)}>{t('plugins.smart.notDuplicates')}</Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </PluginSheet>
  );
}
