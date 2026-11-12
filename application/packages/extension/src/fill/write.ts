/**
 * Writing one value into one field so that the page takes it as typed: the
 * events a keyboard makes, the value through the browser's own setter, then
 * `input` and `change`. It runs in the extension's isolated world, where the
 * setter is the browser's, whatever the page did to its own copy.
 *
 * It leaves nothing in the page but the value: no listener, no attribute, no
 * class.
 * Spec: docs/internal/plans/click-to-fill.md (section 4.6)
 */
import { isUsable, isVisible } from './read';

// Spec: docs/internal/plans/click-to-fill.md (section 4.6, step 11)
const MARK_MS = 600;

export type WriteResult = 'written' | 'same' | 'readonly' | 'tooLong' | 'refused';

const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const bubbles = { bubbles: true, cancelable: true, composed: true };

function setValue(el: HTMLInputElement, value: string): void {
  const view = el.ownerDocument.defaultView;
  const setter = view && Object.getOwnPropertyDescriptor((view as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function send(el: HTMLInputElement, event: Event): void {
  el.dispatchEvent(event);
}

function typed(el: HTMLInputElement, value: string): void {
  send(el, new KeyboardEvent('keydown', bubbles));
  send(el, new InputEvent('beforeinput', { ...bubbles, inputType: 'insertText', data: value }));
  send(el, new KeyboardEvent('keypress', bubbles));
  setValue(el, value);
  send(el, new InputEvent('input', { ...bubbles, cancelable: false, inputType: 'insertText', data: value }));
  send(el, new KeyboardEvent('keyup', bubbles));
  send(el, new Event('change', { bubbles: true, composed: true }));
}

/** A soft ring for a moment, so the person sees what was filled. An
 *  animation, not a style: nothing stays on the element. */
function mark(el: HTMLInputElement): void {
  const view = el.ownerDocument.defaultView;
  if (typeof el.animate !== 'function' || view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  try {
    el.animate(
      [{ boxShadow: '0 0 0 3px rgba(59, 130, 246, 0.55)' }, { boxShadow: '0 0 0 3px rgba(59, 130, 246, 0)' }],
      { duration: MARK_MS, easing: 'ease-out' },
    );
  } catch {
    // A page that turned animations off loses only the ring.
  }
}

/** Focus the field. While the extension's window is open the page may get
 *  no focus events from the browser; then they are made by hand, so a page
 *  that waits for them still wakes up. */
export function focusField(el: HTMLInputElement): void {
  let real = false;
  const heard = (): void => {
    real = true;
  };
  el.addEventListener('focus', heard, { once: true });
  el.focus({ preventScroll: true });
  el.removeEventListener('focus', heard);
  if (real) return;
  send(el, new FocusEvent('focusin', { bubbles: true, composed: true }));
  send(el, new FocusEvent('focus', { composed: true }));
}

/**
 * Write `value` into `el`. A password is never cut to fit, a field that a
 * person cannot see or type into is never written, and a field that already
 * holds the value is left alone.
 */
export async function writeField(el: HTMLInputElement, value: string): Promise<WriteResult> {
  if (!el.isConnected || !isUsable(el)) return 'readonly';
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  if (!isVisible(el).visible) return 'readonly';
  if (el.value === value) return 'same';
  if (el.maxLength >= 0 && el.maxLength < value.length) return 'tooLong';
  if (el.type === 'number' && !/^\d+$/.test(value)) return 'refused';

  focusField(el);
  // One empty turn: a page built on promises settles its focus handlers.
  await Promise.resolve();
  typed(el, value);
  if (el.value !== value) {
    // A field that formats what it gets on a timer.
    await turn();
    if (el.value !== value) {
      setValue(el, value);
      send(el, new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      send(el, new Event('change', { bubbles: true, composed: true }));
    }
    if (el.value !== value) return 'refused';
  }
  mark(el);
  return 'written';
}

/**
 * A code in one box for each digit. Most such fields take a paste of the
 * whole code on the first box and spread it themselves; a box that then holds
 * the wrong digit is written on its own.
 */
export async function writeBoxes(boxes: readonly HTMLInputElement[], code: string): Promise<WriteResult> {
  const first = boxes[0];
  if (!first || boxes.length !== code.length) return 'refused';
  if (boxes.some((b) => !b.isConnected || !isUsable(b))) return 'readonly';
  first.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  if (boxes.some((b) => !isVisible(b).visible)) return 'readonly';
  if (boxes.every((b, i) => b.value === code[i])) return 'same';

  focusField(first);
  await Promise.resolve();
  if (typeof ClipboardEvent === 'function' && typeof DataTransfer === 'function') {
    try {
      const data = new DataTransfer();
      data.setData('text/plain', code);
      send(first, new ClipboardEvent('paste', { ...bubbles, clipboardData: data }));
      await turn();
    } catch {
      // A browser that cannot build the event: every box is written below.
    }
  }
  for (const [i, box] of boxes.entries()) {
    const digit = code[i] ?? '';
    if (box.value === digit) continue;
    focusField(box);
    typed(box, digit);
    await turn();
  }
  if (!boxes.every((b, i) => b.value === code[i])) return 'refused';
  for (const box of boxes) mark(box);
  return 'written';
}
