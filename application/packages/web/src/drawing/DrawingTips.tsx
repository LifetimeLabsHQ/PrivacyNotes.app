/**
 * The app's tooltips over the drawing canvas, in place of the browser's
 * `title` tips Excalidraw puts on its buttons and its own tooltip box: the
 * dark pill every tooltip of the app wears (`TIP_SKIN`), with the keys in
 * the app's own notation ("⇧⌘G" on a Mac, "Ctrl+Shift+G" elsewhere), as
 * `HoverLabel` shows them.
 *
 * Excalidraw writes a title as the label, an em dash and the keys, the
 * alternatives joined by " or " and the keys of one press by "+" ("Rectangle,
 * dash, R or 2"; "Group, dash, Cmd+G").
 * The hint is taken off the element on first hover (`data-pn-tip` keeps it),
 * so the browser's own tip never shows beside ours.
 * Spec: docs/internal/specs/drawing.md (section 0)
 */
import { useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { TIP_SKIN } from '../HoverLabel';
import { bindingText, type KeyBinding } from '../commandKeys';
import { KEY_OS } from '../shortcutMatch';

/** The dash Excalidraw puts between a title's label and its keys (house
 *  text never writes the character itself). */
const EM_DASH = String.fromCharCode(0x2014);

/** One of Excalidraw's key texts ("Cmd+Shift+G", "R", "Enter") as a binding. */
function bindingOf(text: string): KeyBinding | null {
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const b: { key: string; mod?: true; alt?: true; shift?: true } = { key: key.length === 1 ? key.toLowerCase() : key };
  for (const p of parts) {
    if (/^(cmd|ctrl|ctrlorcmd)$/i.test(p)) b.mod = true;
    else if (/^(alt|option)$/i.test(p)) b.alt = true;
    else if (/^shift$/i.test(p)) b.shift = true;
    else return null;
  }
  return b;
}

/** A title of Excalidraw's as the tooltip's label and keys ('' for none). */
export function tipOf(title: string): { label: string; keys: string } {
  const at = title.lastIndexOf(` ${EM_DASH} `);
  if (at < 0) return { label: title.trim(), keys: '' };
  const label = title.slice(0, at).trim();
  const alternatives = title.slice(at + 3).split(/\s+or\s+/i).map((alt) => bindingOf(alt));
  if (alternatives.some((b) => !b)) return { label: title.trim(), keys: '' };
  return { label, keys: alternatives.map((b) => bindingText(b!, KEY_OS)).join(' / ') };
}

type Tip = { label: string; keys: string; x: number; y: number };

/** The handlers for the element around the canvas, and the tip to render. */
export function useDrawingTips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const onPointerOver = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const target = e.target instanceof Element ? e.target : null;
    const host = target?.closest<HTMLElement>('.excalidraw [title], .excalidraw [data-pn-tip], .excalidraw [aria-label]');
    if (!host || host.matches('canvas')) {
      setTip(null);
      return;
    }
    const title = host.getAttribute('title');
    if (title) {
      host.dataset.pnTip = title;
      host.removeAttribute('title');
    }
    const text = host.dataset.pnTip ?? host.getAttribute('aria-label') ?? '';
    if (!text) return;
    const r = host.getBoundingClientRect();
    setTip({ ...tipOf(text), x: r.left + r.width / 2, y: r.bottom + 6 });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  const view = tip && (
    <div
      role="tooltip"
      className={`pn-tip pointer-events-none fixed z-[70] -translate-x-1/2 flex items-center gap-2 whitespace-nowrap ${TIP_SKIN} [@media(hover:none)]:hidden`}
      style={{ left: tip.x, top: tip.y }}
    >
      <span>{tip.label}</span>
      {/* rtl-ok: a key sequence never reorders */}
      {tip.keys && <span dir="ltr" /* theme-ok: on the dark tooltip pill */ className="text-neutral-400">{tip.keys}</span>}
    </div>
  );
  return { onPointerOver, onPointerLeave: hide, onPointerDown: hide, view };
}
