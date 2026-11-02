/**
 * What the extension reads from a page: injected into the tab only when the
 * person clips (scripting.executeScript), never declared for every page. It
 * returns strings and leaves nothing behind: no listener, no attribute, no
 * change to the page.
 *
 * The HTML is taken from a clone with the hidden elements and every form
 * field removed, so what a clip can hold is what the page shows, and never a
 * value someone typed into a field.
 * Spec: docs/internal/plans/browser-extension-build.md (decision E7); docs/internal/plans/web-clipper.md (section 20, H5)
 */
export interface CapturedPage {
  url: string;
  title: string;
  html: string;
  selectionHtml: string;
}

/** Runs in the page. Self-contained: executeScript serializes it. */
export function capturePage(): CapturedPage {
  const hidden = new Set<Element>();
  for (const el of Array.from(document.body?.querySelectorAll('*') ?? [])) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') hidden.add(el);
  }
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  // Walk the original and the clone together; the hidden set stays in this
  // script and never marks the page.
  const drop: Element[] = [];
  const walk = (a: Element, b: Element) => {
    const as = Array.from(a.children);
    const bs = Array.from(b.children);
    for (let i = 0; i < as.length && i < bs.length; i++) {
      if (hidden.has(as[i]!)) drop.push(bs[i]!);
      else walk(as[i]!, bs[i]!);
    }
  };
  walk(document.documentElement, clone);
  for (const el of drop) el.remove();
  // A form field or an editable region holds what someone typed, not what
  // the page says.
  const FIELDS = 'input, textarea, select, script, noscript, template, [contenteditable]:not([contenteditable="false"])';
  for (const el of Array.from(clone.querySelectorAll(FIELDS))) el.remove();

  let selectionHtml = '';
  const sel = window.getSelection();
  const inField = (node: Node | null) => {
    const el = node instanceof Element ? node : node?.parentElement;
    return !!el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  };
  const active = document.activeElement;
  const typing = !!active && active.matches('input, textarea, select');
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed && !typing && !inField(sel.anchorNode) && !inField(sel.focusNode)) {
    const box = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) box.appendChild(sel.getRangeAt(i).cloneContents());
    for (const el of Array.from(box.querySelectorAll(FIELDS))) el.remove();
    selectionHtml = box.innerHTML;
  }
  return { url: location.href, title: document.title, html: `<!doctype html>${clone.outerHTML}`, selectionHtml };
}
