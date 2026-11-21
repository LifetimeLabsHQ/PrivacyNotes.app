/**
 * The language of a note's text, inside the plugin worker: eld's XS data, a
 * chunk of the app (no download, plugins-files.md 1.5). Translate notes asks
 * it for the "From" language. Pure JavaScript, no files.
 * Spec: docs/internal/plans/plugins.md (section 6.5)
 */
import type { Engine } from './pluginWorker';

export async function load(): Promise<Engine> {
  const { eld } = await import('eld/extrasmall');
  return {
    // An ISO 639-1 code ("de", "zh"), or "" when the text has no language eld knows.
    run: async (input) => eld.detect(String(input)).language,
  };
}
