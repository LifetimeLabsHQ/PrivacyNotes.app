import { useReducer, useRef } from 'react';
import type { SidePair } from './useOpenTabs';

/**
 * Two items side by side ("Open side by side"): which side is focused, and
 * an editor count per side that a focus swap leaves alone. The room it needs
 * is Split view's (`fitsSourcePreview` in sourcePreviewButtons.tsx).
 * Spec: docs/internal/specs/side-by-side-notes.md
 */

export type Side = 'left' | 'right';

export const otherSide = (side: Side): Side => (side === 'left' ? 'right' : 'left');

/**
 * The pair as it is drawn now. The focused side is the one whose id is the
 * open item. An open item that is on neither side (a list click, J and K, a
 * search result) takes the side that was focused last, the way a single pane
 * changes its item. Null when there is no pair or nothing is open.
 */
export function pairView(pair: SidePair | null, openId: string | null, lastFocus: Side): { pair: SidePair; focusAt: Side; otherId: string } | null {
  if (!pair || openId === null) return null;
  const focusAt: Side = pair.left === openId ? 'left' : pair.right === openId ? 'right' : lastFocus;
  const shown = focusAt === 'left' ? { left: openId, right: pair.right } : { left: pair.left, right: openId };
  if (shown.left === shown.right) return null;
  return { pair: shown, focusAt, otherId: shown[otherSide(focusAt)] };
}

/** Where "Open side by side" puts `id`: on the side away from the open item,
 *  replacing what the other side showed. The right unless the open item sits
 *  on the right, so the open item's editor never moves. */
export function pairWith(openId: string, id: string, current: { focusAt: Side } | null, lastFocus: Side): SidePair {
  const focusAt = current?.focusAt ?? lastFocus;
  return focusAt === 'left' ? { left: openId, right: id } : { left: id, right: openId };
}

/**
 * The editor count one side keys its editor with. NotesView bumps one count,
 * `editorRevision`, to remount the open item's editor; with two sides that
 * count follows the focus, so a side reads it only while focused and keeps
 * where it stood while not. A focus swap then changes neither side's number
 * and remounts nothing. `bump` remounts the side while it is not focused
 * (its item changed under it, from another device).
 */
export function usePaneRevision(focused: boolean, global: number): [number, () => void] {
  const s = useRef({ base: global, frozen: 0, focused });
  const [, render] = useReducer((n: number) => n + 1, 0);
  const cur = s.current;
  if (cur.focused !== focused) {
    if (focused) cur.base = global - cur.frozen;
    else cur.frozen = global - cur.base;
    cur.focused = focused;
  }
  const bump = () => {
    if (s.current.focused) s.current.base -= 1;
    else s.current.frozen += 1;
    render();
  };
  return [focused ? global - cur.base : cur.frozen, bump];
}
