import { activeLocale } from '../i18n';
import { readPluginFile } from './pluginManager';
import { pluginEntry, RUNTIME_FILES, type PluginFile } from './registry';
import { loadInWorker, runInWorker, workerHas } from './workerHost';
import type { OcrScript } from './ocrEngine';
import { appleOcr } from './appleEngines';

/**
 * Text in pictures on the main thread: Apple Vision in the iOS and macOS
 * apps, else the web engine in the plugin worker, fed checked bytes. The
 * recognizer follows the app language: the detector is shared, and each
 * script has its own recognizer (`ocr.md` section 7). The text exists only
 * in memory until the user adds it to the note (D16).
 * Spec: docs/internal/plans/plugins.md (section 6.4)
 */

/** The recognizer each locale needs. Spec: docs/internal/specs/ocr.md (section 7) */
const SCRIPT_OF: Record<string, OcrScript> = { ru: 'eslav', uk: 'eslav', ar: 'arabic', th: 'th', ko: 'korean' };

export function ocrScript(locale: string = activeLocale()): OcrScript {
  return SCRIPT_OF[locale] ?? 'base';
}

/** The file of a role, by the stem of its pinned name. */
function fileOf(stem: string): PluginFile {
  const f = pluginEntry('ocr').files.find((x) => x.path.startsWith(`ocr/${stem}-`) && !x.path.slice(`ocr/${stem}-`.length).includes('-'));
  if (!f) throw new Error(`ocr file ${stem}`);
  return f;
}

const STEMS: Record<OcrScript, string> = {
  base: 'ppocrv6-small-rec',
  eslav: 'ppocrv5-eslav-rec',
  arabic: 'ppocrv5-arabic-rec',
  th: 'ppocrv5-th-rec',
  korean: 'ppocrv5-korean-rec',
};

/** Loads the detector, the runtime and one script's recognizer into the worker, once. */
async function ensureLoaded(script: OcrScript, signal: AbortSignal): Promise<string> {
  const id = `ocr:${script}`;
  if (workerHas(id)) return id;
  const files: Record<string, ArrayBuffer> = {
    det: await readPluginFile(fileOf('ppocrv6-small-det'), signal),
    [`rec-${script}`]: await readPluginFile(fileOf(STEMS[script]), signal),
    [`dict-${script}`]: await readPluginFile(fileOf(`${STEMS[script]}-dict`), signal),
  };
  const runtime = await readPluginFile(RUNTIME_FILES[0]!, signal);
  await loadInWorker(id, files, runtime);
  return id;
}

export type OcrEngineKind = 'apple' | 'web';

/**
 * The text of one picture (its encoded bytes). An empty string means no text
 * was found. Throws on a failure.
 */
export async function ocrImage(bytes: ArrayBuffer, engine: OcrEngineKind, signal: AbortSignal): Promise<string> {
  if (engine === 'apple') return appleOcr(bytes);
  const script = ocrScript();
  const id = await ensureLoaded(script, signal);
  signal.throwIfAborted();
  return (await runInWorker(id, { image: bytes, script }, undefined, [bytes])) as string;
}
