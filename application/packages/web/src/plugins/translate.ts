import { checkKeptPlugin, readPluginFile } from './pluginManager';
import { pluginState } from './pluginState';
import { PLUGIN_FILES } from './files';
import { pluginEntry, TRANSLATE_MODEL, type PluginFile } from './registry';
import { assemble, fromHtml, fromPlain, planTranslation, plainWords, type Plan } from './translateMarkdown';
import { loadInWorker, runInWorker, unloadInWorker, workerHas } from './workerHost';

/**
 * Translate notes on the main thread: the language of the text (eld, in the
 * worker), the files of a pair handed to the worker, and a note's Markdown
 * through the engine line by line. The translation exists only in memory
 * until the user saves it as a new note (D15, D16).
 * Spec: docs/internal/plans/plugins.md (section 6.5)
 */

/** Every language the engine reads and writes, as Firefox model codes: English is the bridge. */
export const TRANSLATE_LANGUAGES: readonly string[] = ['en', ...new Set(Object.values(TRANSLATE_MODEL))];

/** The languages switched on on this device, English aside. One whose switch is off is not used (beta #239 item 13). */
export async function languagesOnDevice(isPro: boolean): Promise<string[]> {
  const out: string[] = [];
  for (const m of TRANSLATE_LANGUAGES) {
    if (m === 'en') continue;
    await checkKeptPlugin(`translate.${m}`, isPro);
    if (pluginState(`translate.${m}`).status === 'on') out.push(m);
  }
  return out;
}

/** The model code for an app locale ("pt-BR" is "pt"), or null for one with no model. */
export function modelOfLocale(locale: string): string | null {
  return locale === 'en' ? 'en' : (TRANSLATE_MODEL[locale as keyof typeof TRANSLATE_MODEL] ?? null);
}

/** The model code for a language eld names: "zh" is Traditional Chinese, the only Chinese model. */
export function modelOfDetected(code: string): string | null {
  const m = code === 'zh' ? 'zh-Hant' : code;
  return TRANSLATE_LANGUAGES.includes(m) ? m : null;
}

const DIRECTIONS = PLUGIN_FILES.translate.directions as Record<string, readonly PluginFile[] | undefined>;

/** The files a pair needs: the engine, and each direction it runs, through English when neither side is English. */
function pairFiles(from: string, to: string): PluginFile[] {
  const dirs = from === 'en' || to === 'en' ? [`${from}-${to}`] : [`${from}-en`, `en-${to}`];
  const all = new Map<string, PluginFile>();
  for (const f of [...pluginEntry('translate').files, ...dirs.flatMap((d) => DIRECTIONS[d] ?? [])]) all.set(f.path, f);
  return [...all.values()];
}

let loadedPair: string | null = null;

/** Loads one pair into the worker; the pair loaded before leaves first, with its memory. */
async function ensurePair(from: string, to: string, signal: AbortSignal): Promise<string> {
  const id = `translate:${from}>${to}`;
  if (workerHas(id)) return id;
  if (loadedPair && workerHas(loadedPair)) await unloadInWorker(loadedPair);
  const files: Record<string, ArrayBuffer> = {};
  for (const f of pairFiles(from, to)) {
    signal.throwIfAborted();
    files[f.path] = await readPluginFile(f, signal);
  }
  await loadInWorker(id, files);
  loadedPair = id;
  return id;
}

/** The language of a note's Markdown as eld reads it ("de", "zh"), "" when it cannot tell, or null when the note has no words to translate. */
export async function detectLanguage(md: string): Promise<string | null> {
  const words = plainWords(planTranslation(md));
  if (!words.trim()) return null;
  if (!workerHas('langid')) await loadInWorker('langid', {});
  return String(await runInWorker('langid', words));
}

/** Lines per call: a call cannot stop halfway, so a long note goes in steps that Cancel can end between. */
const STEP = 12;

/** A translation, and how many lines of it kept their own words because the engine gave back none. */
export type Translation = { markdown: string; untranslated: number };

/** Whether an answer holds a word outside its tags and parts: an empty one would drop the line's text (beta #239 item 2). */
const hasWords = (answer: string | undefined) => !!answer && /(?:^|>)[^<]*[\p{L}\p{N}]/u.test(answer.replace(/⟦\s*\d+\s*⟧/g, ''));

/**
 * A note's Markdown in another language. `progress` gets the units done and
 * the total. A unit whose HTML answer is refused, empty or broken goes again
 * as plain text, and one with no words in that answer either keeps its own
 * text (translateMarkdown.ts).
 */
export async function translateMarkdown(md: string, from: string, to: string, signal: AbortSignal, progress: (done: number, total: number) => void): Promise<Translation> {
  const plan: Plan = planTranslation(md);
  const total = plan.units.length;
  if (!total) return { markdown: md, untranslated: 0 };
  const id = await ensurePair(from, to, signal);
  const call = async (texts: string[], html: boolean) => (await runInWorker(id, { from, to, texts, html })) as string[];
  const done: string[] = [];
  const kept = new Set<number>();
  progress(0, total);
  for (let at = 0; at < total; at += STEP) {
    signal.throwIfAborted();
    const units = plan.units.slice(at, at + STEP);
    // The engine's HTML reader can refuse a line and fail the whole call
    // (beta #239 item 1): then every line of the step goes as plain text.
    let first: string[] = [];
    try {
      first = await call(units.map((u) => u.html), true);
    } catch (err) {
      if (signal.aborted || !workerHas(id)) throw err;
    }
    const lines = units.map((u, i) => (hasWords(first[i]) ? fromHtml(u, first[i]!) : null));
    const again = lines.flatMap((l, i) => (l === null ? [i] : []));
    if (again.length) {
      const plain = await call(again.map((i) => units[i]!.plain), false);
      again.forEach((i, k) => {
        if (hasWords(plain[k])) lines[i] = fromPlain(units[i]!, plain[k]!);
        else {
          lines[i] = units[i]!.source;
          kept.add(at + i);
        }
      });
    }
    done.push(...(lines as string[]));
    progress(done.length, total);
  }
  const untranslated = plan.lines.filter((pieces) => pieces.some((p) => typeof p === 'number' && kept.has(p))).length;
  return { markdown: assemble(plan, done), untranslated };
}
