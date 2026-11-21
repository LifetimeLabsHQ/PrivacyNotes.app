/**
 * Whether this page runs inside the app shell (Tauri), where the device key
 * may exist. A leaf module, so the settings cache (settingsSeal.ts) and the
 * phrase at rest (phraseAtRest.ts) ask the same question with no import
 * between them.
 */
export function inNativeShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
