/**
 * Ninja from any app (GitHub #694), the main window's half. The global key
 * shows the small `ninja` window (ninja.rs), and Rust tells this window
 * (`pn-ninja-open`). NotesView then opens its own Ninja with `remote`: the
 * overlay is invisible and its dialog comes here. Every change of that dialog
 * goes to the box as markup (`pn-ninja-frame`), and what the person does in
 * the box comes back: the field's value, the keys Ninja reads, a click or a
 * pointer move. Ninja runs here unchanged, with the notes it already has; the
 * box holds no note and no key.
 *
 * Only the keys Ninja itself reads are applied, so no app shortcut runs in a
 * window nobody sees. A close that comes from Escape or from the box's close
 * button is a dismiss, and the app in front gets the focus back; any other
 * close is a row that ran, and the main window comes forward.
 * Spec: docs/internal/plans/ninja-anywhere-694.md (section 3)
 */

import { nodeAt } from './ninjaMorph';
import type { QuickNoteAnswer, QuickNoteInput } from './quickNoteQueue';

export interface NinjaFrame {
  /** No Ninja here to show: the lock screen, sign-in, or a start not done. */
  locked?: boolean;
  /** Locked, and a quick note can still be sealed for the next unlock: the
   *  box opens in note mode. Spec: docs/internal/plans/quick-note-694.md (section 5.2 step 2) */
  queue?: boolean;
  html?: string;
  value?: string;
  start?: number;
  end?: number;
  /** The last input the box sent that this frame has seen. */
  ack?: number;
}
export interface NinjaInput { value: string; start: number; end: number; seq: number }
export interface NinjaKey { key: string; code: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; start: number; end: number }
export interface NinjaPointer { kind: 'click' | 'move'; path: number[]; x: number; y: number; altKey: boolean; shiftKey: boolean }
/** A note from the box's note mode, and the answer: never a note back. */
export interface NinjaNote extends QuickNoteInput { seq: number }
export interface NinjaNoteResult { seq: number; status: QuickNoteAnswer }

/**
 * Whether a press here moves Ninja: anything that is not a control. One rule
 * for the switcher in the app (QuickSwitcher.tsx) and the box above other apps
 * (NinjaWindow.tsx); neither keeps the place for the next open.
 * Spec: docs/internal/plans/ninja-anywhere-694.md (N14)
 */
export function isNinjaDragHandle(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest('input, button, a, [role="option"]');
}

/** The keys the box sends. Spec: docs/internal/plans/ninja-anywhere-694.md (section 3) */
export const NINJA_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'Escape', 'Backspace']);

interface Host {
  /** Open Ninja in remote mode. */
  open: () => void;
  /** Close it with no action: the box is gone already. */
  close: () => void;
  /** Save a note from the box's note mode at once (the app is unlocked). */
  saveNote: (input: QuickNoteInput) => Promise<QuickNoteAnswer>;
}

let host: Host | null = null;
let dialog: HTMLElement | null = null;
let observer: MutationObserver | null = null;
let ack = 0;
/** Set while an Escape or a click in the box's header runs: a close then is a dismiss. */
let dismissing = false;
/** Set when "Write a note" hands the box over to its note mode: the close that follows keeps the box. */
let handingOff = false;
let queued = false;

async function toBox(event: string, payload: unknown): Promise<void> {
  try {
    const { emitTo } = await import('@tauri-apps/api/event');
    await emitTo('ninja', event, payload);
  } catch {
    /* No box window: nothing to tell. */
  }
}

/** What the box shows when no Ninja runs here: note mode when a quick note can wait for the unlock. */
async function lockedFrame(): Promise<NinjaFrame> {
  const queue = await import('./quickNoteQueue').then((q) => q.canQueue(), () => false);
  return { locked: true, queue };
}

function field(): HTMLInputElement | null {
  return dialog?.querySelector('input') ?? null;
}

function sendFrame(): void {
  queued = false;
  if (!dialog) return;
  const input = field();
  const frame: NinjaFrame = {
    html: dialog.outerHTML,
    value: input?.value ?? '',
    start: input?.selectionStart ?? 0,
    end: input?.selectionEnd ?? 0,
    ack,
  };
  void toBox('pn-ninja-frame', frame);
}

/** One frame per batch of changes: a MutationObserver runs as a microtask, and timers are slow in a hidden window. */
function queueFrame(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(sendFrame);
}

