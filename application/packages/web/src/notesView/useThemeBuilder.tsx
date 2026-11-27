import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { hasAnyCustomThemeSlot, reconcileCustomSlots } from '../theme';
import { canSaveCustomTheme, saveCustomTheme, type CustomThemes } from '../customThemes';
import { deleteCustomIcon, saveThemeIcon, themeIconDataUrl, type CustomIcons } from '../customIcons';
import { hasSettingsPulled, type UserSettings } from '../userSettings';
import { isDemoMode } from '../demo';
import type { SpaceView } from '../spaces';

const ThemeBuilder = lazy(() => import('../ThemeBuilder').then((m) => ({ default: m.ThemeBuilder })));

/** What the builder opens on: a saved theme (id and code), a code to start
 *  from (a copy, a pasted code or a built-in palette's code), or nothing, for
 *  an exact copy of the theme on screen. `space` names which space card in
 *  Settings > Design opened the builder (#948). */
export type ThemeBuilderTarget = {
  id?: string;
  code?: string;
  name?: string;
  space?: SpaceView;
  /** Optional custom icon data URL when duplicating a theme or resuming after upgrade. */
  icon?: string | null;
};

/**
 * The custom-theme wiring NotesView owns: the floating theme builder, and the
 * two light and dark slots kept in step with the synced theme list.
 *
 * The slots are device-local and the list is not, so after the list loads or
 * syncs a slot can point at a theme that another device edited (it repaints
 * with the new colors) or deleted (it goes back to Default). Before the
 * first pull the list is not the account's yet, so nothing is dropped.
 * Spec: docs/contrib/color-themes.md (section 6)
 */
export function useThemeBuilder({
  customThemes,
  themeIcons,
  mutateSettings,
  canSave,
  onOpen,
  onOpenUpgrade,
}: {
  customThemes: CustomThemes;
  themeIcons: CustomIcons;
  mutateSettings: (updater: (prev: UserSettings) => UserSettings) => void;
  /** Pro, or the demo. */
  canSave: boolean;
  /** Closes what the builder replaces: Settings and the Appearance popover. */
  onOpen: () => void;
  onOpenUpgrade: () => void;
}): { openThemeBuilder: (target: ThemeBuilderTarget) => void; resumeThemeBuilder: () => void; themeBuilder: ReactNode } {
  const [target, setTarget] = useState<ThemeBuilderTarget | null>(null);
  // Save with Pro closes the builder for the upgrade. Its draft waits here and
  // opens again when the upgrade closes, bought or not, so no work is lost.
  const parked = useRef<ThemeBuilderTarget | null>(null);

  const openThemeBuilder = useCallback(
    (next: ThemeBuilderTarget) => {
      onOpen();
      setTarget(next);
    },
    [onOpen],
  );

  const resumeThemeBuilder = useCallback(() => {
    const next = parked.current;
    parked.current = null;
    if (next) openThemeBuilder(next);
  }, [openThemeBuilder]);

  useEffect(() => {
    if (!hasAnyCustomThemeSlot() || !(isDemoMode() || hasSettingsPulled())) return;
    let live = true;
    void import('../customThemeUI').then(({ teamThemeEntries, customThemeEntries }) => {
      if (!live) return;
      const listed = [...teamThemeEntries(), ...customThemeEntries(customThemes, themeIcons)];
      const byId = new Map(listed.map((e) => [e.id, e.snapshot]));
      reconcileCustomSlots((id, mode) => {
        const snap = byId.get(id);
        return snap && snap.mode === mode ? snap : null;
      }, !isDemoMode());
    });
    return () => { live = false; };
  }, [customThemes, themeIcons]);

  const initialIcon = target
    ? (target.icon !== undefined ? target.icon : target.id ? themeIconDataUrl(themeIcons, target.id) : null)
    : null;

  const themeBuilder = target ? (
    <Suspense fallback={null}>
      <ThemeBuilder
        key={target.id ?? target.code ?? 'new'}
        target={target}
        initialIcon={initialIcon}
        canSave={canSave}
        hasRoom={(id) => canSaveCustomTheme(customThemes, id)}
        onSave={(id, code, icon) => {
          // The builder stays open after a save; Close or Cancel ends it.
          mutateSettings((prev) => ({
            ...prev,
            customThemes: saveCustomTheme(prev.customThemes, id, code),
            themeIcons: icon ? saveThemeIcon(prev.themeIcons, id, icon) : deleteCustomIcon(prev.themeIcons, id),
          }));
        }}
        onClose={() => setTarget(null)}
        onOpenUpgrade={(code, icon) => {
          parked.current = { id: target.id, code, space: target.space, icon };
          setTarget(null);
          onOpenUpgrade();
        }}
      />
    </Suspense>
  ) : null;

  return { openThemeBuilder, resumeThemeBuilder, themeBuilder };
}
