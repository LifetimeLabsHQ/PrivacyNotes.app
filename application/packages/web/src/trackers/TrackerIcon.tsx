import { cloneElement, isValidElement, type CSSProperties, type ReactElement } from 'react';
import type { TrackerDescriptor } from '../wellnessTypes';
import { TRACKER_ICONS } from './icons';
import { CustomTrackerGlyph } from './CustomTrackerGlyph';

/**
 * The one icon of a tracker, wherever a tracker is named: the journal pill's
 * glyph for a built-in, the habit square for a habit, the pill for a
 * medicine, and a custom tracker's own look icon (the heartbeat without one).
 * Never a color dot. Spec: docs/internal/specs/tracker-focus-771.md (section 3)
 */
function trackerIconKey(d: Pick<TrackerDescriptor, 'id' | 'source'>): string | null {
  if (d.source === 'medication') return 'medication';
  if (d.id === 'sleepHours' || d.id === 'sleepQuality') return 'sleep';
  if (d.id === 'bpSystolic' || d.id === 'bpDiastolic') return 'bloodPressure';
  if (d.id.startsWith('habit-')) return 'habits';
  return d.id in TRACKER_ICONS ? d.id : null;
}

export function TrackerIcon({ d, size, className, style }: {
  d: Pick<TrackerDescriptor, 'id' | 'source' | 'icon'>;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const key = d.source === 'custom' && !d.id.startsWith('habit-') ? null : trackerIconKey(d);
  const glyph = key ? TRACKER_ICONS[key] : null;
  if (isValidElement(glyph)) {
    return cloneElement(glyph as ReactElement<{ size?: number; className?: string; style?: CSSProperties; 'aria-hidden'?: boolean }>, {
      ...(size ? { size } : {}),
      className,
      style,
      'aria-hidden': true,
    });
  }
  return <CustomTrackerGlyph icon={d.icon} {...(size ? { size } : {})} className={className} style={style} />;
}
