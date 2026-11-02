import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readBarPositionPref, writeBarPositionPref, type BarPosition } from '../editorPrefs';
import {
  FORMAT_BAR,
  readFormatBarSetting,
  writeFormatBarSetting,
  type BarModel,
  type BarRegister,
  type FormatBarSetting,
  type ResolvedFormatBar,
} from '../formatBar';
import { DRAWING_BAR, DRAWING_BAR_LOOK } from '../drawing/drawingBar';
import { requestToolbarTab } from '../toolbarSettingsTab';
import type { FormatBarContextValue } from '../formatBarContext';
import type { FormatBarBoardProps } from '../FormatBarBoard';
import type { UserSettings } from '../userSettings';

/** One bar's arrangement: what the bar draws, and the board's props (the
 *  free draft, the save to its register). */
function useArrangement({ register, model, formatBar, mutateSettings, locked, onOpenUpgrade }: {
  register: BarRegister;
  model: BarModel;
  formatBar: FormatBarSetting;
  mutateSettings: (updater: (prev: UserSettings) => UserSettings) => void;
  locked: boolean;
  onOpenUpgrade: () => void;
}) {
  const saved = useMemo(() => model.resolve(readFormatBarSetting(formatBar, register)), [formatBar, register, model]);
  const [draft, setDraft] = useState<ResolvedFormatBar | null>(null);
  // Set by "Keep this layout": leaving the tab for the upgrade window keeps
  // the draft, any other way out drops it.
  const handoff = useRef(false);

  const save = useCallback(
    (move: (current: ResolvedFormatBar) => ResolvedFormatBar | null) => {
      mutateSettings((prev) => {
        const current = model.resolve(readFormatBarSetting(prev.formatBar, register));
        const next = writeFormatBarSetting(prev.formatBar, move(current), register, model);
        return next === prev.formatBar ? prev : { ...prev, formatBar: next };
      });
    },
    [mutateSettings, register, model],
  );

  const onUpdate = useCallback(
    (move: (current: ResolvedFormatBar) => ResolvedFormatBar | null) => {
      if (!locked) { save(move); return; }
      setDraft((current) => move(current ?? saved) ?? model.stock());
    },
    [locked, save, saved, model],
  );

  // The purchase landed while a draft was waiting: it becomes the layout.
  useEffect(() => {
    if (locked || !draft) return;
    save(() => draft);
    setDraft(null);
  }, [locked, draft, save]);

  const onKeep = useCallback(() => {
    handoff.current = true;
    onOpenUpgrade();
  }, [onOpenUpgrade]);
  const onDiscard = useCallback(() => setDraft(null), []);
  // The drop waits a microtask and needs no board mounted, so a remount
  // (development mode mounts every effect twice) never counts as leaving.
  const mounted = useRef(0);
  const onEnter = useCallback(() => {
    mounted.current += 1;
    handoff.current = false;
  }, []);
  const onLeave = useCallback(() => {
    mounted.current -= 1;
    queueMicrotask(() => {
      if (mounted.current === 0 && !handoff.current) setDraft(null);
    });
  }, []);

  const board = useMemo(
    () => ({
      layout: locked && draft ? draft : saved,
      onUpdate,
      locked,
      previewing: locked && draft !== null,
      onKeep,
      onDiscard,
      onEnter,
      onLeave,
    }),
    [locked, draft, saved, onUpdate, onKeep, onDiscard, onEnter, onLeave],
  );
  return { saved, board };
}

/** The drawing toolbar's rules and looks, for its board. */
const DRAWING_BOARD = { model: DRAWING_BAR, look: DRAWING_BAR_LOOK, hiddenNote: 'notes:drawing.bar.hiddenNote' };

/**
 * The format bar wiring NotesView owns: what every toolbar under it draws,
 * the door from the toolbar's gear, and the props of the board in
 * Settings > Format bar. Every move is applied to the arrangement in the
 * settings cache at the moment of the write, never to the one the board last
 * drew, so two quick moves cannot undo each other.
 *
 * Arranging is Pro. A free account still uses the whole board, on a draft:
 * the editor's bar keeps the saved layout, leaving the tab drops the draft,
 * and "Keep this layout" hands it to the upgrade window. When the account
 * turns Pro the draft is saved, so the arrangement is not lost.
 * The drawing canvas's toolbar is a second bar on the same rules, in its
 * own register (`drawing`), arranged on the tab's Drawing side.
 * Spec: docs/internal/specs/format-bar.md
 */
export function useFormatBar({
  formatBar,
  mutateSettings,
  onOpenSettings,
  locked,
  onOpenUpgrade,
}: {
  formatBar: FormatBarSetting;
  mutateSettings: (updater: (prev: UserSettings) => UserSettings) => void;
  /** Opens Settings > Format bar. */
  onOpenSettings: () => void;
  /** A free account: moves change a draft, never the saved layout. */
  locked: boolean;
  /** Closes Settings and opens the upgrade window on the toolbar pitch. */
  onOpenUpgrade: () => void;
}): { formatBarContext: FormatBarContextValue; formatBarBoard: FormatBarBoardProps } {
  // Where the bar sits, top or bottom. Device-local and free; the drawing
  // toolbar sits where the format bar does.
  const [position, setPositionState] = useState<BarPosition>(readBarPositionPref);
  const setPosition = useCallback((next: BarPosition) => {
    writeBarPositionPref(next);
    setPositionState(next);
  }, []);
  const text = useArrangement({ register: 'layout', model: FORMAT_BAR, formatBar, mutateSettings, locked, onOpenUpgrade });
  const drawing = useArrangement({ register: 'drawing', model: DRAWING_BAR, formatBar, mutateSettings, locked, onOpenUpgrade });

  // Each bar's gear opens Settings > Toolbar on its own side.
  const onCustomize = useCallback(() => {
    requestToolbarTab('typing');
    onOpenSettings();
  }, [onOpenSettings]);
  const onCustomizeDrawing = useCallback(() => {
    requestToolbarTab('drawing');
    onOpenSettings();
  }, [onOpenSettings]);
  const formatBarContext = useMemo(
    () => ({ layout: text.saved, drawing: drawing.saved, onCustomize, onCustomizeDrawing, position }),
    [text.saved, drawing.saved, onCustomize, onCustomizeDrawing, position],
  );

  const formatBarBoard = useMemo(
    () => ({
      ...text.board,
      position,
      onPositionChange: setPosition,
      drawing: { ...drawing.board, bar: DRAWING_BOARD },
    }),
    [text.board, drawing.board, position, setPosition],
  );

  return { formatBarContext, formatBarBoard };
}
