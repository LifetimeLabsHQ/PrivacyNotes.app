/**
 * The Clip tab: the page card (the page, how many words and pictures a note
 * would keep), with text selected the choice of Whole page or Selection
 * (Selection first), then Save as note and Bookmark side by side, and the
 * remembered Include pictures switch. The button pressed says what it did and
 * stays done; what needs reading (offline, a picture that failed, a page too
 * long or too short) is a callout under it. When the copy holds a bookmark
 * for this page, the card says so, and opens the note the page was clipped into.
 * The page is read and turned into a clip here, once, when the tab opens;
 * the background seals, queues and sends it, so the popup may close at once.
 * Spec: docs/internal/plans/browser-extension-build.md (decision E5, section 3.3); picture mockups/browser-extension-redesign-11nov2026.html
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import type { BookmarkCopyEntry } from '@notes/shared/extension';
import { BookmarkSimple, FileText, Image, NotePencil, Scissors, TextAlignLeft } from '@web/icons';
import { Button } from '@web/ui/Button';
import { Callout, EmptyState, StatusLine } from '@web/ui/feedback';
import { Switch } from '@web/Switch';
import { SETTINGS_HELP, SETTINGS_TRACK, settingsSegClass } from '@web/settingsUI';
import { HoverLabel } from '@web/HoverLabel';
import { countWords } from '@web/wordCountUtils';
import { capturePage, type CapturedPage } from '../../src/capture';
import { buildClip, clippable, type Built, type ClipMode } from '../../src/clipping';
import { readPrefs, writePrefs } from '../../src/prefs';
import { savedOn, type SaveRequest, type SaveResult } from '../../src/save';
import type { Connection } from '../../src/connection';
import { hostOf } from '../../src/favicon';
import { shortcutUrl } from '../../src/logins';
import { SaveButton } from './SaveButton';
import { Tile } from './VaultView';

type Phase =
  | { at: 'reading' }
  | { at: 'cannot' }
  | { at: 'ready'; page: CapturedPage; savedAt: string | null };

type Which = 'note' | 'bookmark';
/** What the last press did: busy, saved (with the result), or refused. */
type Act =
  | { which: Which; state: 'busy' }
  | { which: Which; state: 'done'; result: Extract<SaveResult, { state: 'sent' | 'queued' }> }
  | { which: Which; state: 'refused'; result: SaveResult };

interface Counts {
  words: number;
  pictures: number;
}

/** What a clip would keep: its words and pictures. */
function countsOf(built: Built | undefined): Counts | null {
  if (!built || built.kind === 'tooLong') return null;
  const clip = built.kind === 'clip' ? built.clip : built.page;
  return clip ? { words: countWords(clip.markdown), pictures: clip.images.length } : null;
}

