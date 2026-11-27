/**
 * Reference modal spelling out how the plaintext Markdown folder works.
 *
 * Reached from the `?` button on the folder toolbar and dismissed with a
 * single [Got it] action; the no-folder empty state renders `MarkdownPitch`
 * directly ahead of the picker. Other surfaces stay quiet - the folder path
 * and local-folder icon carry the reminder without repeating a warning on
 * every screen.
 *
 * Leads with the editor capabilities and use cases, then states the storage
 * boundary as a visual pair of facts: files stay on this device, and they sit
 * outside the encrypted vault with no sync, encryption, or backup. Local disk
 * security belongs to the user's device, so the copy states where the files
 * live and what the app does not do with them.
 *
 * Spec: docs/internal/specs/markdown-folder.md (section 12)
 */
import { useTranslation } from 'react-i18next';
import { FileMd, Robot, Book, GitBranch, Sparkle, Eye, ListChecks, Tag, Table, Laptop, CloudSlash, Brain } from '../icons';
import { MarkdownDefaultAppRow } from './MarkdownDefaultApp';
import { Button, FeaturePitch, Modal, PitchBadge } from '../ui';

/**
 * The pitch itself, without modal chrome.
 *
 * Shared by `MarkdownExplainer` and `MarkdownEmptyState` so both frames render
 * one set of strings and one layout. `actions` sits beside the tagline in the
 * modal; the empty state omits `actions` and places its folder and file pickers
 * underneath in a two-column grid.
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
      // Storage boundary as a paired strip: local disk ownership beside
      // separation from the encrypted vault.
      facts={[
        { icon: <Laptop className="text-success" />, title: t('markdown.localTitle'), sub: t('markdown.localSub') },
        { icon: <CloudSlash className="text-danger" />, title: t('markdown.cloudTitle'), sub: t('markdown.cloudSub') },
      ]}
      tagline={{ icon: <Brain />, label: t('markdown.secondBrain') }}
      actions={actions}
      // OS default-app control for .md files. Renders nothing outside the
      // desktop app, appearing in both the explainer modal and the empty state
      // below the tagline.
      // Spec: docs/internal/specs/markdown-folder.md (section 11)
      footer={<MarkdownDefaultAppRow />}
    />
  );
}

export function MarkdownExplainer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('shell');
  return (
    <Modal
      onClose={onClose}
      title={t('markdown.explainTitle')}
      icon={<FileMd />}
      className="max-w-md p-5 space-y-3 max-h-[calc(100dvh-2rem)] overflow-y-auto"
    >
      {/* Reference card with a single dismiss action; the empty state renders
          the same pitch inline before a folder is picked. */}
      <MarkdownPitch
        actions={
          <Button action="done" variant="secondary" onClick={onClose} className="shrink-0">
            {t('markdown.explainDone')}
          </Button>
        }
      />
    </Modal>
  );
}
