/**
 * Closing the last tab empties the editor pane. The list would otherwise put
 * its first item back at once, so the pane stays empty while the list keeps
 * the scope it had at the close: a sync refresh or a re-sort keeps it empty,
 * and a new view, folder, tag, space or search lets the list pick again.
 * Spec: docs/internal/issues/0568.md (Spec)
 */
export function listScopeKey(
  view: string,
  folder: string | null,
  tag: string | null,
  space: string | null,
  search: string,
): string {
  return JSON.stringify([view, folder, tag, space, search]);
}

/** True while the pane stays empty after a close in this scope. */
export function keepsEmptyPane(closedScope: string | null, scope: string, selectedId: string | null): boolean {
  return selectedId === null && closedScope !== null && closedScope === scope;
}

/** Views that fill the editor pane with their own surface, so a switch to one
 *  closes the open item: the month, the widgets, the task board, the files,
 *  the Markdown folder. */
const OWN_PANE = new Set(['tasks', 'files', 'calendar', 'dashboard', 'markdown']);

/**
 * A click on a folder, tag or view keeps the open item open on a wide screen
 * (#823): it changes the list and nothing else. A phone shows the list
 * instead, and a view with a pane of its own takes the pane.
 * Spec: docs/internal/specs/keep-my-place.md (section 2.2)
 */
export function keepsOpenItem(nextView: string): boolean {
  if (OWN_PANE.has(nextView)) return false;
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
}