export function ClipView({ connection, bookmark, bookmarkKeys, noteKeys }: { connection: Connection; bookmark: BookmarkCopyEntry | null; bookmarkKeys?: string; noteKeys?: string }) {
  const { t } = useTranslation('extension');
  const [phase, setPhase] = useState<Phase>({ at: 'reading' });
  const [pictures, setPictures] = useState(true);
  const [mode, setMode] = useState<ClipMode>('note');
  // Very little main text: Save as note becomes Save anyway, and a callout says why.
  const [short, setShort] = useState(false);
  const [act, setAct] = useState<Act | null>(null);
  // The clip of each mode, built once: the counts read it, and Save sends it.
  const built = useRef(new Map<ClipMode, Built>());
  const [counts, setCounts] = useState<Partial<Record<ClipMode, Counts | null>>>({});

  useEffect(() => {
    void readPrefs().then((p) => setPictures(p.pictures));
    void (async () => {
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !clippable(tab.url)) return setPhase({ at: 'cannot' });
      try {
        const [res] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: capturePage });
        const page = res?.result as CapturedPage | undefined;
        if (!page) return setPhase({ at: 'cannot' });
        if (page.selectionHtml) setMode('selection');
        setPhase({ at: 'ready', page, savedAt: await savedOn(page.url) });
      } catch {
        setPhase({ at: 'cannot' });
      }
    })();
  }, []);

  // The counts come after the card has painted: the whole-page clip is the
  // slow part, and the Save that follows uses it instead of building again.
  const page = phase.at === 'ready' ? phase.page : null;
  useEffect(() => {
    if (!page) return;
    const timer = window.setTimeout(() => {
      const modes: ClipMode[] = page.selectionHtml ? ['selection', 'note'] : ['note'];
      for (const m of modes) {
        const b = buildClip(page, m);
        built.current.set(m, b);
        setCounts((c) => ({ ...c, [m]: countsOf(b) }));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [page]);

  const send = async (which: Which, request: SaveRequest, tooLong = false) => {
    setAct({ which, state: 'busy' });
    const result = ((await browser.runtime.sendMessage({ type: 'save', request })) as SaveResult | null) ?? { state: 'failed' as const };
    if (result.state === 'sent' || result.state === 'queued') {
      const long = tooLong || result.tooLong === true;
      // A page too long for one note was saved as its bookmark instead.
      setAct({ which: long ? 'bookmark' : which, state: 'done', result: { ...result, tooLong: long } });
    } else setAct({ which, state: 'refused', result });
  };

  const saveBookmark = (p: CapturedPage, tooLong = false) => send('bookmark', { mode: 'bookmark', url: p.url, title: p.title }, tooLong);

  const note = (p: CapturedPage, anyway: boolean) => {
    const b = !anyway && built.current.get(mode) ? built.current.get(mode)! : buildClip(p, mode, anyway);
    if (b.kind === 'short') return setShort(true);
    if (b.kind === 'tooLong') return void saveBookmark(p, true);
    void send('note', { mode, url: p.url, title: p.title || b.clip.title, clip: b.clip, pictures });
  };

  if (!connection.clips) return <p className={SETTINGS_HELP}>{t('clip.off')}</p>;

  if (phase.at === 'reading') return <StatusLine busy>{t('clip.reading')}</StatusLine>;
  // All the tab has: the page itself is closed to extensions.
  if (phase.at === 'cannot') return <EmptyState icon={<Scissors weight="duotone" />} title={t('clip.cannotClip')}>{t('clip.cannotClipBody')}</EmptyState>;

  const { savedAt } = phase;
  const p = phase.page;
  const saved = act?.state === 'done' ? act : null;
  const stateOf = (which: Which) => (act?.which === which && act.state !== 'refused' ? act.state : 'idle');
  const shown = counts[mode];
  const pictureCount = saved?.which === 'note' && pictures ? (counts[mode]?.pictures ?? 0) - saved.result.failedPictures : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5 min-w-0">
        <Tile url={p.url} letter={p.title || hostOf(p.url)} />
        <div className="min-w-0">
          <div className="text-body font-semibold text-pn line-clamp-2" dir="auto">{p.title || hostOf(p.url)}</div>
          <div className="text-meta text-pn-muted truncate" dir="ltr">{hostOf(p.url)}</div>
          {shown && (
            <div className="pn-fade-in mt-0.5 flex flex-wrap gap-x-3 text-meta text-pn-muted">
              <span className="inline-flex items-center gap-1"><TextAlignLeft aria-hidden="true" />{t('editor:wordCount.words', { count: shown.words, formatted: shown.words.toLocaleString() })}</span>
              {shown.pictures > 0 && <span className="inline-flex items-center gap-1"><Image aria-hidden="true" />{t('importExport:missing.pictures', { count: shown.pictures })}</span>}
            </div>
          )}
        </div>
      </div>
      {bookmark ? (
        <p className={SETTINGS_HELP}>
          {bookmark.note
            ? t('vault.savedAsNote', { date: new Date(bookmark.savedAt).toLocaleDateString() })
            : t('vault.bookmarkedOn', { date: new Date(bookmark.savedAt).toLocaleDateString() })}
        </p>
      ) : savedAt && !saved ? (
        <p className={SETTINGS_HELP}>{t('clip.alreadySaved', { date: new Date(savedAt).toLocaleDateString() })}</p>
      ) : null}
      {p.selectionHtml && !saved && (
        <div role="group" aria-label={t('clip.whatToSave')} className={SETTINGS_TRACK}>
          {(['note', 'selection'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setShort(false); }} className={settingsSegClass(mode === m, true)}>
              {m === 'note' ? t('clip.wholePage') : t('clip.selection')}
              {m === 'selection' && counts.selection && <span className="ms-1.5 font-normal text-pn-muted">{t('editor:wordCount.words', { count: counts.selection.words, formatted: counts.selection.words.toLocaleString() })}</span>}
            </button>
          ))}
        </div>
      )}
      {short && !saved && <Callout look="card" tone="warning" title={t('clip.shortText')}>{t('clip.shortTextBody')}</Callout>}
      <div className="grid grid-cols-[3fr_2fr] gap-2">
        {/* The tooltips name the keys that do the same from any page. */}
        <HoverLabel label={t('menu.savePageNote')} keys={noteKeys} position="below">
          <SaveButton
            state={stateOf('note')}
            variant="primary"
            icon={<FileText aria-hidden="true" />}
            label={short ? t('shell:clipper.saveAnyway') : t('shell:contextMenu.saveAsNote')}
            busyLabel={t('common:state.saving')}
            doneLabel={t('shell:clipper.saved')}
            onClick={() => note(p, short)}
            className="w-full"
          />
        </HoverLabel>
        {bookmark ? (
          <SaveButton state="done" icon={<BookmarkSimple aria-hidden="true" />} label={t('notes:newMenu.bookmark')} busyLabel={t('common:state.saving')} doneLabel={t('vault.bookmarked')} onClick={() => undefined} />
        ) : (
          <HoverLabel label={t('menu.savePageBookmark')} keys={bookmarkKeys} position="below">
            <SaveButton
              state={stateOf('bookmark')}
              icon={<BookmarkSimple aria-hidden="true" />}
              label={t('notes:newMenu.bookmark')}
              busyLabel={t('common:state.saving')}
              doneLabel={t('vault.bookmarked')}
              onClick={() => void saveBookmark(p)}
              className="w-full"
            />
          </HoverLabel>
        )}
      </div>
      {bookmark?.note && (
        <Button icon={<NotePencil aria-hidden="true" />} onClick={() => void browser.tabs.create({ url: shortcutUrl(bookmark.note!) })} className="w-full">
          {t('editor:noteLink.open')}
        </Button>
      )}
      {saved ? (
        <Saved result={saved.result} pictureCount={pictureCount} />
      ) : (
        <Switch
          label={t('clip.includePictures')}
          description={t('clip.includePicturesHelp')}
          checked={pictures}
          onChange={(on) => {
            setPictures(on);
            void writePrefs({ pictures: on });
          }}
        />
      )}
      {act?.state === 'refused' && <Refused result={act.result} />}
    </div>
  );
}

