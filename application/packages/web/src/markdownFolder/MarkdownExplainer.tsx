/**
 * The one place the plaintext nature is spelled out at length.
 *
 * One entry point: the `?` on the folder row, ending in a single [Got it].
 * It had a second mode until 2026-08-14 - the first-run gate of spec section
 * 12, shown once ahead of the OS picker - removed because the empty state
 * renders `MarkdownPitch` directly, so the gate put a modal in front of the
 * button and filled it with the screen already behind it. Everything else in
 * the feature stays quiet - the open padlock and the folder path do the
 * reminding - because a warning repeated on every surface is a warning people
 * learn to skip.
 *
 * Leads with the sell (an advanced Markdown editor, free, on the user's own
 * files), then the use cases, and states the local/plaintext nature as one
 * visual pair of facts rather than a warning list: these files stay on the
 * device, and they sit outside our encrypted vault. The claim "not even we can
 * read your notes" stays true here and is in a sense more true: nothing about
 * these files ever involves us. What changes is that local threats are the
 * user's to handle, and the honest way to say that is to state where the files
 * are and what we do not do with them.
 *
 * Spec: docs/internal/specs/markdown-folder.md (section 12)
 */
import { useTranslation } from 'react-i18next';
import { FileMd, Robot, Book, GitBranch, Sparkle, Eye, ListChecks, Tag, Table, Laptop, CloudSlash, Brain } from '../icons';
import { useEscapeToClose } from '../useEscapeToClose';
import { MarkdownDefaultAppRow } from './MarkdownDefaultApp';
import { CloseButton, FeaturePitch, PitchBadge } from '../ui';

/**
 * The pitch itself, without any modal chrome.
 *
 * Exported because the empty state shows exactly this - the same banner, chips,
 * use cases and local/plaintext strip - and a second copy of that content is a
 * second copy to keep in step. There is one set of strings and one layout; only
 * the frame around them differs.
 *
 * `actions` rides the last row beside the second-brain line. The modal puts its
 * dismiss/confirm pair there; the empty state passes nothing and lays its two
 * pickers out underneath, where they get a column each.
 */
export function MarkdownPitch({ actions }: { actions?: React.ReactNode }) {
  const { t } = useTranslation('shell');
  return (
    <FeaturePitch
      banner={{
        tone: 'amber',
        icon: <Sparkle />,
        title: t('markdown.bannerTitle'),
        sub: t('markdown.bannerSub'),
        badge: <PitchBadge>{t('markdown.bannerFree')}</PitchBadge>,
      }}
      intro={t('markdown.explainIntro')}
      chips={[
        { icon: <Eye />, label: t('markdown.chipPreview') },
        { icon: <ListChecks />, label: t('markdown.chipTasks') },
        { icon: <Tag />, label: t('shell:tagsRail.tags') },
        { icon: <Table />, label: t('markdown.chipTables') },
      ]}
      uses={[
        { icon: <Robot />, label: t('markdown.useAgent') },
        { icon: <Book />, label: t('markdown.useObsidian') },
        { icon: <GitBranch />, label: t('markdown.useGit') },
      ]}
      // The local/plaintext facts as one strip: a positive (your disk, your
      // eyes only) beside a negative (outside the vault), replacing the old
      // tick/cross warning list.
      facts={[
        { icon: <Laptop className="text-success" />, title: t('markdown.localTitle'), sub: t('markdown.localSub') },
        { icon: <CloudSlash className="text-danger" />, title: t('markdown.cloudTitle'), sub: t('markdown.cloudSub') },
      ]}
      tagline={{ icon: <Brain />, label: t('markdown.secondBrain') }}
      actions={actions}
      // Which app the OS opens .md files with. Renders nothing outside the
      // desktop app, and lands in BOTH of this component's homes for free -
      // the explainer modal and the no-folder empty state. Below the tagline:
      // everything above is the pitch, and this is the one row that changes
      // the machine rather than describing the feature.
      // Spec: docs/internal/specs/markdown-folder.md (section 11)
      footer={<MarkdownDefaultAppRow />}
    />
  );
}

export function MarkdownExplainer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('shell');
  useEscapeToClose(onClose);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 flex items-center justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-divider bg-surface-2 p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="markdown-explainer-title"
      >
        <div className="flex items-center gap-2.5 mb-3">
          <FileMd size={20} className="text-pn-muted shrink-0" />
          <h2 id="markdown-explainer-title" className="flex-1 text-heading font-semibold text-pn">
            {t('markdown.explainTitle')}
          </h2>
          <CloseButton onClick={onClose} className="shrink-0" />
        </div>

        {/* One dismiss, no confirm. This was also the first-folder-pick gate
            until 2026-08-14, when that mode was removed as redundant - the
            empty state renders this same pitch, so the gate showed the reader
            what was already on screen. Now it is only the reference card. */}
        <MarkdownPitch
          actions={
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 text-compact px-3 py-1.5 rounded-md border border-divider hover:bg-surface-1 transition"
            >
              {t('markdown.explainDone')}
            </button>
          }
        />
      </div>
    </div>
  );
}
