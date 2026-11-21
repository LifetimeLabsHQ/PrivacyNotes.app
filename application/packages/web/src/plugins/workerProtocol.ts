/**
 * The messages between the main thread and the plugin worker. Types only, so
 * both sides import it without code. Every request carries an id; the worker
 * answers each with `loaded`, `result` or `error`, and a run may send
 * `progress` first.
 * Spec: docs/internal/plans/plugins.md (section 4)
 */
export type WorkerRequest =
  | { op: 'load'; id: number; pluginId: string; files: Record<string, ArrayBuffer>; runtime?: ArrayBuffer }
  | { op: 'run'; id: number; pluginId: string; input: unknown }
  | { op: 'unload'; id: number; pluginId: string };

export type WorkerReply =
  | { op: 'loaded'; id: number }
  | { op: 'progress'; id: number; done: number; total: number }
  | { op: 'result'; id: number; result: unknown }
  | { op: 'error'; id: number; code: string };
