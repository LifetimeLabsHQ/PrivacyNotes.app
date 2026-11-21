import { proUnlocked } from '../demo';
import { decodeAudio } from './decodeAudio';
import { startJob } from './jobs';
import { checkKeptPlugin, readPluginFile } from './pluginManager';
import { cleanupSubjects, type AudioAttrs, type CleanupRequest } from './pluginDoors';
import { pluginState } from './pluginState';
import { pluginEntry, RUNTIME_FILES } from './registry';
import { loadInWorker, runInWorker, workerHas } from './workerHost';
import { CLEANUP_RATE } from './cleanupDsp';
import type { CleanupResult } from './cleanupEngine';

/**
 * Remove noise on the main thread: one tap on a recording starts a job
 * (no sheet), the recording is decoded to 48 kHz mono, cleaned and encoded
 * in the plugin worker, and stored as a new attachment. The chip then swaps
 * the recording for the cleaned one and offers Undo; the original stays on
 * the device and the server until the orphan sweep takes it a day later, and
 * the note's history keeps the version that pointed at it.
 * Spec: docs/internal/specs/plugins-speech-enhancement.md (SE3, section 8)
 */

/** What a finished job hands the chip. */
type CleanupDone = { attrs: AudioAttrs; uploaded: Promise<void> };

/** Loads the model and the runtime into the worker, once. */
async function ensureModel(signal: AbortSignal): Promise<void> {
  if (workerHas('cleanup')) return;
  const model = await readPluginFile(pluginEntry('cleanup').files[0]!, signal);
  signal.throwIfAborted();
  await loadInWorker('cleanup', { model }, await readPluginFile(RUNTIME_FILES[0]!, signal));
}

const EXT: Record<CleanupResult['mime'], string> = { 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' };

/** The recording's name with the extension of the cleaned file's format. */
function cleanedName(name: string, mime: CleanupResult['mime']): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${EXT[mime]}`;
}

/**
 * Starts Remove noise on one recording, or says which door opens first:
 * `upgrade` on a free account, `card` when the plugin is not on this device.
 * The chip offers no second job on a recording that has one.
 */
export async function startCleanup(request: CleanupRequest, noteId: string, isPro: boolean | undefined): Promise<'started' | 'upgrade' | 'card'> {
  if (!proUnlocked(isPro)) return 'upgrade';
  if (pluginState('cleanup').status !== 'on') await checkKeptPlugin('cleanup', true);
  const { status } = pluginState('cleanup');
  if (status === 'needsPro') return 'upgrade';
  if (status !== 'on') return 'card';
  const id = startJob('cleanup', noteId, async ({ signal, progress }) => {
    const bytes = await request.load();
    if (!bytes) throw new Error('failed');
    const pcm = await decodeAudio(bytes.slice().buffer, CLEANUP_RATE);
    signal.throwIfAborted();
    await ensureModel(signal);
    signal.throwIfAborted();
    const result = (await runInWorker('cleanup', { pcm }, (done, total) => progress({ done, total }), [pcm.buffer])) as CleanupResult;
    signal.throwIfAborted();
    const file = new File([result.data as BlobPart], cleanedName(request.filename, result.mime), { type: result.mime });
    const stored = await request.store(file);
    if (!stored) throw new Error('store');
    return stored satisfies CleanupDone;
  });
  cleanupSubjects.set(id, request.subject);
  return 'started';
}
