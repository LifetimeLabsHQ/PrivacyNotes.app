/**
 * The page card: the page, then Note and Bookmark side by side, Selection
 * full width under them when text is selected (then the primary), and the
 * remembered Include pictures switch. When the copy holds a bookmark for
 * this page, the card says so, and opens the note the page was clipped into.
 * The page is read and turned into a clip here; the background seals, queues
 * and sends it, so the popup may close at once.
 * Spec: docs/internal/plans/browser-extension-build.md (decision E5, section 3.3)
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import type { BookmarkCopyEntry } from '@notes/shared/extension';
import { BookmarkSimple, Check, NotePencil, TextAa } from '@web/icons';
import { Button } from '@web/ui/Button';
import { Callout, Spinner, StatusLine } from '@web/ui/feedback';
import { Switch } from '@web/Switch';
import { SETTINGS_HELP } from '@web/settingsUI';
import { HoverLabel } from '@web/HoverLabel';
import { capturePage, type CapturedPage } from '../../src/capture';
import { buildClip, clippable, type ClipMode } from '../../src/clipping';
import { readPrefs, writePrefs } from '../../src/prefs';
import { savedOn, type SaveRequest, type SaveResult } from '../../src/save';
import type { Connection } from '../../src/connection';
import { faviconOf, hostOf } from '../../src/favicon';
import { shortcutUrl } from '../../src/logins';

type Phase =
  | { at: 'reading' }
  | { at: 'cannot' }
  | { at: 'ready'; page: CapturedPage; savedAt: string | null }
  | { at: 'short'; page: CapturedPage }
  | { at: 'saving' }
  | { at: 'done'; result: SaveResult; tooLong?: boolean };

export function ClipView({ connection, bookmark, bookmarkKeys }: { connection: Connection; bookmark: BookmarkCopyEntry | null; bookmarkKeys?: string }) {
  const { t } = useTranslation('extension');
  const [phase, setPhase] = useState<Phase>({ at: 'reading' });
  const [pictures, setPictures] = useState(true);

  useEffect(() => {
    void readPrefs().then((p) => setPictures(p.pictures));
    void (async () => {
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !clippable(tab.url)) return setPhase({ at: 'cannot' });
      try {
        const [res] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: capturePage });
        const page = res?.result as CapturedPage | undefined;
        if (!page) return setPhase({ at: 'cannot' });
        setPhase({ at: 'ready', page, savedAt: await savedOn(page.url) });
      } catch {
        setPhase({ at: 'cannot' });
      }
    })();
  }, []);

  const send = async (request: SaveRequest, tooLong = false) => {
    setPhase({ at: 'saving' });
    const result = (await browser.runtime.sendMessage({ type: 'save', request })) as SaveResult | null;
    const done = result ?? { state: 'failed' as const };
    setPhase({ at: 'done', result: done, tooLong: tooLong || ('tooLong' in done && done.tooLong === true) });
  };

  const saveBookmark = (page: CapturedPage, tooLong = false) => send({ mode: 'bookmark', url: page.url, title: page.title }, tooLong);

  const note = (page: CapturedPage, mode: ClipMode, anyway = false) => {
    const built = buildClip(page, mode, anyway);
    if (built.kind === 'short') return setPhase({ at: 'short', page });
    if (built.kind === 'tooLong') return void saveBookmark(page, true);
    void send({ mode, url: page.url, title: page.title || built.clip.title, clip: built.clip, pictures });
  };

  if (!connection.clips) return <p className={SETTINGS_HELP}>{t('clip.off')}</p>;

  switch (phase.at) {
    case 'reading':
      return <StatusLine busy>{t('clip.reading')}</StatusLine>;
    case 'cannot':
      return <Callout title={t('clip.cannotClip')}>{t('clip.cannotClipBody')}</Callout>;
    case 'saving':
      return (
        <div className="flex justify-center py-4">
          <Spinner label={t('clip.saving')} />
        </div>
      );
    case 'short':
      return (
        <div className="space-y-3">
          <Callout tone="warning" title={t('clip.shortText')}>{t('clip.shortTextBody')}</Callout>
          <div className="grid grid-cols-2 gap-2">
            <Button icon={<BookmarkSimple aria-hidden="true" />} onClick={() => void saveBookmark(phase.page)}>{t('shell:bookmarks.saveAsBookmark')}</Button>
            <Button variant="primary" icon={<NotePencil aria-hidden="true" />} onClick={() => note(phase.page, 'note', true)}>{t('shell:clipper.saveAnyway')}</Button>
          </div>
        </div>
      );
    case 'done':
      return <Result result={phase.result} tooLong={phase.tooLong} />;
    case 'ready': {
      const { page, savedAt } = phase;
      return (
        <div className="space-y-3">
          <div className="flex items-start gap-2 min-w-0">
            {faviconOf(page.url) && <img src={faviconOf(page.url)!} alt="" className="w-5 h-5 mt-0.5 shrink-0" />}
            <div className="min-w-0">
              <div className="text-body font-semibold text-pn line-clamp-2" dir="auto">{page.title || hostOf(page.url)}</div>
              <div className="text-meta text-pn-muted truncate" dir="ltr">{hostOf(page.url)}</div>
            </div>
          </div>
          {bookmark ? (
            <p className={SETTINGS_HELP}>
              {bookmark.note
                ? t('vault.savedAsNote', { date: new Date(bookmark.savedAt).toLocaleDateString() })
                : t('vault.bookmarkedOn', { date: new Date(bookmark.savedAt).toLocaleDateString() })}
            </p>
          ) : savedAt ? (
            <p className={SETTINGS_HELP}>{t('clip.alreadySaved', { date: new Date(savedAt).toLocaleDateString() })}</p>
          ) : null}
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Button variant={page.selectionHtml ? 'secondary' : 'primary'} icon={<NotePencil aria-hidden="true" />} onClick={() => note(page, 'note')}>
                {t('notes:newMenu.note')}
              </Button>
              {bookmark ? (
                <Button icon={<Check aria-hidden="true" />} disabled className="[&_svg]:text-success">
                  {t('vault.bookmarked')}
                </Button>
              ) : (
                // The tooltip names the key that does the same from any page.
                <HoverLabel label={t('menu.savePageBookmark')} keys={bookmarkKeys} position="below">
                  <Button icon={<BookmarkSimple aria-hidden="true" />} onClick={() => void saveBookmark(page)} className="w-full">
                    {t('notes:newMenu.bookmark')}
                  </Button>
                </HoverLabel>
              )}
            </div>
            {bookmark?.note && (
              <Button icon={<NotePencil aria-hidden="true" />} onClick={() => void browser.tabs.create({ url: shortcutUrl(bookmark.note!) })} className="w-full">
                {t('editor:noteLink.open')}
              </Button>
            )}
            {page.selectionHtml && (
              <Button variant="primary" icon={<TextAa aria-hidden="true" />} onClick={() => note(page, 'selection')} className="w-full">
                {t('clip.selection')}
              </Button>
            )}
          </div>
          <Switch
            label={t('clip.includePictures')}
            checked={pictures}
            onChange={(on) => {
              setPictures(on);
              void writePrefs({ pictures: on });
            }}
          />
        </div>
      );
    }
  }
}

function Result({ result, tooLong }: { result: SaveResult; tooLong?: boolean }) {
  const { t } = useTranslation('extension');
  if (result.state === 'sent' || result.state === 'queued') {
    return (
      <div className="space-y-2">
        {tooLong ? (
          <Callout title={t('clip.tooLong')}>{t('clip.tooLongBody')}</Callout>
        ) : result.state === 'queued' ? (
          <Callout title={t('clip.queued')}>{t('clip.queuedBody')}</Callout>
        ) : result.failedPictures > 0 ? (
          <Callout tone="warning" title={t('clip.picturesFailed', { count: result.failedPictures })}>{t('clip.picturesFailedBody')}</Callout>
        ) : (
          <Callout tone="success" title={t('shell:checkIn.saved')}>{t('clip.savedBody')}</Callout>
        )}
        <p className={SETTINGS_HELP}>{t('clip.closeHint')}</p>
      </div>
    );
  }
  if (result.state === 'revoked' || result.state === 'notConnected') {
    return <Callout tone="warning" title={t('account.revoked')}>{t('account.revokedBody')}</Callout>;
  }
  if (result.state === 'full') return <Callout tone="danger">{t('clip.queueFull')}</Callout>;
  if (result.state === 'notAllowed') return <p className={SETTINGS_HELP}>{t('clip.off')}</p>;
  return <Callout tone="danger">{t('clip.failed')}</Callout>;
}
