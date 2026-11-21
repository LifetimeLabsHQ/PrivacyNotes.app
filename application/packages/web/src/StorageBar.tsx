import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowsClockwise } from './icons';
import { HoverLabel } from './HoverLabel';
import { formatBytes } from './formatBytes';
import { QuotaRing } from './QuotaRing';

/** formatBytes with the pointless trailing ".0" trimmed ("500.0 MB" →
 *  "500 MB") - this line has to fit a narrow list pane in one piece. */
function compactBytes(bytes: number): string {
  return formatBytes(bytes).replace(/\.0(\s)/, '$1');
}

type Props = {
  /** Already-translated "Storage" label from the owning pane's namespace. */
  label: string;
  usedBytes: number;
  maxBytes: number;
  /** Re-runs the server-side recount (recalculate_my_quota) + refetch. */
  onRefresh: () => Promise<void> | void;
  /** Opens Settings > Storage from the usage figure and the track. */
  onOpen?: () => void;
};

/**
 * The storage gauge of the Trash and Files panes: the Settings ring
 * (`QuotaRing`, small) with the used and the total beside it; a click on it
 * opens Settings > Storage, which also explains when deleted files stop
 * counting. A small recount tool sits on its label line. The
 * refresh reuses the Markdown rescan button's two-animation contract
 * (half-turn on hover, continuous spin while running, held one full rotation
 * so a fast refresh still visibly runs - see MarkdownListPane's handleRescan).
 * Spec: docs/internal/design/ui-patterns.md section 204
 */
export function StorageBar({ label, usedBytes, maxBytes, onRefresh, onOpen }: Props) {
  const { t } = useTranslation('common');
  const [busy, setBusy] = useState(false);
  if (maxBytes <= 0) return null;
  const pct = Math.min((usedBytes / maxBytes) * 100, 100);
  const usage = t('storageBar.usage', {
    percent: Math.round(pct),
    used: compactBytes(usedBytes),
    max: compactBytes(maxBytes),
  });

  async function handleRefresh() {
    if (busy) return;
    setBusy(true);
    try {
      await Promise.all([
        onRefresh(),
        new Promise((resolve) => setTimeout(resolve, 600)),
      ]);
    } finally {
      setBusy(false);
    }
  }

  // A small tool on the label line, so the amount keeps the pane's width.
  const tool = 'group/tool pointer-events-auto relative z-10 inline-flex items-center justify-center w-6 h-6 shrink-0 rounded-md text-pn-muted hover:text-accent hover:bg-pn/10 disabled:opacity-50 transition cursor-pointer';
  const label_ = (
    <span className="inline-flex items-center gap-0.5">
      {label}
      <HoverLabel label={t('storageBar.refresh')} position="below-start" className="flex">
        <button type="button" onClick={() => void handleRefresh()} disabled={busy} aria-label={t('storageBar.refresh')} className={tool}>
          <ArrowsClockwise className={busy ? 'animate-spin' : 'transition-transform duration-300 group-hover/tool:rotate-180'} />
        </button>
      </HoverLabel>
    </span>
  );
  return (
    // The whole gauge opens Settings > Storage: one button under the
    // gauge (the stretched-link pattern), so the two tools on the label line
    // stay their own buttons above it, never inside it.
    <div className="shrink-0 px-4 pt-2 pb-1">
      <div className={`relative rounded-lg -m-1 p-1 transition${onOpen ? ' hover:bg-pn/5' : ''}`}>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`${usage} - ${t('storageBar.open')}`}
            className="absolute inset-0 rounded-lg cursor-pointer"
          />
        )}
        {/* Clicks pass through the gauge to the button; only the tools take their own. */}
        <div className="pointer-events-none">
          <QuotaRing compact="small" usedBytes={usedBytes} maxBytes={maxBytes} label={label_} />
        </div>
      </div>
    </div>
  );
}
