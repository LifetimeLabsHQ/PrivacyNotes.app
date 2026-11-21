import { hasPin } from './pin';
import { proUnlocked } from './demo';
import type { LocalNote } from './db';
import { traitsOf } from './noteTypes';

/**
 * Which upgrade pitch the modal opens on. Wider than the four triggers the
 * guards below raise, because it is the same prop the "..." menu declares
 * and both surfaces are wired from one object.
 */
type NoteUpgradeTrigger = 'lock' | 'protect' | 'history' | 'devices' | 'folders' | 'alerts' | null;

export type NoteActionGuardDeps = {
  note: LocalNote;
  isPro: boolean;
  onSetLocked: (locked: boolean) => void;
  onSetPinProtected: (protectedOn: boolean) => void;
  /** Turning protection OFF passes the same check as opening the note. The
   *  caller opens the gate, which does the asking and the removing. */
  onRequestRemoveProtection: () => void;
  onOpenUpgrade: (trigger: NoteUpgradeTrigger) => void;
  onOpenHistory?: () => void;
  /** The note has text a sync pull replaced on this device (replacedCopies.ts).
   *  Its History window then opens on every plan, with those copies only when
   *  the server history is not unlocked. */
  localHistory?: boolean;
  /** Open Security > PIN so the user can set a PIN before protecting a note. */
  onSetPin?: () => void;
  onMoveToFolder?: () => void;
  /**
   * Dismiss the surface these buttons live on, where a flow replaces it.
   * The "..." menu closes itself; the header row passes a no-op, because
   * the row stays on screen behind the modal it opens.
   */
  onClose: () => void;
};

/**
 * The "Require PIN to view" box of an item form (login, card, SSH key,
 * contact, bookmark), as the handler the form is given.
 *
 * Ticking the box is a plain write. Unticking it takes protection off, and
 * that is the boundary the guards below keep: it goes to the same request the
 * menu and the header icon make, which verifies first. The form is on screen
 * only while the item's gate is open, so without this the box was a way to
 * take the protection off for good, on every device, with no PIN.
 * Test: tests/protectionBox.test.ts, and the mounts in tests/lockGateWiring.test.ts
 */
export function protectionFromForm(d: {
  onProtect: (id: string) => void;
  onRequestRemoveProtection: (id: string) => void;
}): (id: string, pinProtected: boolean) => void {
  return (id, pinProtected) => {
    if (pinProtected) d.onProtect(id);
    else d.onRequestRemoveProtection(id);
  };
}

/**
 * The Pro and PIN checks in front of four per-note actions.
 *
 * Two surfaces run them: the "..." options menu and the editor header's
 * icon row. They must behave identically, and the PIN check is a security
 * boundary rather than a nicety, so there is one copy of it.
 *
 * Every gate here is `proUnlocked`, so the public demo can exercise all
 * four - note history included, via its local demo snapshot path
 * (noteVersions.ts).
 * Spec: docs/internal/pro-features.md (of these four, only history is server-enforced via RLS)
 */
export function noteActionGuards(d: NoteActionGuardDeps) {
  const unlocked = proUnlocked(d.isPro);

  return {
    toggleLock() {
      if (!unlocked) {
        d.onOpenUpgrade('lock');
        return;
      }
      d.onSetLocked(d.note.locked !== 1);
    },

    toggleProtect() {
      if (!unlocked) {
        d.onOpenUpgrade('protect');
        return;
      }
      if (d.note.pinProtected === 1) {
        d.onRequestRemoveProtection();
        return;
      }
      // There is nothing to protect a note with until a PIN exists.
      if (!hasPin()) {
        d.onClose();
        d.onSetPin?.();
        return;
      }
      d.onSetPinProtected(true);
    },

    openHistory() {
      if (!unlocked && !d.localHistory) {
        d.onOpenUpgrade('history');
        return;
      }
      d.onOpenHistory?.();
    },

    moveToFolder() {
      if (!unlocked) {
        d.onOpenUpgrade('folders');
        return;
      }
      d.onMoveToFolder?.();
      d.onClose();
    },
  };
}

/**
 * Whether Translate notes can read a note: its own Markdown, so not a vault
 * item, a drawing or another item with no text body, and not a read-only or
 * PIN-guarded note.
 * Spec: docs/internal/plans/plugins.md (section 6.5)
 */
export function canTranslate(n: LocalNote): boolean {
  return traitsOf(n.type).translate && n.locked !== 1 && n.pinProtected !== 1 && n.body.trim() !== '';
}

export type BulkActionGuardDeps = {
  isPro: boolean;
  /** True when every item in the selection already has the flag on. It is
   *  what decides the direction, the same way one note's own flag does. */
  allLocked: boolean;
  allProtected: boolean;
  onSetLocked: (locked: boolean) => void;
  onSetPinProtected: (protectedOn: boolean) => void;
  /** Taking protection off a selection asks for the PIN once, then applies
   *  it to all of them. A single note gets its own screen instead. */
  onRequestRemoveProtection: () => void;
  onOpenUpgrade: (trigger: NoteUpgradeTrigger) => void;
  onSetPin?: () => void;
  onClose: () => void;
};

/**
 * The same two gates for a whole selection.
 *
 * It sits beside its single-note twin on purpose: the checks are a Pro
 * boundary and a PIN boundary, and a reader comparing the two functions
 * must be able to see at a glance that they ask for the same things in
 * the same order. A selection that could protect or unlock items the
 * single path refuses would be a hole, not a shortcut.
 * Spec: docs/internal/pro-features.md
 */
export function bulkActionGuards(d: BulkActionGuardDeps) {
  const unlocked = proUnlocked(d.isPro);

  return {
    toggleLock() {
      if (!unlocked) {
        d.onOpenUpgrade('lock');
        return;
      }
      d.onSetLocked(!d.allLocked);
    },

    toggleProtect() {
      if (!unlocked) {
        d.onOpenUpgrade('protect');
        return;
      }
      if (d.allProtected) {
        d.onRequestRemoveProtection();
        return;
      }
      // There is nothing to protect a note with until a PIN exists.
      if (!hasPin()) {
        d.onClose();
        d.onSetPin?.();
        return;
      }
      d.onSetPinProtected(true);
    },
  };
}
