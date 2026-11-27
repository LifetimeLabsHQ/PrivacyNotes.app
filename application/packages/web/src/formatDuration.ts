import { toLocalIso } from './localDate';

/**
 * Seconds as `m:ss`. Shared so the recorder's elapsed counter and the audio
 * chip's playback position read identically; the chip cannot import it from
 * `AudioRecorder.tsx`, which imports the chip's upload entry point.
 */
export function formatDuration(secs: number): string {
  const whole = Math.max(0, Math.floor(secs));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** The recording's name stamp in the person's local time, as
 *  `2026-10-06T19-43-15`: a name to read, so never the UTC clock. */
export function recordingStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${toLocalIso(d)}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
