/**
 * New note: a title (optional; the first line stands in), the text in
 * Markdown, and tags. Save, or Ctrl+Enter (Cmd+Enter on a Mac), seals it into
 * the inbox like a clip, and the app adds it to Notes at its next sync. The
 * draft is kept in session storage at every change, because a toolbar popup
 * closes at a click outside it; a save or Cancel clears it. Save says Saved
 * for a moment, then the footer says where the note went (pattern 177).
 * Spec: docs/internal/specs/quick-note-694.md (section 4.1); picture mockups/quick-note-694-10nov2026.html (B2)
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import { splitTagText } from '@notes/shared/extension';
import { FloppyDisk, Note, NotePencil } from '@web/icons';
import { Button } from '@web/ui/Button';
import { Callout } from '@web/ui/feedback';
import { HoverLabel } from '@web/HoverLabel';
import { bindingKeyText } from '@web/shortcutMatch';
import { FIELD_CLASS, FieldLabel } from '@web/formFields';
import { mergeTags } from '../../src/organize';
import type { NoteResult } from '../../src/save';
import type { OrganizeContext } from './ClipView';
import type { Notice } from './Footer';
import { OrganizeFields } from './OrganizeFields';
import { DONE_HOLD_MS, SaveButton } from './SaveButton';
import { SheetHeader } from './Sheet';

const DRAFT_KEY = 'noteDraft';

interface Draft {
  title: string;
  markdown: string;
  tags: string[];
  tagDraft: string;
  folderId: string | null;
}

const EMPTY: Draft = { title: '', markdown: '', tags: [], tagDraft: '', folderId: null };

function normalizeDraft(raw: unknown): Draft {
  if (!raw || typeof raw !== 'object') return EMPTY;
  const d = raw as Record<string, unknown>;
  const tags = Array.isArray(d.tags)
    ? d.tags.filter((x): x is string => typeof x === 'string')
    : typeof d.tags === 'string'
      ? splitTagText(d.tags)
      : [];
  return {
    title: typeof d.title === 'string' ? d.title : '',
    markdown: typeof d.markdown === 'string' ? d.markdown : '',
    tags,
    tagDraft: typeof d.tagDraft === 'string' ? d.tagDraft : '',
    folderId: typeof d.folderId === 'string' && d.folderId ? d.folderId : null,
  };
}

export function NoteView({ start, organize, onDone }: {
  /** Text to start from: a selection with its page, from the right-click menu. */
  start?: string;
  organize: OrganizeContext;
  /** Back to the popup, with the footer message of a save. */
  onDone: (notice: Notice | null) => void;
}) {
  const { t } = useTranslation('extension');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void browser.storage.session.get(DRAFT_KEY).then((got) => {
      const kept = normalizeDraft(got[DRAFT_KEY]);
      // A selection goes under what the draft holds, never over it.
      const markdown = start ? (kept.markdown.trim() ? `${kept.markdown.trimEnd()}\n\n${start}` : start) : kept.markdown;
      setDraft({ ...kept, markdown });
    });
  }, [start]);

  useEffect(() => {
    if (draft) void browser.storage.session.set({ [DRAFT_KEY]: draft });
  }, [draft]);

  // Clear any remembered folder id from the draft once vault hydration confirms it is locked or non-Pro.
  const hydrated = organize.hydrated ?? true;
  useEffect(() => {
    if (hydrated && (!organize.canFolder || !organize.unlocked || !organize.pro) && draft?.folderId) {
      setDraft((d) => (d ? { ...d, folderId: null } : d));
    }
  }, [hydrated, organize.canFolder, organize.unlocked, organize.pro, draft?.folderId]);

  // The text area takes the focus once the draft is in, with the caret at its end.
  const focused = useRef(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (!draft || !el || focused.current) return;
    focused.current = true;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [draft]);

  if (!draft) return null;
  const set = (patch: Partial<Draft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const ready = !busy && !done && draft.markdown.trim() !== '';

  const save = async () => {
    setBusy(true);
    setError(null);
    const folder = organize.canFolder && organize.unlocked && organize.pro && draft.folderId && organize.folders.some((f) => f.id === draft.folderId)
      ? draft.folderId
      : undefined;
    const request = {
      title: draft.title,
      markdown: draft.markdown,
      tags: mergeTags(draft.tags, draft.tagDraft),
      ...(folder ? { folder } : {}),
    };
    const result = (await browser.runtime.sendMessage({ type: 'saveNote', request })) as NoteResult | null;
    setBusy(false);
    if (result?.state === 'sent' || result?.state === 'queued') {
      await browser.storage.session.remove(DRAFT_KEY);
      // Save says Saved for a moment, then the sheet closes and the footer says where it went.
      setDone(true);
      const sent = result.state === 'sent';
      window.setTimeout(() => onDone(sent
        ? { title: t('notice.noteSaved'), detail: t('notice.notesNextSync') }
        : { tone: 'info', title: t('notice.savedHere'), detail: t('notice.goesOutOnline') }), DONE_HOLD_MS);
      return;
    }
    setError(result?.state === 'tooLong' ? t('common:quickNote.tooLong') : result?.state === 'full' ? t('clip.queueFull') : t('note.failed'));
  };

  return (
    <form
      className="space-y-4 p-3 pt-0 [&>header]:-mx-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (ready) void save();
        }
      }}
    >
      <SheetHeader title={t('notes:header.newNote')} onBack={() => onDone(null)} />
      <div>
        <FieldLabel icon={<Note />} htmlFor="pn-note-title">{t('shell:listPrefs.title')}</FieldLabel>
        <input id="pn-note-title" value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder={t('notes:editor.titlePlaceholder')} maxLength={200} className={`${FIELD_CLASS} !bg-surface-2 shadow-xs`} dir="auto" />
      </div>
      <div>
        <FieldLabel icon={<NotePencil />} htmlFor="pn-note-body">{t('notes:newMenu.note')}</FieldLabel>
        <textarea
          id="pn-note-body"
          ref={bodyRef}
          value={draft.markdown}
          onChange={(e) => set({ markdown: e.target.value })}
          rows={6}
          className={`${FIELD_CLASS} !bg-surface-2 shadow-xs resize-y`}
          dir="auto"
        />
      </div>
      <OrganizeFields
        {...organize}
        folderId={draft.folderId}
        onFolderChange={(folderId) => set({ folderId })}
        tags={draft.tags}
        onTagsChange={(tags) => set({ tags })}
        tagDraft={draft.tagDraft}
        onTagDraftChange={(tagDraft) => set({ tagDraft })}
      />
      {error && <Callout look="card" tone="danger">{error}</Callout>}
      <div className="grid grid-cols-2 gap-2">
        {/* Cancel drops the draft; the back arrow and Escape keep it. */}
        <Button action="cancel" onClick={() => void browser.storage.session.remove(DRAFT_KEY).then(() => onDone(null))} disabled={busy || done} className="bg-surface-2 shadow-xs" />
        <HoverLabel label={t('common:actions.save')} keys={bindingKeyText({ mod: true, key: 'Enter' })} position="above">
          <SaveButton
            type="submit"
            variant="primary"
            state={done ? 'done' : busy ? 'busy' : 'idle'}
            disabled={!ready}
            icon={<FloppyDisk aria-hidden="true" />}
            label={t('common:actions.save')}
            busyLabel={t('common:state.saving')}
            doneLabel={t('shell:checkIn.saved')}
            className="w-full"
          />
        </HoverLabel>
      </div>
    </form>
  );
}
