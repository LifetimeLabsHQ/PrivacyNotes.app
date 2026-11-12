/**
 * Patch one DOM tree into the shape of another, node by node. The Ninja box
 * (NinjaWindow.tsx) draws the markup the main window's hidden Ninja sends at
 * every change; replacing its copy each time would reset the list's scroll,
 * replay the mark's animation and take the field away while the person
 * types. A node that `keep` names keeps its value and its children, and only
 * its attributes follow (the box's own field).
 * Spec: docs/internal/plans/ninja-anywhere-694.md (section 3)
 */

function syncAttributes(from: Element, to: Element, skipValue: boolean): void {
  for (const { name } of [...from.attributes]) {
    if (!to.hasAttribute(name) && !(skipValue && name === 'value')) from.removeAttribute(name);
  }
  for (const { name, value } of [...to.attributes]) {
    if (skipValue && name === 'value') continue;
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
}

export function morph(from: Element, to: Element, keep?: (el: Element) => boolean): void {
  const kept = !!keep?.(from);
  syncAttributes(from, to, kept);
  if (kept) return;
  const want = [...to.childNodes];
  want.forEach((next, i) => {
    const have = from.childNodes[i];
    if (!have) {
      from.appendChild(next.cloneNode(true));
    } else if (have.nodeType !== next.nodeType || (have instanceof Element && next instanceof Element && have.tagName !== next.tagName)) {
      have.replaceWith(next.cloneNode(true));
    } else if (have instanceof Element && next instanceof Element) {
      morph(have, next, keep);
    } else if (have.nodeValue !== next.nodeValue) {
      have.nodeValue = next.nodeValue;
    }
  });
  while (from.childNodes.length > want.length) from.lastChild!.remove();
}

/** The child indexes from `root` down to `node`, or null outside it. */
export function pathOf(root: Element, node: Element): number[] | null {
  const path: number[] = [];
  let at: Element | null = node;
  while (at && at !== root) {
    const parent: Element | null = at.parentElement;
    if (!parent) return null;
    path.unshift([...parent.children].indexOf(at));
    at = parent;
  }
  return at === root ? path : null;
}

/** The node `pathOf` named, or null when the tree changed under it. */
export function nodeAt(root: Element, path: readonly number[]): Element | null {
  let at: Element | undefined = root;
  for (const i of path) {
    at = at?.children[i];
    if (!at) return null;
  }
  return at ?? null;
}
