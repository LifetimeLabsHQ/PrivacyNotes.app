/** The element itself or its nearest ancestor that scrolls vertically, else
 *  the page. */
export function scrollParentOf(el: Element): HTMLElement {
  for (let p: Element | null = el; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p as HTMLElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}
