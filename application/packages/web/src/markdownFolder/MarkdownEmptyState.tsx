/**
 * Entry state for the Markdown pane when no folder or file is open.
 *
 * Covers Brave's disabled File System Access flag, desktop browsers without the
 * File System Access API (pointing to the desktop app), and supported platforms
 * (with an optional remembered-folder reopen card ahead of the folder and file
 * pickers).
 *
 * Spec: docs/internal/specs/markdown-folder.md (sections 5 and 12)
 */
import { useTranslation } from 'react-i18next';
import { Download, SlidersHorizontal, FileText, FolderOpen } from '../icons';
import { Button, SETTINGS_BTN_PRIMARY, TerminalBlock } from '../ui';
import { marketingHomeHref } from '../siteLinks';
import { detectPlatform } from '../devices';
import { MarkdownPitch } from './MarkdownExplainer';
import { BRAVE_FLAG_NAME, BRAVE_FLAG_URL, type markdownSupport } from './capability';

export function MarkdownEmptyState({
  support,
  error,
  busy,
  reopenName,
  onReopen,
  onOpenFile,
  onOpenFolder,
}: {
  support: ReturnType<typeof markdownSupport>;
  error: string | null;
  busy: boolean;
  /** Set when a folder is remembered without active browser permission or desktop fs scope. */
  reopenName: string | null;
  onReopen: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
}) {
  const { t } = useTranslation('shell');

  // Brave ships the File System Access API behind a flag; surface the flag URL
  // to copy and keep the desktop app download as a secondary link.
  if (support === 'needs-brave-flag') {
    return (
      <div className="h-full overflow-y-auto flex flex-col px-6 py-10">
        {/* rtl-ok: every string in this card stays in English across locales, so the card is an LTR island to keep English punctuation in order. */}
        <div
          dir="ltr"
          className="w-full max-w-sm mx-auto my-auto rounded-xl border border-divider bg-surface-2 p-6 shadow-sm flex flex-col items-center text-center gap-3"
        >
          <SlidersHorizontal size={26} weight="duotone" className="text-pn-muted" />
          {/* Every string in this card stays in English via tools/lint-locales.mjs
              verbatim rules to match Chromium's untranslated `brave://flags` UI. */}
          <p className="text-row font-semibold">
            {t('markdown.braveTitle', { flag: BRAVE_FLAG_NAME })}
          </p>
          {/* Copyable block rather than a link because Chromium blocks page-initiated
              navigation to `brave://` URLs. */}
          <div className="w-full text-start">
            <TerminalBlock value={BRAVE_FLAG_URL} copyLabel={t('markdown.braveCopy')} />
          </div>
          {/* Compact body copy matching the sibling empty state; the desktop app
              link stays secondary via muted color and underline rather than smaller text. */}
          <p className="text-compact text-pn-muted leading-relaxed">
            {t('markdown.braveSteps', { flag: BRAVE_FLAG_NAME })}
          </p>
          <a
            href={`${marketingHomeHref()}#downloads`}
            target="_blank"
            rel="noreferrer"
            className="text-compact text-pn-muted underline underline-offset-2 hover:text-pn transition mt-1"
          >
            {t('markdown.braveAppAlternative')}
          </a>
        </div>
      </div>
    );
  }

  if (support === 'needs-desktop-app') {
    return (
      <div className="h-full overflow-y-auto flex flex-col px-6 py-10">
        <div className="w-full max-w-sm mx-auto my-auto rounded-xl border border-divider bg-surface-2 p-6 shadow-sm flex flex-col items-center text-center gap-3">
          <Download size={26} weight="duotone" className="text-pn-muted" />
          <p className="text-row font-semibold">{t('markdown.needsAppTitle')}</p>
          {/* Split at the sentence boundary so the two lines stay readable in a
              wide desktop pane and translate cleanly. */}
          <p className="text-compact text-pn-muted leading-relaxed">
            {t('markdown.needsAppBody')}
            <br />
            {t('markdown.needsAppWhere')}
          </p>
          {/* Uses `marketingHomeHref()` so the link carries the active locale slug
              rather than hitting the bare apex (which boots the app when signed in). */}
          <a
            href={`${marketingHomeHref()}#downloads`}
            target="_blank"
            rel="noreferrer"
            className={`${SETTINGS_BTN_PRIMARY} mt-1`}
          >
            <Download aria-hidden="true" className="shrink-0" />
            {t('markdown.getDesktopApp')}
          </a>
        </div>
      </div>
    );
  }

  // Reuses `MarkdownPitch` directly above the folder and file pickers so the
  // pitch copy has a single home.
  return (
    // `my-auto` centers the card when it fits the viewport and collapses to zero
    // on overflow so the top edge remains scrollable in short windows.
    <div className="h-full overflow-y-auto flex flex-col px-6 py-10">
      <div className="w-full max-w-lg mx-auto my-auto rounded-xl border border-divider bg-surface-2 p-6 shadow-sm">
        <MarkdownPitch />
        {reopenName && (
          <div className="rounded-lg border border-divider bg-surface-2 p-3 mt-4">
            <p className="text-compact text-pn-soft mb-2">
              {t(detectPlatform() === 'desktop' ? 'markdown.reopenPromptDesktop' : 'markdown.reopenPrompt', { name: reopenName })}
            </p>
            <Button
              variant="primary"
              icon={<FolderOpen aria-hidden="true" className="shrink-0" />}
              onClick={onReopen}
            >
              {t('markdown.reopenFolder', { name: reopenName })}
            </Button>
          </div>
        )}
        {/* Equal-width columns present folder and single-file opening as peer choices. */}
        <div className="grid grid-cols-2 gap-2 mt-4">
          <Button
            variant="primary"
            icon={<FolderOpen aria-hidden="true" className="shrink-0" />}
            onClick={onOpenFolder}
            className="w-full justify-center"
          >
            {busy ? t('markdown.scanning') : t('markdown.openFolder')}
          </Button>
          <Button
            icon={<FileText aria-hidden="true" className="shrink-0" />}
            onClick={onOpenFile}
            className="w-full justify-center"
          >
            {t('markdown.openFile')}
          </Button>
        </div>
        {error && <p className="text-small text-danger mt-2 text-center">{error}</p>}
      </div>
    </div>
  );
}