/** Under the done button: what came of the save, and that the popup may close. */
function Saved({ result, pictureCount }: { result: Extract<SaveResult, { state: 'sent' | 'queued' }>; pictureCount: number }) {
  const { t } = useTranslation('extension');
  return (
    <div className="pn-fade-in space-y-2">
      {result.tooLong ? (
        <Callout look="card" title={t('clip.tooLong')}>{t('clip.tooLongBody')}</Callout>
      ) : result.state === 'queued' ? (
        <Callout look="card" title={t('clip.queued')}>{t('clip.queuedBody')}</Callout>
      ) : result.failedPictures > 0 ? (
        <Callout look="card" tone="warning" title={t('clip.picturesFailed', { count: result.failedPictures })}>{t('clip.picturesFailedBody')}</Callout>
      ) : (
        <p className={SETTINGS_HELP}>
          {pictureCount > 0 && `${t('clip.picturesKept', { count: pictureCount })} `}
          {t('clip.savedBody')}
        </p>
      )}
      <p className={SETTINGS_HELP}>{t('clip.closeHint')}</p>
    </div>
  );
}

/** A save that did not go: the buttons are ready again. */
function Refused({ result }: { result: SaveResult }) {
  const { t } = useTranslation('extension');
  if (result.state === 'revoked' || result.state === 'notConnected') {
    return <Callout look="card" tone="warning" title={t('account.revoked')}>{t('account.revokedBody')}</Callout>;
  }
  if (result.state === 'full') return <Callout look="card" tone="danger">{t('clip.queueFull')}</Callout>;
  if (result.state === 'notAllowed') return <p className={SETTINGS_HELP}>{t('clip.off')}</p>;
  return <Callout look="card" tone="danger">{t('clip.failed')}</Callout>;
}
