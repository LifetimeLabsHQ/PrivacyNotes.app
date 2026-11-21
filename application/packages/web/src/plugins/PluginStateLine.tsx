import { useTranslation } from 'react-i18next';
import { formatBytes } from '../formatBytes';
import { ProgressBar, StatusLine } from '../ui';
import type { PluginState } from './pluginState';

/**
 * The words under a plugin for a state that needs one: the download with its
 * bar (or Waiting, behind another download), loading, the demo, a failure. Settings > Plugins and the Translate
 * sheet show the same lines.
 * Spec: docs/internal/plans/plugins.md (sections 3 and 5)
 */
export function PluginStateLine({ state, name }: { state: PluginState; name: string }) {
  const { t } = useTranslation('settings');
  // Behind another download: one runs at a time (pluginManager.ts).
  if (state.status === 'downloading' && state.waiting) return <StatusLine>{t('importExport:upload.statusWaiting')}</StatusLine>;
  if (state.status === 'downloading') {
    return (
      <div className="mt-1.5 flex flex-col gap-1">
        <ProgressBar value={state.loaded / state.total} label={t('plugins.downloading', { name })} />
        <StatusLine>{t('stats:milestones.ofTarget', { current: formatBytes(state.loaded), target: formatBytes(state.total) })}</StatusLine>
      </div>
    );
  }
  if (state.status === 'loading') return <StatusLine busy>{t('plugins.loading', { name })}</StatusLine>;
  if (state.status === 'unavailable') return <StatusLine tone="danger">{t('plugins.demo')}</StatusLine>;
  if (state.status === 'error') return <StatusLine tone="danger">{t(state.reason === 'space' ? 'plugins.noSpace' : 'onDeviceAi.failed')}</StatusLine>;
  return null;
}
