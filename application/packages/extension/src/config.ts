/**
 * Where the extension talks to. The functions are reached on the app's sync
 * host; a development build can point elsewhere with WXT_FUNCTIONS_URL.
 * Spec: docs/internal/agent-rules.md (rule S, the sync host serves /functions/v1)
 */
export const FUNCTIONS_URL: string =
  (import.meta.env.WXT_FUNCTIONS_URL as string | undefined) ?? 'https://sync.privacynotes.app/functions/v1';

/** The app, for Open PrivacyNotes and Edit in the app. */
export const APP_URL = 'https://use.privacynotes.app';

/** The help page the popup links. */
export const HELP_URL = 'https://privacynotes.app/help/browser-extension/';
