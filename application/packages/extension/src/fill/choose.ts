/**
 * Which frame of a tab gets the login. One frame, the best one, and only a
 * frame whose own address matches the login. The address is the one the
 * browser gave for the frame, never one the page said.
 * Spec: docs/internal/plans/click-to-fill.md (sections 3.3 and 3.6)
 */
import type { LoginCopyEntry } from '@notes/shared/extension';
import { matchLogins } from '../match';
import type { FrameReport } from './types';

export interface ProbedFrame {
  frameId: number;
  documentId?: string;
  /** From the browser: the sender of the probe message, or the tab for frame 0. */
  url: string;
  report: FrameReport;
}

/** `https:`, or this computer itself. */
function secure(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

/** 1 is best. A step this frame may not do has no rank. */
function rankOf(frame: ProbedFrame, canCode: boolean): number | null {
  const { step, sure, focused } = frame.report;
  const top = frame.frameId === 0;
  if (step === 'login') return 1;
  // A code alone goes to the top frame only.
  if (step === 'code') return canCode && top ? (sure ? 2 : 4) : null;
  if (step === 'username') return sure ? 3 : top || focused ? 5 : null;
  return null;
}

/**
 * The frame to fill, or none. `insecure` says that a frame would have been
 * filled but its page is `http:` while the login was saved for a secure page.
 */
export function chooseFrame(frames: readonly ProbedFrame[], login: LoginCopyEntry, canCode: boolean): { frame?: ProbedFrame; insecure: boolean } {
  const savedPlain = login.urls.some((u) => /^http:\/\//i.test(u.trim()));
  let insecure = false;
  const ranked: { frame: ProbedFrame; rank: number }[] = [];
  for (const frame of frames) {
    if (!matchLogins([login], frame.url).length) continue;
    const rank = rankOf(frame, canCode);
    if (rank === null) continue;
    if (!secure(frame.url) && !savedPlain) {
      insecure = true;
      continue;
    }
    ranked.push({ frame, rank });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(b.frame.report.focused) - Number(a.frame.report.focused) ||
      Number(b.frame.frameId === 0) - Number(a.frame.frameId === 0) ||
      a.frame.frameId - b.frame.frameId,
  );
  const frame = ranked[0]?.frame;
  return { frame, insecure: !frame && insecure };
}
