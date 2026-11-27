/**
 * The "open .md files with PrivacyNotes" control, in its four homes.
 *
 * One status, four frames sized for each surface:
 *
 *   - `MarkdownDefaultAppPopover` - anchored to the folder toolbar's Markdown
 *     button, including in grid mode where the resting file pane is hidden.
 *   - `MarkdownDefaultAppCard` - centered in the resting file pane when a
 *     folder is open and no file is selected.
 *   - `MarkdownDefaultAppRow` - footer row of `MarkdownPitch` in both the
 *     explainer modal and the no-folder empty state.
 *   - `DefaultAppSettingsRow` - row in Settings > Editor (also serving `.txt`).
 *
 * Every frame renders nothing outside the desktop app. The first three also
 * wait for the initial status read so the control never flashes an offer when
 * PrivacyNotes already owns the association; the settings row renders a
 * checking state immediately so settings search has a stable scroll target.
 *
 * Rendered as a button rather than a toggle because desktop OSes provide no API
 * to relinquish default-handler ownership (`defaultApp.ts`).
 *
 * Spec: docs/internal/specs/markdown-folder.md (section 11)
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowSquareOut, CheckCircle, FileMd, FileText } from '../icons';
import { Button, Popover, RowTitle, SETTINGS_HELP, SETTINGS_ROW, StatusLine } from '../ui';
import {
  claimDefaultApp,
  markDefaultAppOurs,
  openOsDefaultAppSettings,
  useDefaultApp,
  watchClaim,
  type AssocKind,
  type MarkdownAssoc,
} from './defaultApp';

/** File manager named in the hint, keyed off the native platform rather than
 *  user agent. Separate keys keep "Finder" untranslated while translating the
 *  generic Linux phrase. */
const HINT_KEY: Record<MarkdownAssoc['platform'], string> = {
  macos: 'markdown.assocHintFinder',
  windows: 'markdown.assocHintExplorer',
  linux: 'markdown.assocHintFileManager',
};

/**
 * Shared state and action for claiming or opening OS default-app settings.
 *
 * Keyed on `settable` rather than the platform name so native capability
 * changes stay encapsulated in `defaultApp.ts`.
 */
