import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { formatBytes } from './formatBytes';
import { SETTINGS_EYEBROW } from './settingsUI';
import { HoverLabel } from './HoverLabel';

/** Share of the quota used, 0 to 100. */
function usedPct(usedBytes: number, maxBytes: number): number {
  return maxBytes > 0 ? Math.min((usedBytes / maxBytes) * 100, 100) : 0;
}

/**
 * The ring itself: the track and the used arc, amber over 80%. One drawing
 * for Settings, the list panes and the footer.
 */
function Ring({ pct, stroke, radius = 43, className, size }: { pct: number; stroke: number; radius?: number; className?: string; size?: number }) {
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - Math.max(pct, 0.5) / 100);
  return (
    <svg viewBox="0 0 100 100" className={className} width={size} height={size} aria-hidden="true">
      <circle cx="50" cy="50" r={radius} fill="none" strokeWidth={stroke} className="stroke-pn-muted/35" />
      <circle
        cx="50"
        cy="50"
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 50 50)"
        className={`transition-all ${pct > 80 ? 'stroke-warning' : 'stroke-accent'}`}
      />
    </svg>
  );
}

/** Storage quota radial gauge. */
export function QuotaRing({
  label,
  usedBytes,
  maxBytes,
  compact = false,
}: {
  /** The line under the numbers: a word, or a word with its info tip. */
  label: ReactNode;
  usedBytes: number;
  maxBytes: number;
  /**
   * Horizontal ring + stats layout. Saves vertical space (e.g. modals);
   * `small` is the list pane's size (Files, Trash), where the numbers wrap
   * under each other when the pane is narrow.
   */
  compact?: boolean | 'small';
}) {
  const { t } = useTranslation('settings');
  const pct = usedPct(usedBytes, maxBytes);
  const gb = maxBytes / 1000 ** 3;
  const gbRounded = Math.round(gb * 2) / 2;
  const maxLabel =
    gb >= 1
      ? t('quota.gb', { value: Number.isInteger(gbRounded) ? gbRounded : gbRounded.toFixed(1) })
      : t('quota.mb', { value: Math.round(maxBytes / 1000 ** 2 / 50) * 50 });
  const pctLabel = pct === 0 ? '0%' : pct < 1 ? '<1%' : `${Math.round(pct)}%`;

  if (compact) {
    const small = compact === 'small';
    return (
      <div className={`flex min-w-0 items-center ${small ? 'gap-3' : 'gap-4'}`}>
        <div className={`relative shrink-0 ${small ? 'h-12 w-12' : 'h-16 w-16'}`}>
          <Ring pct={pct} stroke={9} className={small ? 'h-12 w-12' : 'h-16 w-16'} />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className={`font-medium leading-none text-pn ${small ? 'text-small' : 'text-row'}`}>
              {pctLabel}
            </span>
          </div>
        </div>
        <div className="min-w-0">
          <div className={`font-medium text-pn ${small ? 'text-row' : 'text-heading'}`}>
            {/* A narrow pane breaks between the used amount and "of 50 MB", never inside either. */}
            <span className="whitespace-nowrap">{formatBytes(usedBytes)}</span>{' '}
            <span className="font-normal text-pn-muted whitespace-nowrap">
              <Trans
                i18nKey="settings:quota.ofMax"
                values={{ max: maxLabel }}
                components={{ max: <span className="font-medium text-accent" /> }}
              />
            </span>
          </div>
          <div className={`mt-0.5 text-pn-muted ${small ? 'text-small' : 'text-help'}`}>{label}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative h-[152px] w-[152px]">
        <Ring pct={pct} stroke={8} className="h-[152px] w-[152px]" />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-display-3 font-medium leading-none text-pn">
            {pctLabel}
          </span>
          <span className={`mt-1 ${SETTINGS_EYEBROW}`}>
            {t('quota.used')}
          </span>
        </div>
      </div>
      <div className="mt-3 text-row font-medium text-pn">
        {formatBytes(usedBytes)}{' '}
        <span className="font-normal text-pn-muted">
          <Trans
            i18nKey="settings:quota.ofMax"
            values={{ max: maxLabel }}
            components={{ max: <span className="font-medium text-accent" /> }}
          />
        </span>
      </div>
      <div className="mt-0.5 text-help text-pn-muted">{label}</div>
    </div>
  );
}

/**
 * The footer's storage gauge (#791): the ring alone, no text, so it fits a
 * footer on any screen and needs no translation. The tip says "15% used
 * (7.4 MB / 50 MB)"; a click opens Settings > Storage.
 * Spec: docs/internal/design/ui-patterns.md section 205
 */
export function QuotaRingButton({ usedBytes, maxBytes, onOpen, size = 20, tipPosition = 'above', tipHostClassName }: {
  usedBytes: number;
  maxBytes: number;
  onOpen: () => void;
  /** Px, the same as the sync icon beside it. */
  size?: number;
  tipPosition?: 'above-start' | 'above';
  tipHostClassName?: string;
}) {
  const { t } = useTranslation('common');
  if (maxBytes <= 0) return null;
  const pct = usedPct(usedBytes, maxBytes);
  const usage = t('storageBar.usage', {
    percent: pct > 0 && pct < 1 ? '<1' : Math.round(pct),
    used: formatBytes(usedBytes).replace(/\.0(\s)/, '$1'),
    max: formatBytes(maxBytes).replace(/\.0(\s)/, '$1'),
  });
  return (
    <HoverLabel label={usage} position={tipPosition} className={tipHostClassName}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${usage} - ${t('storageBar.open')}`}
        className="inline-flex items-center justify-center rounded-md p-1 hover:bg-pn/5 transition"
      >
        {/* Radius 35 + stroke 13 spans 83% of the 100x100 viewBox, matching
            Phosphor bold's circular optical box (Gear, ArrowsClockwise) so
            the storage ring does not tower over its footer neighbors. */}
        <Ring pct={pct} stroke={13} radius={35} size={size} />
      </button>
    </HoverLabel>
  );
}