/** NotesView, while it is mounted: the lock screen and sign-in have no Ninja to show. */
export function registerNinjaHost(next: Host): () => void {
  host = next;
  return () => {
    if (host !== next) return;
    host = null;
    if (dialog) void lockedFrame().then((frame) => toBox('pn-ninja-frame', frame));
  };
}

/** The `remote` ref of QuickSwitcher: its dialog, or null when it closes. */
export function attachRemoteNinja(el: HTMLElement | null): void {
  observer?.disconnect();
  observer = null;
  dialog = el;
  if (!el) return;
  observer = new MutationObserver(queueFrame);
  observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  queueFrame();
}

/** NotesView's onClose for a remote Ninja: a row ran, or the person dismissed it. */
export function remoteNinjaClosed(): void {
  if (handingOff) {
    handingOff = false;
    return;
  }
  const reveal = !dismissing;
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('ninja_dismiss', { reveal }))
    .catch(() => {});
}

/**
 * "Write a note" ran in the hidden Ninja: the box changes to its note mode
 * with the text typed, and stays on screen. Spec: docs/internal/plans/quick-note-694.md (section 5.2 step 1)
 */
export function openBoxNoteMode(title: string): void {
  handingOff = true;
  void toBox('pn-ninja-note-mode', { title });
}

/** A note from the box: saved at once while unlocked, sealed and kept while locked. */
async function saveFromBox(input: unknown): Promise<NinjaNoteResult | null> {
  const n = input as Partial<NinjaNote> | null;
  if (!n || typeof n.seq !== 'number' || typeof n.title !== 'string' || typeof n.markdown !== 'string') return null;
  const note = { title: n.title, markdown: n.markdown };
  try {
    const status = host ? await host.saveNote(note) : await import('./quickNoteQueue').then((q) => q.queueQuickNote(note));
    return { seq: n.seq, status };
  } catch (err) {
    console.warn('[ninja] quick note failed:', err instanceof Error ? err.message : 'unknown');
    return { seq: n.seq, status: 'failed' };
  }
}

const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

function applyInput({ value, start, end, seq }: NinjaInput): void {
  const input = field();
  if (!input) return;
  ack = seq;
  if (input.value !== value) {
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.setSelectionRange(start, end);
  queueFrame();
}

function applyKey(k: NinjaKey): void {
  const input = field();
  if (!input || !NINJA_KEYS.has(k.key)) return;
  input.setSelectionRange(k.start, k.end);
  dismissing = k.key === 'Escape';
  try {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k.key, code: k.code, shiftKey: k.shiftKey, altKey: k.altKey, ctrlKey: k.ctrlKey, metaKey: k.metaKey, bubbles: true, cancelable: true }));
  } finally {
    dismissing = false;
  }
  queueFrame();
}

function applyPointer(p: NinjaPointer): void {
  if (!dialog) return;
  const target = nodeAt(dialog, p.path);
  if (!target) return;
  const init = { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, altKey: p.altKey, shiftKey: p.shiftKey };
  if (p.kind === 'move') {
    target.dispatchEvent(new MouseEvent('mouseover', init));
    target.dispatchEvent(new MouseEvent('mousemove', init));
    return;
  }
  // The header holds the field and the close button: a close from there is a dismiss.
  dismissing = dialog.firstElementChild?.contains(target) ?? false;
  try {
    target.dispatchEvent(new MouseEvent('click', init));
  } finally {
    dismissing = false;
  }
}

let started = false;

/** At start, in the main window of a desktop app. */
export function startNinjaHost(): void {
  if (started) return;
  started = true;
  void import('@tauri-apps/api/event')
    .then(({ listen }) => Promise.all([
      listen('pn-ninja-open', () => {
        if (host) host.open();
        else void lockedFrame().then((frame) => toBox('pn-ninja-frame', frame));
      }),
      listen('pn-ninja-close', () => {
        if (dialog) host?.close();
      }),
      // The box asks when it loads or shows: an open before it loaded went nowhere.
      listen('pn-ninja-sync', () => {
        if (dialog) queueFrame();
        else if (!host) void lockedFrame().then((frame) => toBox('pn-ninja-frame', frame));
      }),
      listen('pn-ninja-note', (e) => {
        void saveFromBox(e.payload).then((result) => (result ? toBox('pn-ninja-note-result', result) : undefined));
      }),
      listen<NinjaInput>('pn-ninja-input', (e) => applyInput(e.payload)),
      listen<NinjaKey>('pn-ninja-key', (e) => applyKey(e.payload)),
      listen<NinjaPointer>('pn-ninja-pointer', (e) => applyPointer(e.payload)),
    ]))
    .catch(() => {});
}
