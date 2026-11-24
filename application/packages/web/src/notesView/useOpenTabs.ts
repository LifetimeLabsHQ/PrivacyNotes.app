import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LocalNote } from '../db';
import { isDemoMode } from '../demo';
import { readReopenLastOpen, useReopenLastOpen } from './listPlace';
import {
  hasPinnedTabsRegister,
  MAX_PINNED_TABS,
  migratePinnedTabs,
  readPinnedTabs,
  writePinnedTabs,
  type PinnedTabsSetting,
} from '../pinnedTabs';

/**
 * The items open as tabs above the editor: an ordered list of ids. Unpinned
 * open tabs and the side-by-side pair stay per device (localStorage); pinned
 * tabs sync across devices via the encrypted settings blob (`pinnedTabs`). The
 * list is all there is to a tab; which one is active is simply whichever id is
 * `selectedId`. A tab changes its item only through `followTab`, when "Open
 * items in tabs" is on.
 *
 * A pinned tab sits in a group at the start of the strip and cannot be closed,
 * one by one or in bulk, until it is unpinned. Only its item leaving the app
 * (trash, delete) removes it.
 * Spec: docs/internal/specs/note-tabs.md
 */

const KEY = 'privacynotes.openTabs';

/** Two items side by side: the ids on the left and on the right. Both always
 *  have a tab, so the pair goes when either tab goes. Which side is focused is
 *  not stored: it is the side whose id is `selectedId`.
 *  Spec: docs/internal/specs/side-by-side-notes.md (section 8) */
export type SidePair = { left: string; right: string };

/** Synced pinned-tabs store passed by NotesView (backed by userSettings.pinnedTabs). */
export interface SyncedPinnedTabs {
  setting: PinnedTabsSetting;
  onChange: (updater: (prev: PinnedTabsSetting) => PinnedTabsSetting) => void;
  /** True once this device holds a full view of the account's notes (after a
   *  clean pull, in local-only mode, or in the demo), so ids missing from
   *  `everything` are gone for real rather than not pulled yet. */
  canPruneMissing?: boolean;
}

type Stored = { ids: string[]; pinned: string[]; pair: SidePair | null };

function pairOf(v: unknown): SidePair | null {
  if (!v || typeof v !== 'object') return null;
  const { left, right } = v as Partial<SidePair>;
  return typeof left === 'string' && typeof right === 'string' && left !== right ? { left, right } : null;
}

/** The demo shares its origin with a real install, so it keeps its own tabs in
 *  sessionStorage. When "Reopen where I left off" is off, unpinned tabs also
 *  stay in sessionStorage so closing the app drops them while an app-lock
 *  re-lock inside the same window keeps them. */
