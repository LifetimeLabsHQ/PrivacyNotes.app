import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalNote } from './db';
import { parseLinkBody, updateLinkBody, normalizeUrl, linkDomain, duplicateBookmarkId } from './linkBody';
import { NotesField } from './NotesField';
import { BOOKMARK_NOTES_OFFERED } from './bookmarkNotesLaunch';
import { SiteChip } from './NoteRow';
import { useCopyToClipboard } from './clipboard';
import { openExternal } from './openExternal';
import { hasPin } from './pin';
import { PinInfoModal } from './PinInfoModal';
import { CaretDown, Info, NotePencil, NEW_GLYPHS } from './icons';
import { isImeComposing } from './imeComposing';
import { Button, SETTINGS_BTN_PRIMARY, SETTINGS_HELP, Spinner } from './ui';
import { formatInstant } from './intlFormat';
import { DEMO_APP_URL } from './demo';
import { withSource } from './campaignSource';
import type { ClipJob, ClipNotice } from './clipMessages';

/** Save as note on a bookmark: the note it was clipped into, the clip that
 *  is running, the last message, and the two actions. */
export interface BookmarkClip {
  note?: LocalNote;
  job?: ClipJob;
  notice?: ClipNotice;
  onSave: () => void;
  onOpenNote: () => void;
}

/**
 * The bookmark column, the vault's `VAULT_COLUMN` one size up: the URL row
 * carries a long value plus the Copy and Open buttons, so it needs more room
 * than the vault's label + value pairs. Wider than 720 and the field trails a
 * lane of empty space to the buttons.
 * Spec: docs/internal/design/ui-patterns.md (the vault column)
 */
const BOOKMARK_COLUMN = 'w-full max-w-[720px]';

/**
 * The bookmark body, seated under the STANDARD note header exactly like
 * VaultItem: the header owns title, pin, share, trash and the options
 * menu (read-only, PIN-protect), the shared tag line owns folder + tags,
 * and this component owns only what a bookmark is - its URL.
 *
 * Edits auto-save through the normal note pipeline (onBodyChange ->
 * useNoteEditing's debounced sync), but ONLY when the value parses as an
 * http(s) URL and no OTHER bookmark already holds it: a half-typed edit
 * shows the red hint, a collision shows the amber one, and neither touches
 * the stored body. The duplicate half is the same guard the quick-add bar
 * runs, against the same account-wide key map - editing a bookmark onto a
 * URL you already have was the one way past it (fixed 2026-08-26).
 * Spec: docs/internal/specs/bookmarks-pillar.md (standard-header rework)
 */
/** Save as note, its spinner and Open the note. */
const CLIP_BUTTON = 'shrink-0 @max-[44rem]:flex-1 @max-[26rem]:basis-full';