function useDefaultAppAction(kind: AssocKind = 'markdown') {
  const assoc = useDefaultApp(kind);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // Clear any prior error when ownership changes externally (e.g. via System Settings)
  // so a stale failure line cannot linger under a confirmed ownership state.
  useEffect(() => { setFailed(false); }, [assoc?.owner]);

  async function run() {
    if (!assoc || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      if (assoc.settable) {
        await claimDefaultApp(kind);
        // Linux writes the association synchronously; macOS shows a system
        // confirmation dialog and updates asynchronously via `watchClaim`.
        if (assoc.platform === 'linux') markDefaultAppOurs(kind);
        else void watchClaim(kind);
      } else {
        // Windows opens system settings; the window focus listener refreshes status on return.
        await openOsDefaultAppSettings();
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return { assoc, busy, failed, run };
}

/** Current handler description for Markdown files, or null when unknown.
 *  Windows adds the manual-settings note. */
function useOwnerLine(assoc: MarkdownAssoc): string | null {
  const { t } = useTranslation('shell');
  const parts: string[] = [];
  if (assoc.owner === 'other') {
    parts.push(
      assoc.otherName
        ? t('markdown.assocOwnerOther', { app: assoc.otherName })
        : t('markdown.assocOwnerOtherUnnamed'),
    );
  } else if (assoc.owner === 'none') {
    parts.push(t('markdown.assocOwnerNone'));
  }
  // 'unknown' omits ownership claims when the OS reports no handler state.
  if (!assoc.settable) parts.push(t('markdown.assocWindowsManual'));
  return parts.length ? parts.join(' ') : null;
}

/**
 * Action button for claiming the file association or opening OS settings.
 * External settings navigation carries a trailing `ArrowSquareOut` glyph.
 */
function ActionButton({
  assoc,
  busy,
  onClick,
  emphasis,
}: {
  assoc: MarkdownAssoc;
  busy: boolean;
  onClick: () => void;
  /** `solid` for the resting card where this is the primary action on an empty
   *  pane; `quiet` inside the popover and pitch footer. */
  emphasis: 'solid' | 'quiet';
}) {
  const { t } = useTranslation('shell');
  return (
    <Button
      variant={emphasis === 'solid' ? 'primary' : 'secondary'}
      icon={
        assoc.settable
          ? <CheckCircle aria-hidden="true" className="shrink-0" />
          : <ArrowSquareOut aria-hidden="true" className="shrink-0" />
      }
      iconEnd={!assoc.settable}
      onClick={onClick}
      disabled={busy}
    >
      {/* Show an explicit working label while LaunchServices processes the claim,
          which can take several seconds when stale bundle registrations exist. */}
      {busy
        ? t('markdown.assocWorking')
        : assoc.settable
          ? t('markdown.assocMakeDefault')
          : t('markdown.assocWindowsOpen')}
    </Button>
  );
}

/**
 * Shared body across the card, pitch row, and toolbar popover.
 *
 * When PrivacyNotes owns the association, the ownership confirmation leads and
 * the double-click hint follows beneath it.
 */
function DefaultAppBody({
  assoc,
  busy,
  failed,
  onAction,
  emphasis,
}: {
  assoc: MarkdownAssoc;
  busy: boolean;
  failed: boolean;
  onAction: () => void;
  emphasis: 'solid' | 'quiet';
}) {
  const { t } = useTranslation('shell');
  const hint = t(HINT_KEY[assoc.platform]);
  const ownerLine = useOwnerLine(assoc);
  const isOurs = assoc.owner === 'ours';

  return (
    <>
      <p className="text-compact font-medium text-pn leading-snug">
        {isOurs ? t('markdown.assocOwnerOurs') : hint}
      </p>
      <p className="mt-0.5 text-small text-pn-muted leading-snug">
        {isOurs ? hint : ownerLine}
      </p>
      {isOurs ? (
        <p className="mt-2 text-small text-pn-muted leading-snug">
          {t('markdown.assocChangeHint')}
        </p>
      ) : assoc.finderOnly ? (
        <p className="mt-2 text-meta text-pn-muted leading-snug">
          {t('markdown.assocFinderSteps')}
        </p>
      ) : (
        <div className="mt-2.5">
          <ActionButton assoc={assoc} busy={busy} onClick={onAction} emphasis={emphasis} />
        </div>
      )}
      {failed && (
        <p className="mt-1.5 text-small text-danger leading-snug">
          {t('markdown.assocFailed')}
        </p>
      )}
    </>
  );
}

/**
 * Resting file-pane card shown under the file-selection prompt on desktop.
 * Returns `null` outside the desktop app so the caller falls back to `MarkdownPitch`.
 */
export function MarkdownDefaultAppCard() {
  const { assoc, busy, failed, run } = useDefaultAppAction();
  if (!assoc) return null;
  const isOurs = assoc.owner === 'ours';

  return (
    // Centered column with the icon above the copy to match the centered
    // resting prompt in the wide file pane; the other frames stay start-aligned.
    <div
      className={`rounded-lg border p-4 text-center ${
        isOurs
          ? 'border-divider bg-surface-2'
          : 'border-accent/40 bg-accent/[0.04] dark:bg-accent/[0.07]'
      }`}
    >
      <span className="flex justify-center mb-2">
        {isOurs ? (
          <CheckCircle size={22} weight="fill" className="text-success" />
        ) : (
          <FileMd size={22} className="text-accent" />
        )}
      </span>
      <DefaultAppBody
        assoc={assoc}
        busy={busy}
        failed={failed}
        onAction={() => void run()}
        emphasis="solid"
      />
    </div>
  );
}

/**
 * Footer row of `MarkdownPitch`, shared by the explainer modal and the
 * no-folder empty state, separated by a top hairline rather than a nested card.
 */
export function MarkdownDefaultAppRow() {
  const { assoc, busy, failed, run } = useDefaultAppAction();
  if (!assoc) return null;

  return (
    <div className="mt-3 pt-3 border-t border-divider text-start">
      <DefaultAppBody
        assoc={assoc}
        busy={busy}
        failed={failed}
        onAction={() => void run()}
        emphasis="quiet"
      />
    </div>
  );
}

/**
 * Popover anchored to the folder toolbar's Markdown button, providing default-app
 * setup in compact list columns and full-width grid mode.
 */
export function MarkdownDefaultAppPopover({
  open = true,
  onClose,
  anchorRef,
  className = 'w-[19rem] max-w-[calc(100vw-16px)]',
}: {
  open?: boolean;
  onClose: () => void;
  /** Trigger button to anchor under and exclude from outside-click dismissal. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Panel width override. */
  className?: string;
}) {
  const { t } = useTranslation('shell');
  const { assoc, busy, failed, run } = useDefaultAppAction();

  return (
    <Popover
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      align="end"
      title={t('markdown.assocTitle')}
      className={className}
    >
      <div className="px-1.5 pb-1 text-start">
        {assoc ? (
          <DefaultAppBody
            assoc={assoc}
            busy={busy}
            failed={failed}
            onAction={() => void run()}
            emphasis="quiet"
          />
        ) : (
          // Desktop-only trigger; null indicates the initial status read is still pending.
          <p className="text-small text-pn-muted">{t('markdown.assocReading')}</p>
        )}
      </div>
    </Popover>
  );
}

/** Per-kind metadata for the Settings > Editor rows. On macOS the plain-text
 *  claim also covers extensionless text files; on Windows defaults bind per extension. */
const ROW: Record<AssocKind, {
  icon: typeof FileMd;
  title: string;
  hint: (p: MarkdownAssoc['platform']) => [ns: 'shell' | 'settings', key: string];
  finderSteps: [ns: 'shell' | 'settings', key: string];
}> = {
  markdown: {
    icon: FileMd,
    title: 'importExport:sourceLabel.markdownFolder',
    hint: () => ['settings', 'appearance.defaultAppsMarkdownHint'],
    finderSteps: ['shell', 'markdown.assocFinderSteps'],
  },
  text: {
    icon: FileText,
    title: 'appearance.defaultAppsText',
    hint: (p) => ['settings', p === 'windows' ? 'appearance.defaultAppsTextHintWindows' : 'appearance.defaultAppsTextHint'],
    finderSteps: ['settings', 'appearance.defaultAppsTextFinderSteps'],
  },
};

/**
 * Row in Settings > Editor under "Open with PrivacyNotes" for Markdown or Text
 * (`.txt`) files. Omitted for `text` on Linux where no plain-text claim is offered.
 *
 * Spec: docs/internal/specs/default-app-settings.md (sections 4 and 6)
 */
export function DefaultAppSettingsRow({ kind }: { kind: AssocKind }) {
  const { t } = useTranslation('settings');
  const { t: tShell } = useTranslation('shell');
  const { assoc, busy, failed, run } = useDefaultAppAction(kind);
  const markdown = useDefaultApp('markdown');
  if (kind === 'text' && markdown?.platform === 'linux') return null;
  const row = ROW[kind];
  const tr = ([ns, key]: [ns: 'shell' | 'settings', key: string], opts: Record<string, string> = {}) =>
    ns === 'shell' ? tShell(key, opts) : t(key, opts);
  const isOurs = assoc?.owner === 'ours';

  let status: string;
  if (!assoc) {
    status = tShell('markdown.assocReading');
  } else {
    const parts = [tr(row.hint(assoc.platform))];
    if (!isOurs && assoc.owner === 'other') {
      parts.push(
        assoc.otherName
          ? t('appearance.defaultAppsOwnerOther', { app: assoc.otherName })
          : t('appearance.defaultAppsOwnerOtherUnnamed'),
      );
    } else if (!isOurs && assoc.owner === 'none') parts.push(t('appearance.defaultAppsOwnerNone'));
    if (!isOurs && !assoc.settable) parts.push(tShell('markdown.assocWindowsManual'));
    if (!isOurs && assoc.finderOnly) parts.push(tr(row.finderSteps));
    status = parts.join(' ');
  }

  return (
    <div className={SETTINGS_ROW}>
      {/* `lg:flex-1` lets the helper line wrap within its column rather than
          pushing the action button onto its own row. */}
      <div className="min-w-0 lg:flex-1">
        <RowTitle icon={row.icon}>{t(row.title)}</RowTitle>
        <p className={`${SETTINGS_HELP} mt-0.5`}>{status}</p>
        {failed && (
          <div className="mt-1">
            <StatusLine tone="danger">{tShell('markdown.assocFailed')}</StatusLine>
          </div>
        )}
      </div>
      {/* Disabled confirmation matches the action button's footprint so both
          states align in the settings group. */}
      {assoc && !(!isOurs && assoc.finderOnly) && (isOurs ? (
        <Button icon={<CheckCircle weight="fill" aria-hidden="true" className="shrink-0 text-success" />} disabled>
          {t('appearance.defaultAppsIsDefault')}
        </Button>
      ) : (
        <Button
          icon={assoc.settable
            ? <CheckCircle aria-hidden="true" className="shrink-0" />
            : <ArrowSquareOut aria-hidden="true" className="shrink-0" />}
          onClick={() => void run()}
          disabled={busy}
        >
          {busy
            ? tShell('markdown.assocWorking')
            : assoc.settable ? t('appearance.defaultAppsMakeDefault') : tShell('markdown.assocWindowsOpen')}
        </Button>
      ))}
    </div>
  );
}
