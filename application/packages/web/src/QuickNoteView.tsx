import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LockSimple } from './icons';
import { Button, Kbd } from './ui';
import { KEY_OS } from './shortcutMatch';
import { isImeComposing } from './imeComposing';
import type { QuickNoteAnswer } from './quickNoteQueue';

/**
 * The Ninja box's note mode (#694 request 2, way C): a title line, the text
 * under it, Save with Ctrl+Enter (Cmd+Enter on a Mac). The title line is
 * read as Ninja's "+" line reads it, in the main window: "/Folder" and
 * "#tag" words go to the folder and the tags. Unlocked, Escape goes back to
 * search; locked, there is no search, so Escape closes the box and Open
 * PrivacyNotes is a button (Enter in the text is a new line). The draft is
 * the caller's, in memory only.
 * Spec: docs/internal/plans/quick-note-694.md (section 5.1); picture mockups/quick-note-694-10nov2026.html (C2 to C4)
 */

export interface QuickNoteDraft {
  title: string;
  markdown: string;
}

/** How long the saved line shows before the box closes. Spec: docs/internal/plans/quick-note-694.md (section 5.1) */
const SAVED_MS = 800;

export function QuickNoteView({ draft, onDraft, locked, onSave, onBack, onSaved, onOpenApp }: {
  draft: QuickNoteDraft;
  onDraft: (next: QuickNoteDraft) => void;
  locked: boolean;
  onSave: (draft: QuickNoteDraft) => Promise<QuickNoteAnswer>;
  /** Escape: back to search, or the box closes while locked. */
  onBack: () => void;
  /** The saved line has shown: the draft is cleared and the box closes. */
  onSaved: () => void;
  onOpenApp: () => void;
}) {
  const { t } = useTranslation(['common', 'settings', 'shell']);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<{ text: string; ok: boolean } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const ready = !busy && (draft.title.trim() !== '' || draft.markdown.trim() !== '');

  // A title from "+" puts the caret in the text; an empty one in the title.
  useEffect(() => {
    const el = draft.title.trim() ? bodyRef.current : titleRef.current;
    el?.focus();
    if (el) el.setSelectionRange(el.value.length, el.value.length);
    // Only when the view opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    setLine(null);
    const answer = await onSave(draft);
    setBusy(false);
    if (answer === 'saved' || answer === 'queued') {
      setLine({ text: t(answer === 'saved' ? 'shell:checkIn.saved' : 'common:quickNote.queued'), ok: true });
      window.setTimeout(onSaved, SAVED_MS);
      return;
    }
    const refusal = answer === 'too_long' ? 'tooLong' : answer === 'full' ? 'full' : answer === 'empty' ? 'empty' : 'failed';
    setLine({ text: t(`common:quickNote.${refusal}`), ok: false });
  };

  const mod = KEY_OS === 'mac' ? '⌘' : 'Ctrl+';
  return (
    <div
      className="flex h-full flex-col bg-surface-2"
      onKeyDown={(e) => {
        if (isImeComposing(e)) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          onBack();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        } else if (e.key === 'Enter' && e.target === titleRef.current) {
          // Enter in the title line goes on to the text, as in a note.
          e.preventDefault();
          bodyRef.current?.focus();
        }
      }}
    >
      {locked && (
        <p className="flex items-center gap-2 border-b border-divider px-4 py-2.5 text-compact text-pn-muted">
          <LockSimple aria-hidden="true" className="shrink-0" />
          <span>{t('common:quickNote.locked')}</span>
        </p>
      )}
      <input
        ref={titleRef}
        value={draft.title}
        onChange={(e) => onDraft({ ...draft, title: e.target.value })}
        placeholder={t('shell:listPrefs.title')}
        aria-label={t('shell:listPrefs.title')}
        maxLength={400}
        dir="auto"
        className="w-full bg-transparent px-4 pt-4 pb-1 text-heading font-semibold text-pn outline-none placeholder:text-pn-soft"
      />
      <textarea
        ref={bodyRef}
        value={draft.markdown}
        onChange={(e) => onDraft({ ...draft, markdown: e.target.value })}
        placeholder={t('common:quickNote.bodyPlaceholder')}
        aria-label={t('common:quickNote.bodyPlaceholder')}
        dir="auto"
        className="min-h-0 w-full flex-1 resize-none bg-transparent px-4 py-2 text-body text-pn outline-none placeholder:text-pn-soft"
      />
      <div className="flex flex-nowrap items-center gap-x-2.5 border-t border-divider px-3.5 py-2 text-small text-pn-muted">
        {line ? (
          <span role="status" className={`min-w-0 truncate ${line.ok ? 'text-success' : 'text-danger'}`}>{line.text}</span>
        ) : locked ? (
          <Button action="open" onClick={onOpenApp}>{t('settings:appearance.trayOpen')}</Button>
        ) : (
          <span className="min-w-0 truncate">{t('common:quickNote.hint')}</span>
        )}
        <span className="flex-1" />
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <Kbd>Esc</Kbd>
          {locked ? t('common:quickSwitcher.close') : t('common:quickSwitcher.back')}
        </span>
        <Button action="save" variant="primary" disabled={!ready} onClick={() => void save()} title={`${mod}↵`} />
      </div>
    </div>
  );
}