function store(remember: boolean): Storage {
  return isDemoMode() || !remember ? sessionStorage : localStorage;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function unique(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of list) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function parseStored(raw: string | null): Stored {
  try {
    const parsed = JSON.parse(raw ?? '{}') as Partial<Stored>;
    const ids = unique(strings(parsed.ids));
    const pinned = unique(strings(parsed.pinned)).filter((id) => ids.includes(id));
    return {
      ids: [...pinned, ...ids.filter((id) => !pinned.includes(id))],
      pinned,
      pair: pairOf(parsed.pair),
    };
  } catch {
    return { ids: [], pinned: [], pair: null };
  }
}

function read(remember: boolean): Stored {
  try {
    const active = parseStored(store(remember).getItem(KEY));
    // An install that already had "Reopen where I left off" off before pinned
    // tabs synced may still carry legacy pinned ids in localStorage; pick only
    // those up for the one-time migration without restoring old unpinned tabs.
    if (!remember && !isDemoMode() && active.pinned.length === 0) {
      const legacy = parseStored(localStorage.getItem(KEY));
      if (legacy.pinned.length > 0) {
        return {
          ids: [...legacy.pinned, ...active.ids.filter((id) => !legacy.pinned.includes(id))],
          pinned: legacy.pinned,
          pair: active.pair,
        };
      }
    }
    return active;
  } catch {
    return { ids: [], pinned: [], pair: null };
  }
}

/** `notes` is the list the strip draws from; `everything` is every item, the
 *  ones of a shut section included, and only an item gone from it takes its
 *  tab away: a section that shuts hides its tabs and keeps them.
 *  Spec: docs/internal/specs/section-lock.md (section 5) */
export function useOpenTabs(
  notes: LocalNote[],
  everything: LocalNote[] = notes,
  syncedPinned?: SyncedPinnedTabs,
) {
  const [reopenLastOpen] = useReopenLastOpen();
  const [state, setState] = useState<Stored>(() => read(readReopenLastOpen()));

  const hasRegister = syncedPinned ? hasPinnedTabsRegister(syncedPinned.setting) : false;
  const syncedList = useMemo(
    () => (syncedPinned ? readPinnedTabs(syncedPinned.setting) : []),
    [syncedPinned?.setting],
  );
  // While the account has no synced register yet, keep showing any pre-upgrade
  // local pinned tabs until the migration effect or the first pull settles them.
  const pinned = syncedPinned ? (hasRegister ? syncedList : state.pinned) : state.pinned;
  const pinnedIds = useMemo(() => new Set(pinned), [pinned]);
  const unpinned = useMemo(
    () => state.ids.filter((id) => !pinnedIds.has(id)),
    [state.ids, pinnedIds],
  );
  const allIds = useMemo(() => [...pinned, ...unpinned], [pinned, unpinned]);
  const tabIds = useMemo(() => new Set(allIds), [allIds]);
  const pair = useMemo(
    () => (state.pair && tabIds.has(state.pair.left) && tabIds.has(state.pair.right) ? state.pair : null),
    [state.pair, tabIds],
  );

  // Latest values for callbacks without forcing callers to rebind every render.
  const latestRef = useRef({ pinned, pinnedIds, unpinned, allIds, tabIds, syncedPinned });
  latestRef.current = { pinned, pinnedIds, unpinned, allIds, tabIds, syncedPinned };

  useEffect(() => {
    try {
      store(reopenLastOpen).setItem(KEY, JSON.stringify(state));
      if (!isDemoMode()) {
        if (reopenLastOpen) {
          sessionStorage.removeItem(KEY);
        } else if (state.pinned.length === 0) {
          localStorage.removeItem(KEY);
        }
      }
    } catch { /* storage unavailable */ }
  }, [state, reopenLastOpen]);

  // One-time migration: carry pre-upgrade local pinned tabs into the synced
  // register once notes have loaded, stamped at the epoch so any real edit from
  // another upgraded device wins the merge. Once the synced register exists
  // (from here or from another device), drop the legacy local copy so old pins
  // can never resurrect after a later unpin-all ages out.
  useEffect(() => {
    if (!syncedPinned) return;
    if (hasRegister) {
      if (state.pinned.length === 0) return;
      const legacy = new Set(state.pinned);
      setState((prev) => ({
        ...prev,
        ids: prev.ids.filter((id) => !legacy.has(id)),
        pinned: [],
      }));
      return;
    }
    if (state.pinned.length === 0 || everything.length === 0) return;
    const live = new Set(everything.filter((n) => n.trashed === 0).map((n) => n.id));
    const liveLegacy = state.pinned.filter((id) => live.has(id));
    const legacy = new Set(state.pinned);
    if (liveLegacy.length > 0) {
      syncedPinned.onChange((prev) => migratePinnedTabs(prev, liveLegacy));
    }
    setState((prev) => ({
      ...prev,
      ids: prev.ids.filter((id) => !legacy.has(id)),
      pinned: [],
    }));
  }, [syncedPinned, hasRegister, state.pinned, everything]);

  // An item that is trashed or gone takes its tab with it, pinned or not. The
  // list is empty for a moment at boot, and a missing id then means "not
  // loaded yet", so nothing is pruned until at least one item is there.
  // Synced pinned tabs prune trashed items immediately, and prune missing ids
  // only once `canPruneMissing` is true, so a fresh or mid-pull device never
  // deletes another device's pinned tabs before its notes arrive.
  const canPruneMissing = syncedPinned?.canPruneMissing ?? false;
  useEffect(() => {
    if (everything.length === 0) return;
    const live = new Set<string>();
    const trashed = new Set<string>();
    for (const n of everything) {
      if (n.trashed === 0) live.add(n.id);
      else trashed.add(n.id);
    }
    setState((prev) => {
      const nextIds = prev.ids.filter((id) => live.has(id));
      const nextPinned = prev.pinned.filter((id) => live.has(id));
      const nextPair = prev.pair && live.has(prev.pair.left) && live.has(prev.pair.right) ? prev.pair : null;
      if (nextIds.length === prev.ids.length && nextPinned.length === prev.pinned.length && nextPair === prev.pair) {
        return prev;
      }
      return { ids: nextIds, pinned: nextPinned, pair: nextPair };
    });
    if (syncedPinned && hasRegister && pinned.length > 0) {
      const shouldDrop = (id: string) => trashed.has(id) || (canPruneMissing && !live.has(id));
      if (pinned.some(shouldDrop)) {
        syncedPinned.onChange((prev) => {
          const cur = readPinnedTabs(prev);
          const kept = cur.filter((id) => !shouldDrop(id));
          return kept.length === cur.length ? prev : writePinnedTabs(prev, kept);
        });
      }
    }
  }, [everything, syncedPinned, hasRegister, pinned, canPruneMissing]);

  const tabs = useMemo(() => {
    const byId = new Map(notes.map((n) => [n.id, n]));
    return allIds.map((id) => byId.get(id)).filter((n): n is LocalNote => !!n && n.trashed === 0);
  }, [allIds, notes]);

  /** Adds the ids that have no tab yet, in order, at the end. */
  const addTabs = useCallback((add: string[]) => {
    const { pinnedIds: curPinned } = latestRef.current;
    setState((prev) => {
      const fresh = add.filter((id, i) => !curPinned.has(id) && !prev.ids.includes(id) && add.indexOf(id) === i);
      return fresh.length === 0 ? prev : { ...prev, ids: [...prev.ids, ...fresh] };
    });
  }, []);

  /** Closes the named tabs. A pinned tab is skipped, so "close all" and "close
   *  others" can pass every id and still leave the pinned group alone. */
  const closeTabs = useCallback((close: string[]) => {
    const { pinnedIds: curPinned } = latestRef.current;
    setState((prev) => {
      const ids = prev.ids.filter((id) => curPinned.has(id) || prev.pinned.includes(id) || !close.includes(id));
      const kept = new Set([...curPinned, ...prev.pinned, ...ids]);
      const nextPair = prev.pair && kept.has(prev.pair.left) && kept.has(prev.pair.right) ? prev.pair : null;
      return { ...prev, ids, pair: nextPair };
    });
  }, []);

  /** The tab of `prev` changes to `next`, the way a browser tab changes
   *  page. With no `prev` (it is pinned, or has no tab) `next` gets a tab of
   *  its own at the end. An item that has a tab keeps it. */
  const followTab = useCallback((prev: string | null, next: string) => {
    const { pinnedIds: curPinned } = latestRef.current;
    if (curPinned.has(next)) return;
    setState((s) => {
      if (s.ids.includes(next)) return s;
      if (prev !== null && s.ids.includes(prev) && !curPinned.has(prev) && !s.pinned.includes(prev)) {
        // A side that showed `prev` shows `next` now, as its tab does.
        const nextPair = s.pair && { left: s.pair.left === prev ? next : s.pair.left, right: s.pair.right === prev ? next : s.pair.right };
        return { ...s, ids: s.ids.map((x) => (x === prev ? next : x)), pair: nextPair };
      }
      return { ...s, ids: [...s.ids, next] };
    });
  }, []);

  /** Pinning moves a tab to the end of the pinned group, unpinning to the
   *  start of the rest, which is where a browser puts it. */
  const setPinned = useCallback((id: string, pin: boolean) => {
    const { pinned: curPinned, pinnedIds: curPinnedSet, tabIds: curTabIds, syncedPinned: synced } = latestRef.current;
    if (!curTabIds.has(id) || curPinnedSet.has(id) === pin) return;
    if (pin && curPinned.length >= MAX_PINNED_TABS) return;
    if (synced) {
      synced.onChange((prev) => {
        const cur = hasPinnedTabsRegister(prev) ? readPinnedTabs(prev) : curPinned;
        if (pin) {
          if (cur.includes(id) || cur.length >= MAX_PINNED_TABS) return prev;
          return writePinnedTabs(prev, [...cur, id]);
        }
        if (!cur.includes(id)) return prev;
        return writePinnedTabs(prev, cur.filter((x) => x !== id));
      });
      setState((prev) => {
        const legacy = new Set(prev.pinned);
        const rest = prev.ids.filter((x) => x !== id && !legacy.has(x) && !curPinnedSet.has(x));
        return { ...prev, ids: pin ? rest : [id, ...rest], pinned: [] };
      });
      return;
    }
    setState((prev) => {
      if (!prev.ids.includes(id) || prev.pinned.includes(id) === pin) return prev;
      const nextPinned = pin ? [...prev.pinned, id] : prev.pinned.filter((x) => x !== id);
      const rest = prev.ids.filter((x) => x !== id && !nextPinned.includes(x));
      return { ...prev, ids: pin ? [...nextPinned, ...rest] : [...nextPinned, id, ...rest], pinned: nextPinned };
    });
  }, []);

  /** A move never crosses the pinned boundary: the result is re-sorted into
   *  the two groups, so a tab dropped on the wrong side stays in its own. */
  const moveTab = useCallback((id: string, beforeId: string | null) => {
    const { pinned: curPinned, pinnedIds: curPinnedSet, tabIds: curTabIds, syncedPinned: synced } = latestRef.current;
    if (!curTabIds.has(id)) return;
    if (synced && curPinnedSet.has(id)) {
      synced.onChange((prev) => {
        const cur = hasPinnedTabsRegister(prev) ? readPinnedTabs(prev) : curPinned;
        if (!cur.includes(id)) return prev;
        const without = cur.filter((x) => x !== id);
        const at = beforeId !== null && without.includes(beforeId) ? without.indexOf(beforeId) : without.length;
        const next = [...without.slice(0, at), id, ...without.slice(at)];
        return next.every((x, i) => x === cur[i]) ? prev : writePinnedTabs(prev, next);
      });
      return;
    }
    setState((prev) => {
      if (synced) {
        const rest = prev.ids.filter((x) => !curPinnedSet.has(x));
        if (!rest.includes(id)) return prev;
        const without = rest.filter((x) => x !== id);
        const at = beforeId === null ? without.length : curPinnedSet.has(beforeId) ? 0 : without.indexOf(beforeId);
        if (at < 0) return prev;
        const next = [...without.slice(0, at), id, ...without.slice(at)];
        return next.every((x, i) => x === rest[i]) ? prev : { ...prev, ids: next };
      }
      const rest = prev.ids.filter((x) => x !== id);
      const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
      if (!prev.ids.includes(id) || at < 0) return prev;
      const ids = [...rest.slice(0, at), id, ...rest.slice(at)];
      const nextPinned = ids.filter((x) => prev.pinned.includes(x));
      return {
        ...prev,
        ids: [...nextPinned, ...ids.filter((x) => !nextPinned.includes(x))],
        pinned: nextPinned,
      };
    });
  }, []);

  /** Sets or clears the pair. Both items get a tab here, so a pair never
   *  names an item without one. */
  const setPair = useCallback((nextPair: SidePair | null) => {
    const { pinnedIds: curPinned } = latestRef.current;
    setState((prev) => {
      if (nextPair === null) return prev.pair === null ? prev : { ...prev, pair: null };
      if (nextPair.left === nextPair.right) return prev;
      if (prev.pair?.left === nextPair.left && prev.pair.right === nextPair.right) return prev;
      const missing = [nextPair.left, nextPair.right].filter((id) => !curPinned.has(id) && !prev.ids.includes(id));
      return { ...prev, ids: [...prev.ids, ...missing], pair: nextPair };
    });
  }, []);

  return { tabs, tabIds, pinnedIds, pair, setPair, addTabs, followTab, closeTabs, setPinned, moveTab };
}

/**
 * "Open items in tabs": the open item always has a tab, and the tab you are
 * on follows the item you open, the way a browser tab follows a link. A
 * pinned tab keeps its item, so the next item opens in a new tab. On by
 * default, per device like the tabs. The settings window can be a second window, so the store
 * listens to `storage` as well as to its own change event.
 * Spec: docs/internal/specs/note-tabs.md (section 2)
 */
const OPEN_IN_TABS_KEY = 'privacynotes.ui.openItemsInTabs';
const OPEN_IN_TABS_EVENT = 'pn:open-items-in-tabs';

/** On unless this device turned it off: only an explicit '0' is off. */
function readOpenInTabs(): boolean {
  try { return localStorage.getItem(OPEN_IN_TABS_KEY) !== '0'; } catch { return true; }
}

function subscribeOpenInTabs(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => { if (e.key === OPEN_IN_TABS_KEY) onChange(); };
  window.addEventListener('storage', onStorage);
  window.addEventListener(OPEN_IN_TABS_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(OPEN_IN_TABS_EVENT, onChange);
  };
}

export function useOpenItemsInTabs(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribeOpenInTabs, readOpenInTabs, () => true);
  const set = useCallback((next: boolean) => {
    try { localStorage.setItem(OPEN_IN_TABS_KEY, next ? '1' : '0'); } catch { /* storage unavailable */ }
    window.dispatchEvent(new Event(OPEN_IN_TABS_EVENT));
  }, []);
  return [on, set];
}

/**
 * Whether this window has room for the strip: the md step, where the editor
 * becomes a pane of its own (`mdScreen` in NotesView.tsx reads the same query).
 * The Appearance row and its settings-search entry both ask this, so a phone
 * is offered no switch for a strip it never draws.
 */
const PANE_QUERY = '(min-width: 768px)';

export function tabsFit(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(PANE_QUERY).matches;
}

function subscribeTabsFit(onChange: () => void): () => void {
  const mq = window.matchMedia(PANE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

export function useTabsFit(): boolean {
  return useSyncExternalStore(subscribeTabsFit, tabsFit, () => false);
}