export function BookmarkItem({
  note,
  bookmarkKeys,
  isTrash,
  onBodyChange,
  onPinProtectedChange,
  clip,
}: {
  note: LocalNote;
  /** Every saved bookmark URL in the account, keyed by dedupe key -> note id
   *  (buildLinkKeyMap). This note's own entry is excluded by id, so re-saving
   *  its own URL is not a collision. */
  bookmarkKeys: Map<string, string>;
  isTrash: boolean;
  onBodyChange: (id: string, body: string) => void;
  onPinProtectedChange: (id: string, pinProtected: boolean) => void;
  /** Absent in the trash: a trashed bookmark is not clipped. */
  clip?: BookmarkClip;
}) {
  const { t } = useTranslation('shell');
  const { copy, copied } = useCopyToClipboard();
  // Never memoize this. Settings opens over a mounted form, so a PIN
  // can appear or vanish while the toggle below is on screen, and
  // localStorage fires nothing that would refresh a frozen value.
  const pinConfigured = hasPin();
  const [showPinInfo, setShowPinInfo] = useState(false);
  /** The website-icon explainer under the URL field, collapsed by default. */
  const [iconHintOpen, setIconHintOpen] = useState(false);
  const pinProtected = note.pinProtected === 1;
  const { url: savedUrl, notes = '' } = parseLinkBody(note.body);
  const [draft, setDraft] = useState(savedUrl);
  /** Three buttons beside the field instead of two. */
  const wide = !!(clip && savedUrl);
  const [invalid, setInvalid] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [notesDraft, setNotesDraft] = useState(notes);
  // Once shown, the box stays while its text is deleted.
  const [notesShown, setNotesShown] = useState(BOOKMARK_NOTES_OFFERED || notes !== '');
  // The saved body trails what this pane sends: the editing hook buffers a
  // body and writes it later. The pane builds every edit on the newest body
  // it sent, and takes `note.body` only when it is none of its own, else a
  // re-render while a write is in flight puts old notes back in the box.
  const latestBody = useRef(note.body);
  const sentBodies = useRef(new Set([note.body]));
  useEffect(() => {
    if (sentBodies.current.has(note.body)) {
      if (note.body === latestBody.current) sentBodies.current = new Set([note.body]);
      return;
    }
    latestBody.current = note.body;
    sentBodies.current = new Set([note.body]);
    const remote = parseLinkBody(note.body).notes ?? '';
    setNotesDraft(remote);
    if (remote) setNotesShown(true);
  }, [note.body]);

  function send(patch: { url?: string; notes?: string }) {
    const next = updateLinkBody(latestBody.current, patch);
    latestBody.current = next;
    sentBodies.current.add(next);
    onBodyChange(note.id, next);
  }

  // A remote edit or note switch replaces the draft (the component is
  // keyed by note id in NoteEditorPane, so this covers same-id refreshes).
  useEffect(() => {
    setDraft(savedUrl);
    setInvalid(false);
    setDuplicate(false);
  }, [savedUrl]);

  function commit(value: string) {
    const normalized = normalizeUrl(value);
    if (!normalized) {
      setInvalid(value.trim().length > 0);
      return;
    }
    setInvalid(false);
    if (normalized === parseLinkBody(latestBody.current).url) return;
    // The quick-add bar's guard, on the edit path: without it the same trap
    // (two rows, one URL - trash "the copy" and lose the tagged original)
    // was one rename away. The edit is refused, not merged: the two rows may
    // carry different names, tags and folders, and picking a winner for the
    // user is a data decision the field cannot make.
    if (duplicateBookmarkId(bookmarkKeys, normalized, note.id)) {
      setDuplicate(true);
      return;
    }
    setDuplicate(false);
    send({ url: normalized });
  }

  return (
    <div className={`@container flex-1 p-6 ${BOOKMARK_COLUMN}`}>
      {/* The pane holds one field, so the label carries it as a heading
          rather than the form-label 12px it used to wear. Two steps under
          `pn-note-title` above it - H3 to the title's H1 - because at H2 a
          one-field pane read as two titles competing (reported 2026-08-25). */}
      <label className="block text-title lg:text-heading font-semibold tracking-tight text-pn mb-3">
        {t('bookmarks.urlLabel')}
      </label>
      {/* One row while the pane holds it. Under 30rem the field would be
          squeezed to a sliver beside two buttons (a phone left it about
          115px), so the field takes its own line and the buttons share the
          next one. With the third button (Save as note) the field shrinks
          sooner, so that row breaks at 44rem, and the third button takes a
          line of its own only under 26rem. A container query, because the
          pane is a column the user drags and a viewport breakpoint cannot
          see it.
          Spec: docs/internal/design/ui-patterns.md (section 77) */}
      <div className={`flex items-center gap-1.5 ${wide ? '@max-[44rem]:flex-wrap' : '@max-[30rem]:flex-wrap'}`}>
        {/* The website icon sits inside the field, behind a hairline, where a
            browser's address bar carries it: no extra line, and the address
            keeps the width a chip beside the field used to take. It is the
            SAME `SiteChip` the list row draws, so an item looks like itself
            on both sides of a click, and it is fixed-size in every state
            (favicon, loading, globe fallback) - the address can never jump
            when an icon resolves. The domain comes from the SAVED url, so a
            half-typed value fetches nothing; the icon appears when the edit
            commits. */}
        <div className={`flex items-stretch min-w-0 flex-1 rounded-md bg-surface-1 border focus-within:border-accent ${invalid ? 'border-red-500' : duplicate ? 'border-amber-500' : 'border-divider'} ${wide ? '@max-[44rem]:basis-full' : '@max-[30rem]:basis-full'}`}>
          <span className="shrink-0 flex items-center px-1.5 border-e border-divider">
            <SiteChip
              domain={linkDomain(savedUrl)}
              trashTint={isTrash}
              fallback={isTrash ? 'bookmark' : 'globe'}
            />
          </span>
          <input
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setInvalid(false); setDuplicate(false); }}
            onBlur={() => commit(draft)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !isImeComposing(e)) { e.preventDefault(); commit(draft); } }}
            readOnly={isTrash || note.locked === 1}
            dir="ltr"
            enterKeyHint="done"
            className="w-full min-w-0 bg-transparent px-3 py-2 text-body focus:outline-none"
          />
        </div>
        <Button
          action={copied === 'url' ? 'done' : 'copy'}
          variant="secondary"
          onClick={() => copy(savedUrl, 'url')}
          className={`shrink-0 ${wide ? '@max-[44rem]:flex-1' : '@max-[30rem]:flex-1'}${copied === 'url' ? ' [&_svg]:text-success' : ''}`}
        >
          {/* A fixed label keeps clipboard feedback from resizing the URL field. */}
          {t('common:actions.copy')}
        </Button>
        <Button action="open" variant="accent" onClick={() => openExternal(savedUrl)} className={`shrink-0 ${wide ? '@max-[44rem]:flex-1' : '@max-[30rem]:flex-1'}`}>
          {t('shell:contacts.open')}
        </Button>
        {clip && savedUrl && (
          clip.job ? (
            <Button variant="primary" icon={<Spinner size={15} className="text-white" />} disabled className={CLIP_BUTTON}>
              {t('clipper.saving')}
            </Button>
          ) : clip.note ? (
            <Button variant="primary" icon={<NotePencil aria-hidden />} onClick={clip.onOpenNote} className={CLIP_BUTTON}>
              {t('editor:noteLink.open')}
            </Button>
          ) : (
            <Button variant="primary" icon={<NEW_GLYPHS.note aria-hidden />} onClick={clip.onSave} className={CLIP_BUTTON}>
              {t('shell:contextMenu.saveAsNote')}
            </Button>
          )
        )}
      </div>
      {clip?.job && (
        <p className={`mt-1.5 ${SETTINGS_HELP}`} role="status">
          {clip.job.step === 'page' ? t('clipper.stepPage') : t('clipper.stepPictures', { done: clip.job.done, total: clip.job.total })}
        </p>
      )}
      {clip?.note && !clip.job && (
        <p className={`mt-1.5 ${SETTINGS_HELP} text-success`}>
          {t('clipper.savedOn', { date: formatInstant(clip.note.createdAt, 'date') })}
        </p>
      )}
      {clip?.notice && !clip.job && (
        <div className="mt-1.5 space-y-2" role="alert">
          <p className="text-small font-medium text-warning">{clip.notice.text}</p>
          {clip.notice.signUp && (
            <a href={withSource(DEMO_APP_URL)} className={`${SETTINGS_BTN_PRIMARY} inline-flex`}>
              {t('security:demoTeaser.createAccount')}
            </a>
          )}
        </div>
      )}
      {invalid && (
        <div className="mt-1.5 text-small font-medium text-danger">{t('bookmarks.urlInvalid')}</div>
      )}
      {/* Amber, not red: the quick-add bar's colour for the same refusal, so
          "already saved" reads as the same event on both sides of a click. */}
      {duplicate && (
        <div className="mt-1.5 text-small font-medium text-warning">{t('bookmarks.urlDuplicate')}</div>
      )}

      {/* Where the icon beside the field comes from, folded away until asked
          for. The chip fetches a third party's favicon, which is exactly the
          kind of thing a privacy-minded reader wants explained AT the field
          rather than in a modal three clicks away - but it is a paragraph,
          and a paragraph under every bookmark would be noise. The strings are
          the Trust tab's own (`landing:trust.favicons*`), never a second copy
          of them: one wording, two places. */}
      <button
        type="button"
        onClick={() => setIconHintOpen((v) => !v)}
        aria-expanded={iconHintOpen}
        className="mt-3 inline-flex items-center gap-1.5 text-small text-pn-soft transition hover:text-accent"
      >
        <Info className="shrink-0 text-accent" />
        {t('landing:trust.faviconsHeading')}
        <CaretDown className={`shrink-0 transition-transform ${iconHintOpen ? '' : '-rotate-90'}`} aria-hidden="true" />
      </button>
      {/* No prose cap on the paragraph: it runs to the same edge as the field
          row above it, and the pane already caps its own column width. */}
      {iconHintOpen && (
        <p className="mt-1.5 text-small leading-relaxed text-pn">
          {t('landing:trust.faviconsBody1')} {t('landing:trust.faviconsBody2')}
        </p>
      )}

      {/* The vault's Notes box, so bookmarks and vault items share one small
          editor. Held back in release builds until old clients are gone
          (bookmarkNotesLaunch.ts), except where notes already exist. */}
      {notesShown && (
        <div className="mt-6">
          <NotesField
            label={t('common:cardForm.notes')}
            value={notesDraft}
            onChange={(next) => { setNotesDraft(next); send({ notes: next }); }}
            placeholder={t('common:cardForm.notesPlaceholder')}
            disabled={isTrash || note.locked === 1}
          />
        </div>
      )}

      {/* PIN-protect toggle - the vault form's exact block (LoginForm),
          same strings, same info modal, same disabled state without a PIN. */}
      {!isTrash && (
        <>
          <label className={`mt-6 flex items-center gap-2 pt-2 border-t border-divider ${!pinConfigured && !pinProtected ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              checked={pinProtected}
              onChange={(e) => onPinProtectedChange(note.id, e.target.checked)}
              // Read-only locks CONTENT, not protection: toggling the PIN gate
              // changes no data, so it stays available on a locked item.
              disabled={!pinConfigured && !pinProtected}
              className="rounded accent-accent"
            />
            <span className="text-body text-pn-muted">
              {t('common:cardForm.requirePin')}
            </span>
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); setShowPinInfo(true); }}
              className="text-accent/60 hover:text-accent transition p-1 -m-1"
              aria-label={t('common:cardForm.whatDoesThisDo')}
            >
              <Info />
            </button>
          </label>
          {showPinInfo && <PinInfoModal onClose={() => setShowPinInfo(false)} />}
          {!pinConfigured && !pinProtected && (
            <p className="mt-2 ps-6 text-meta text-pn-muted">
              {t('common:cardForm.setUpPinFirst')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
