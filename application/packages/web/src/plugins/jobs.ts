import { useSyncExternalStore } from 'react';
import type { PluginId } from './pluginState';

/**
 * The job store: OCR of a PDF with more than one page and every transcription
 * run here, not in their sheet, so closing the sheet or opening another note
 * does not stop them. One job at a time per plugin; the next one waits.
 * A result lives in memory only (D16) until the user adds it to the note.
 *
 * Cancel ends the plugin's worker (a WASM call cannot stop halfway): the
 * plugin registers how through `setPluginStopper`, and its next use starts a
 * new worker. The same happens when the note goes away (deleted, locked,
 * PIN-guarded), when the app locks, and when the plugin is turned off or
 * removed. Apple's native engines run in no worker: a stopped call runs on
 * until it settles, and the plugin stays busy until then.
 * Spec: docs/internal/plans/plugins.md (section 3.1)
 */

type JobStatus = 'waiting' | 'running' | 'done' | 'error' | 'canceled';

type JobProgress = { done: number; total: number };

export type Job = {
  id: string;
  pluginId: PluginId;
  noteId: string;
  status: JobStatus;
  progress?: JobProgress;
  result?: unknown;
  /** A short code the sheet turns into its own text. */
  error?: string;
  /** Whether its sheet shows it: a job that ends with its sheet closed says "Text is ready". */
  watched: boolean;
};

export type JobRun = (ctx: { signal: AbortSignal; progress: (p: JobProgress) => void }) => Promise<unknown>;

/** `running`: the run's own promise, kept while it runs. */
type Entry = { job: Job; run: JobRun; abort: AbortController; running?: Promise<unknown> };

const entries = new Map<string, Entry>();
/**
 * A stopped job's run until it settles: Apple's native call (Vision,
 * SpeechAnalyzer) runs on after a stop, so the plugin stays busy and its next
 * job waits for it (beta #242 item 2).
 */
const settling = new Map<PluginId, Promise<unknown>>();
const stoppers = new Map<PluginId, () => void>();
const listeners = new Set<() => void>();
const readyListeners = new Set<(job: Job) => void>();
const goneListeners = new Set<(id: string) => void>();
let snapshot: readonly Job[] = [];
let seq = 0;

function emit() {
  snapshot = [...entries.values()].map((e) => e.job);
  for (const l of listeners) l();
}

function patch(id: string, next: Partial<Job>) {
  const e = entries.get(id);
  if (!e) return;
  e.job = { ...e.job, ...next };
  emit();
}

/**
 * How a plugin ends its worker, so a stopped job leaves no memory behind. A
 * native call cannot be ended this way: the plugin stays busy until it settles.
 */
export function setPluginStopper(pluginId: PluginId, stop: () => void): void {
  stoppers.set(pluginId, stop);
}

function startNext(pluginId: PluginId) {
  if (settling.has(pluginId)) return;
  const busy = [...entries.values()].some((e) => e.job.pluginId === pluginId && e.job.status === 'running');
  if (busy) return;
  const next = [...entries.values()].find((e) => e.job.pluginId === pluginId && e.job.status === 'waiting');
  if (!next) return;
  const { id } = next.job;
  patch(id, { status: 'running' });
  const running = next.run({ signal: next.abort.signal, progress: (p) => !next.abort.signal.aborted && patch(id, { progress: p }) });
  next.running = running;
  running
    .then(
      (result) => {
        if (next.abort.signal.aborted) return;
        patch(id, { status: 'done', result });
        const job = entries.get(id)?.job;
        if (job && !job.watched) for (const l of readyListeners) l(job);
      },
      (err: unknown) => {
        if (next.abort.signal.aborted) return;
        patch(id, { status: 'error', error: err instanceof Error ? err.message : 'failed' });
      },
    )
    .finally(() => {
      if (settling.get(pluginId) === running) settling.delete(pluginId);
      startNext(pluginId);
    });
}

/** Queues a job and returns its id. It starts at once when the plugin is free. */
export function startJob(pluginId: PluginId, noteId: string, run: JobRun): string {
  const id = `job-${++seq}`;
  entries.set(id, { job: { id, pluginId, noteId, status: 'waiting', watched: true }, run, abort: new AbortController() });
  emit();
  startNext(pluginId);
  return id;
}

/**
 * Stops jobs and ends the worker of every plugin that was running one of
 * them, or of every plugin when `everyWorker` is set.
 */
function stop(match: (job: Job) => boolean, everyWorker = false) {
  const plugins = new Set<PluginId>(everyWorker ? stoppers.keys() : []);
  const gone: string[] = [];
  for (const [id, e] of entries) {
    if (!match(e.job)) continue;
    if (e.job.status === 'running') {
      plugins.add(e.job.pluginId);
      if (e.running) settling.set(e.job.pluginId, e.running);
    }
    e.abort.abort();
    entries.delete(id);
    gone.push(id);
  }
  for (const p of plugins) stoppers.get(p)?.();
  emit();
  for (const id of gone) for (const l of goneListeners) l(id);
  for (const p of plugins) startNext(p);
}

/** Cancel: the job and its result go. */
export function cancelJob(id: string): void {
  stop((j) => j.id === id);
}

/** The note was deleted, locked or PIN-guarded: its jobs stop and their results go. */
export function stopJobsForNote(noteId: string): void {
  stop((j) => j.noteId === noteId);
}

/** The plugin was turned off or removed. */
export function stopJobsForPlugin(pluginId: PluginId): void {
  stop((j) => j.pluginId === pluginId);
}

/**
 * The app locked, or the notes view closed (sign-out): every job and result
 * goes, and every plugin's worker ends, idle or not, with the engines and
 * the calls that are not jobs (beta #218). The store starts over: it stops
 * waiting for stopped runs, so a run that never settles cannot hold a plugin
 * past a lock. Apple's native calls still go one at a time (`appleEngines.ts`).
 */
export function stopAllJobs(): void {
  stop(() => true, true);
  settling.clear();
}

/** A finished result the user has seen and used (or closed). */
export function dropJob(id: string): void {
  if (!entries.delete(id)) return;
  emit();
  for (const l of goneListeners) l(id);
}

/** Whether the job's sheet shows it. */
export function watchJob(id: string, watched: boolean): void {
  patch(id, { watched });
}

/** Whether a plugin has work that turning it off would stop, or a stopped run that has not settled. */
export function pluginBusy(pluginId: PluginId): boolean {
  return settling.has(pluginId) || [...entries.values()].some((e) => e.job.pluginId === pluginId && (e.job.status === 'running' || e.job.status === 'waiting'));
}

/**
 * Called with the id of each job that leaves the store (canceled, stopped,
 * dropped), so a sheet lets go of what it kept for that job: its insert
 * holds an editor.
 */
export function onJobGone(listener: (id: string) => void): () => void {
  goneListeners.add(listener);
  return () => goneListeners.delete(listener);
}

/** Called when a job ends while its sheet is closed ("Text is ready", Show). */
export function onJobReady(listener: (job: Job) => void): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

/**
 * Below 4 GB (where the browser says) a sheet warns before a job of the web
 * engine, and the user can go on: a killed app cannot report, so the warning
 * comes first. Spec: docs/internal/plans/plugins.md (section 3.1)
 */
export function memoryLooksLow(): boolean {
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return gb !== undefined && gb < 4;
}

export function useJobs(): readonly Job[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}
