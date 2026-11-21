import type { Locale } from '../i18n';
import { appleSpeechStatus } from './appleEngines';
import { detectPlatform } from '../devices';
import { detectDeviceOs } from '../deviceFingerprint';
import { MEANING_FILES } from '../onDeviceAi';
import { markSpeechTooOld, speechIsTooOld } from './pluginState';
import { PLUGIN_FILES } from './files';
import type { PluginId } from './pluginState';

/**
 * One entry per plugin of Settings > Plugins. Loaded with the pane and the
 * manager, never at boot: it carries the pinned file list.
 * Spec: docs/internal/plans/plugins.md (section 3, Registry)
 */

export type PluginFile = {
  path: string;
  bytes: number;
  sha256: string;
  /** A `.zst`: the size and hash after unzstd, checked in the worker. */
  rawBytes?: number;
  rawSha256?: string;
};

/** Where a plugin runs: Apple's engine in the iOS and macOS apps, or our files. */
type Engine = 'apple' | 'web';

export type PluginEntry = {
  id: PluginId;
  /** The files of the web engine (Translate: the engine; each language adds its own). */
  files: readonly PluginFile[];
  /** Whether the web engine runs on the shared onnxruntime-web runtime. */
  needsRuntime: boolean;
  /** A Pro plugin; Voice to text is free, a taste of Plugins (D25). */
  pro: boolean;
  engine: () => Engine;
};

/**
 * Tauri on iOS or macOS: Apple Vision and VisionKit are there (D9), and
 * SpeechAnalyzer from iOS and macOS 26 (`speechIsTooOld`).
 */
function appleNative(): boolean {
  const platform = detectPlatform();
  return platform === 'ios' || (platform === 'desktop' && detectDeviceOs() === 'macOS');
}

const appleOrWeb = (): Engine => (appleNative() ? 'apple' : 'web');

/**
 * The OS's own answer, not the platform's: below iOS and macOS 26 the plugin
 * answers `os-too-old`, and Voice to text is then the web engine on a Mac
 * (its size and Download on the card) and not offered on an iPhone or iPad
 * (D24). The answer lives in `pluginState.ts` (`speechIsTooOld`), where the
 * audio chip's door reads it too (beta #242 entry 1).
 */
let speechAsked: Promise<void> | null = null;

/** Asks the OS once per session; the Plugins pane waits for it, and the registry asks as it loads. */
export function checkAppleSpeech(): Promise<void> {
  if (!appleNative()) return Promise.resolve();
  speechAsked ??= appleSpeechStatus('en').then(
    () => undefined,
    (e: unknown) => {
      if (String(e).includes('os-too-old')) markSpeechTooOld();
    },
  );
  return speechAsked;
}
// Only in a page: a module test without a window imports the registry too.
if (typeof window !== 'undefined' && appleNative()) void checkAppleSpeech();

/** Whether this device offers Voice to text at all: not an iPhone or iPad below iOS 26 (D24). */
export function voiceOffered(): boolean {
  return !(speechIsTooOld() && detectPlatform() === 'ios');
}

const voiceEngine = (): Engine => (appleNative() && !speechIsTooOld() ? 'apple' : 'web');

export const RUNTIME_FILES: readonly PluginFile[] = PLUGIN_FILES.runtime;

/**
 * Translate's languages: our locale, and the Firefox model code that serves
 * it. pt-PT and pt-BR share one model; zh-TW uses zh-Hant, the only Chinese
 * model. English is the bridge, so it has no entry.
 * Spec: docs/internal/specs/plugins-files.md (section 1.3)
 */
export const TRANSLATE_MODEL: Partial<Record<Locale, string>> = {
  de: 'de', fr: 'fr', it: 'it', es: 'es', nl: 'nl', pl: 'pl', 'pt-PT': 'pt', 'pt-BR': 'pt',
  ja: 'ja', ko: 'ko', 'zh-TW': 'zh-Hant', ca: 'ca', cs: 'cs', sk: 'sk', tr: 'tr', sv: 'sv',
  ar: 'ar', uk: 'uk', ru: 'ru', th: 'th',
};

type Directions = typeof PLUGIN_FILES.translate.directions;

/** Both directions of one model language, each file once (a shared vocabulary is in both lists). */
export function translateFiles(model: string): PluginFile[] {
  const dirs = PLUGIN_FILES.translate.directions as Record<string, Directions[keyof Directions] | undefined>;
  const out = new Map<string, PluginFile>();
  for (const f of [...(dirs[`en-${model}`] ?? []), ...(dirs[`${model}-en`] ?? [])]) out.set(f.path, f);
  return [...out.values()];
}

export const PLUGINS: readonly PluginEntry[] = [
  {
    id: 'smartConnections',
    files: MEANING_FILES.map((f) => ({ path: `models/${f.name}`, bytes: f.bytes, sha256: f.sha256 })),
    needsRuntime: false,
    pro: true,
    engine: () => 'web',
  },
  {
    id: 'ocr',
    files: PLUGIN_FILES.ocr,
    needsRuntime: true,
    pro: true,
    engine: appleOrWeb,
  },
  {
    id: 'translate',
    files: PLUGIN_FILES.translate.engine,
    needsRuntime: false,
    pro: true,
    engine: () => 'web',
  },
  {
    id: 'voice',
    files: PLUGIN_FILES.voice,
    needsRuntime: true,
    // Spec: docs/internal/plans/plugins.md (D25)
    pro: false,
    // Below macOS 26 the Mac app uses the web engine (plugins.md section 6.6).
    engine: voiceEngine,
  },
  {
    // DPDFNet2 48 kHz on every platform, the Apple apps too (SE1).
    // Spec: docs/internal/specs/plugins-speech-enhancement.md (section 0)
    id: 'cleanup',
    files: PLUGIN_FILES.cleanup,
    needsRuntime: true,
    pro: true,
    engine: () => 'web',
  },
];

export function pluginEntry(id: PluginId): PluginEntry {
  return PLUGINS.find((p) => p.id === id)!;
}

/** A Translate model's language in the app language ("Spanish", "Traditional Chinese", "Portuguese"). */
export function modelLanguageName(model: string, uiLocale: string): string {
  try {
    return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(model) ?? model;
  } catch {
    return model;
  }
}
