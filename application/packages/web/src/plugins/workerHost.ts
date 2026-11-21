import type { WorkerReply, WorkerRequest } from './workerProtocol';

/**
 * The main thread's side of the plugin workers: one worker per plugin (OCR,
 * Translate with its language check, Voice), each started on first use.
 * Cancel and the end of a job end that plugin's worker (`endPluginWorker`),
 * because a WASM call cannot stop halfway; the next use starts a new one and
 * loads again. One worker each, so stopping one plugin's job never fails
 * another plugin's call (beta #218).
 * Spec: docs/internal/plans/plugins.md (sections 3.1 and 4)
 */

/** A request before its id: Omit over each member of the union. */
type Request = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (done: number, total: number) => void };

type Slot = { worker: Worker; pending: Map<number, Pending>; loaded: Set<string> };

/** The running workers, by plugin. */
const slots = new Map<string, Slot>();
let seq = 0;

/**
 * The plugin whose worker runs an engine: `ocr:eslav` runs in OCR's worker,
 * `translate:de>ja` in Translate's, and the language check (`langid`) is
 * Translate's too.
 */
function pluginOf(engineId: string): string {
  const id = engineId.split(':')[0]!;
  return id === 'langid' ? 'translate' : id;
}

function start(plugin: string): Slot {
  const running = slots.get(plugin);
  if (running) return running;
  const w = new Worker(new URL('./pluginWorker.ts', import.meta.url), { type: 'module', name: 'pluginWorker' });
  const slot: Slot = { worker: w, pending: new Map(), loaded: new Set() };
  w.onmessage = (e: MessageEvent<WorkerReply>) => {
    const reply = e.data;
    const p = slot.pending.get(reply.id);
    if (!p) return;
    if (reply.op === 'progress') {
      p.progress?.(reply.done, reply.total);
      return;
    }
    slot.pending.delete(reply.id);
    if (reply.op === 'error') p.reject(new Error(reply.code));
    else p.resolve(reply.op === 'result' ? reply.result : undefined);
  };
  // A worker that dies (out of memory) fails every call it holds.
  w.onerror = () => {
    if (slots.get(plugin) === slot) endSlot(plugin, 'worker-died');
  };
  slots.set(plugin, slot);
  return slot;
}

function call(slot: Slot, req: Request, transfer: Transferable[] = [], progress?: Pending['progress']): Promise<unknown> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    slot.pending.set(id, { resolve, reject, progress });
    slot.worker.postMessage({ ...req, id } as WorkerRequest, transfer);
  });
}

/** Whether a running worker holds an engine. */
export function workerHas(engineId: string): boolean {
  return slots.get(pluginOf(engineId))?.loaded.has(engineId) ?? false;
}

/** Hands a plugin's checked files (and the runtime, when it needs one) to its worker. The bytes move; the caller's copies are gone. */
export async function loadInWorker(engineId: string, files: Record<string, ArrayBuffer>, runtime?: ArrayBuffer): Promise<void> {
  const transfer = [...Object.values(files), ...(runtime ? [runtime] : [])];
  const slot = start(pluginOf(engineId));
  await call(slot, { op: 'load', pluginId: engineId, files, ...(runtime ? { runtime } : {}) }, transfer);
  slot.loaded.add(engineId);
}

/** Takes one engine, and its memory, out of its worker. */
export async function unloadInWorker(engineId: string): Promise<void> {
  const slot = slots.get(pluginOf(engineId));
  if (!slot?.loaded.delete(engineId)) return;
  await call(slot, { op: 'unload', pluginId: engineId });
}

export function runInWorker(engineId: string, input: unknown, progress?: (done: number, total: number) => void, transfer: Transferable[] = []): Promise<unknown> {
  return call(start(pluginOf(engineId)), { op: 'run', pluginId: engineId, input }, transfer, progress);
}

function endSlot(plugin: string, code: string): void {
  const slot = slots.get(plugin);
  if (!slot) return;
  slots.delete(plugin);
  slot.worker.terminate();
  for (const p of slot.pending.values()) p.reject(new Error(code));
  slot.pending.clear();
}

/**
 * Ends a plugin's worker and its memory, or every plugin worker when no
 * plugin is named; every call such a worker holds fails with `code`.
 */
export function endPluginWorker(plugin?: string, code = 'canceled'): void {
  for (const p of plugin === undefined ? [...slots.keys()] : [pluginOf(plugin)]) endSlot(p, code);
}
