/**
 * Which side of Settings > Toolbar a gear opens: the note editor's gear opens
 * Typing, the drawing toolbar's opens Drawing. The gear sets it just before
 * it opens Settings; the pane reads it on its first render and clears it
 * once it has switched (a read that cleared would lose it to React's second
 * call of a state initializer in development).
 */
export type ToolbarSettingsTab = 'typing' | 'drawing';

let requested: ToolbarSettingsTab | null = null;

export function requestToolbarTab(tab: ToolbarSettingsTab): void {
  requested = tab;
}

/** The side a gear asked for; null when none did. */
export function readToolbarTab(): ToolbarSettingsTab | null {
  return requested;
}

export function clearToolbarTab(): void {
  requested = null;
}
