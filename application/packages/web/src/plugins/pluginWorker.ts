/// <reference lib="webworker" />
/**
 * The plugin worker: the one place where WebAssembly runs. Its script gets a
 * policy of its own (`_headers` on the web, `script_csp.rs` in the apps):
 * WebAssembly yes, `eval` no, network none. So it never fetches: the main
 * thread checks every file against its pinned hash and transfers the bytes
 * here (D22). One thread: the policy blocks nested workers (`worker-src 'none'`;
 * without it they would fall under `script-src 'self'`), and the page is
 * not cross-origin isolated.
 *
 * Each plugin's engine is a module of its own, imported on its first `load`.
 * Spec: docs/internal/plans/plugins.md (section 4)
 */
import type * as Ort from 'onnxruntime-web/wasm';
import type { WorkerReply, WorkerRequest } from './workerProtocol';

/** What an engine module exports: load once, then run any number of times. */
export type Engine = {
  run: (input: unknown, progress: (done: number, total: number) => void) => Promise<unknown>;
  unload?: () => void;
};
export type EngineModule = { load: (files: Record<string, ArrayBuffer>, ortApi: typeof Ort) => Promise<Engine> };

/**
 * onnxruntime, as a chunk of its own. A static import would put it in this
 * entry chunk, and an engine that imports it too (`ppu-paddle-ocr` does)
 * would import this entry back: WebKit then runs this module a second time,
 * whose `onmessage` replaces this one with an empty `loaded`, so every call
 * after the first load answers `not-loaded`. tests/pluginWorkerHeaders.test.ts
 * checks that no chunk imports the entry.
 */
let ortApi: Promise<typeof Ort> | null = null;
const onnxRuntime = () => (ortApi ??= import('onnxruntime-web/wasm'));

/** The engines this worker can load, each a chunk from `'self'`. */
const ENGINES: Record<string, () => Promise<EngineModule>> = {
  ocr: () => import('./ocrEngine'),
  translate: () => import('./translateEngine'),
  langid: () => import('./langidEngine'),
  voice: () => import('./voiceEngine'),
  cleanup: () => import('./cleanupEngine'),
};

const loaded = new Map<string, Engine>();

function post(reply: WorkerReply, transfer: Transferable[] = []) {
  self.postMessage(reply, transfer);
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.op === 'load') {
      const ort = await onnxRuntime();
      if (req.runtime) {
        ort.env.wasm.wasmBinary = req.runtime;
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
      }
      if (!loaded.has(req.pluginId)) {
        // `ocr:eslav` loads the `ocr` engine with that script's files, and
        // `translate:de>ja` the `translate` engine with that pair's files.
        const make = ENGINES[req.pluginId.split(':')[0]!];
        if (!make) throw new Error('unknown-plugin');
        loaded.set(req.pluginId, await (await make()).load(req.files, ort));
      }
      post({ op: 'loaded', id: req.id });
    } else if (req.op === 'run') {
      const engine = loaded.get(req.pluginId);
      if (!engine) throw new Error('not-loaded');
      const result = await engine.run(req.input, (done, total) => post({ op: 'progress', id: req.id, done, total }));
      post({ op: 'result', id: req.id, result });
    } else if (req.op === 'unload') {
      loaded.get(req.pluginId)?.unload?.();
      loaded.delete(req.pluginId);
      post({ op: 'loaded', id: req.id });
    }
  } catch (err) {
    post({ op: 'error', id: req.id, code: err instanceof Error ? err.message : 'failed' });
  }
};
