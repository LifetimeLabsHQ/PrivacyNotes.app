/**
 * Text in pictures, the web engine, inside the plugin worker: PaddleOCR
 * through `ppu-paddle-ocr/web`, fed the model bytes the main thread checked.
 * One detector for every script, and the recognizer of the script asked for:
 * PP-OCRv6 small for every Latin locale, Japanese and Traditional Chinese,
 * the PP-OCRv5 mobile recognizers for Cyrillic (eslav), Arabic, Thai and
 * Korean. A service per script, made on its first use.
 * Spec: docs/internal/plans/plugins.md (section 6.4), docs/internal/specs/ocr.md (section 7)
 */
import type * as Ort from 'onnxruntime-web/wasm';
import { PaddleOcrService } from 'ppu-paddle-ocr/web';
import type { Engine } from './pluginWorker';

export type OcrScript = 'base' | 'eslav' | 'arabic' | 'th' | 'korean';
export type OcrInput = { image: ArrayBuffer; script: OcrScript };

/** A run of digits and Latin letters inside an Arabic line: left to right, so the recognizer already has it in order. */
const LTR_RUN = /[0-9A-Za-z](?:[0-9A-Za-z .,:/+%-]*[0-9A-Za-z])?/g;

/**
 * PaddleOCR gives Arabic in visual order: each line is reversed, and then
 * each run of digits and Latin letters is turned back (beta #240 item 8).
 * Spec: docs/internal/specs/ocr.md (section 3a)
 */
export function arabicLine(line: string): string {
  return [...line].reverse().join('').replace(LTR_RUN, (run) => [...run].reverse().join(''));
}

/** The two model sessions of a service: the library keeps them as fields after `initialize()` (ppu-paddle-ocr 6.7.1). */
type Sessions = { detectionSession: Ort.InferenceSession | null; recognitionSession: Ort.InferenceSession | null };

/** The file keys the main thread sends: `det`, and `rec-<script>` and `dict-<script>` for each script. */
export async function load(files: Record<string, ArrayBuffer>, ort: typeof Ort): Promise<Engine> {
  // The library points the runtime at a CDN when nothing else is set. The
  // runtime's bytes are already here (`wasmBinary`), and the worker's policy
  // refuses every request anyway: leave no address to try.
  ort.env.wasm.wasmPaths = undefined;
  const services = new Map<OcrScript, PaddleOcrService>();
  // The first failure inside the current run; one run at a time in the worker.
  let failure: unknown = null;
  const service = async (script: OcrScript) => {
    let svc = services.get(script);
    if (svc) return svc;
    const rec = files[`rec-${script}`];
    const dict = files[`dict-${script}`];
    if (!files.det || !rec || !dict) throw new Error('not-loaded');
    // The library keeps the buffers it is given: each service gets copies.
    svc = new PaddleOcrService({
      model: { detection: files.det.slice(0), recognition: rec.slice(0), charactersDictionary: dict.slice(0) },
      session: { executionProviders: ['wasm'] },
    });
    await svc.initialize();
    // The library catches a failed run (out of memory, say) and answers
    // "no text": each session remembers its throw, and the run rethrows it
    // (beta #240 item 9).
    const sessions = svc as unknown as Sessions;
    for (const session of [sessions.detectionSession, sessions.recognitionSession]) {
      if (!session) throw new Error('not-loaded');
      const run = session.run.bind(session);
      session.run = (async (...args: Parameters<typeof run>) => {
        try {
          return await run(...args);
        } catch (err) {
          failure ??= err;
          throw err;
        }
      }) as typeof session.run;
    }
    services.set(script, svc);
    return svc;
  };
  return {
    run: async (input, progress) => {
      const { image, script } = input as OcrInput;
      progress(0, 1);
      const svc = await service(script);
      failure = null;
      const result = await svc.recognize(image, { noCache: true });
      if (failure) throw failure instanceof Error ? failure : new Error('failed');
      progress(1, 1);
      const text = script === 'arabic' ? result.text.split('\n').map(arabicLine).join('\n') : result.text;
      return text.trim();
    },
    unload: () => {
      for (const svc of services.values()) void (svc as { destroy?: () => Promise<void> }).destroy?.();
      services.clear();
    },
  };
}
