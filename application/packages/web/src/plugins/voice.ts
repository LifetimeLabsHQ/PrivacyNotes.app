import { appleSpeechInstall, appleSpeechStatus, appleTranscribe } from './appleEngines';
import { detectPlatform } from '../devices';
import { decodeAudio, MAX_AUDIO_S } from './decodeAudio';
import { readPluginFile } from './pluginManager';
import { markSpeechTooOld, pluginState } from './pluginState';
import { pluginEntry, RUNTIME_FILES, type PluginFile } from './registry';
import { joinSegments, SAMPLE_RATE } from './whisper';
import { loadInWorker, runInWorker, workerHas } from './workerHost';
import type { VoiceResult } from './voiceEngine';

/**
 * Voice to text on the main thread: the recording decoded to 16 kHz mono
 * PCM with WebAudio, then SpeechAnalyzer in the iOS and macOS apps (the PCM
 * goes to Swift in memory, D16) or Whisper in the plugin worker. A Mac below
 * macOS 26 has no SpeechAnalyzer and uses Whisper once its files are on the
 * device; an iPhone or iPad below 26 never runs Whisper (D24). The text
 * exists only in memory until the user adds it to the note.
 * Spec: docs/internal/plans/plugins.md (section 6.6)
 */

/** Whisper's language code for an app locale: "pt-BR" and "pt-PT" are "pt", "zh-TW" is "zh". */
function whisperLanguage(locale: string): string {
  return locale.split('-')[0]!;
}

/** 16-bit PCM for SpeechAnalyzer: half the bytes of float, and the format it asks for. */
function toInt16(pcm: Float32Array): Uint8Array {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-1, Math.min(1, pcm[i]!)) * 0x7fff;
  return new Uint8Array(out.buffer);
}

const fileOf = (stem: string): PluginFile => {
  const f = pluginEntry('voice').files.find((x) => x.path.startsWith(`voice/whisper-small-${stem}-`));
  if (!f) throw new Error(`voice file ${stem}`);
  return f;
};

/** Loads Whisper and the runtime into the worker, once. */
async function ensureWhisper(signal: AbortSignal): Promise<void> {
  if (workerHas('voice')) return;
  const files: Record<string, ArrayBuffer> = {
    encoder: await readPluginFile(fileOf('encoder'), signal),
    decoder: await readPluginFile(fileOf('decoder'), signal),
    vocab: await readPluginFile(fileOf('vocab'), signal),
    config: await readPluginFile(fileOf('generation-config'), signal),
  };
  signal.throwIfAborted();
  await loadInWorker('voice', files, await readPluginFile(RUNTIME_FILES[0]!, signal));
}

export type VoiceProgress =
  /** Samples of the recording done, of all. */
  | { kind: 'audio'; done: number; total: number }
  /** The OS fetches its speech model for the language, 0 to 1. */
  | { kind: 'apple-model'; fraction: number };

/**
 * The text of a recording. `language` is an app locale, or null for "Auto"
 * (Whisper only: SpeechAnalyzer needs one). Throws a short code:
 * `audio-format`, `apple-no-language`, `apple-too-many`, `audio-too-long`
 * (over an hour), `os-too-old` (below 26 with no Whisper on the
 * device), `canceled`, or another failure.
 */
export async function transcribe(bytes: ArrayBuffer, language: string | null, engine: 'apple' | 'web', signal: AbortSignal, progress: (p: VoiceProgress) => void): Promise<string> {
  const pcm = await decodeAudio(bytes, SAMPLE_RATE);
  // The sheet refuses it from the header first; a file whose header gives no
  // length (or a wrong one) is refused here, on either engine, matching the
  // Apple plugin's cap (Rust answers `bad-size`). Beta #240 item 13.
  if (pcm.length > MAX_AUDIO_S * SAMPLE_RATE) throw new Error('audio-too-long');
  signal.throwIfAborted();
  if (engine === 'apple' && language) {
    const text = await transcribeApple(pcm, language, signal, progress).catch((e: unknown) => {
      if (!String(e).includes('os-too-old')) throw e;
      // Below 26 there is no SpeechAnalyzer. A Mac uses Whisper only when its
      // files are already here: nothing downloads 250 MB unannounced. An
      // iPhone never runs it (D24).
      markSpeechTooOld();
      if (detectPlatform() === 'ios' || pluginState('voice').status !== 'on') throw new Error('os-too-old');
      return null;
    });
    if (text !== null) return text;
  }
  await ensureWhisper(signal);
  signal.throwIfAborted();
  const total = pcm.length;
  const result = (await runInWorker('voice', { pcm, language: language ? whisperLanguage(language) : null }, (done) => progress({ kind: 'audio', done, total }), [pcm.buffer])) as VoiceResult;
  return result.text;
}

async function transcribeApple(pcm: Float32Array, locale: string, signal: AbortSignal, progress: (p: VoiceProgress) => void): Promise<string> {
  let status = await appleSpeechStatus(locale);
  if (status.status === 'unsupported') throw new Error('apple-no-language');
  if (status.status !== 'installed') {
    progress({ kind: 'apple-model', fraction: 0 });
    try {
      status = await appleSpeechInstall(locale, (fraction) => progress({ kind: 'apple-model', fraction }));
    } catch (e) {
      throw new Error(String(e).includes('too-many') ? 'apple-too-many' : 'failed');
    }
  }
  signal.throwIfAborted();
  progress({ kind: 'audio', done: 0, total: pcm.length });
  let answer;
  try {
    answer = await appleTranscribe(toInt16(pcm), locale, signal);
  } catch (e) {
    const code = String(e);
    throw new Error(
      code.includes('unsupported-locale') ? 'apple-no-language'
        : code.includes('bad-audio') ? 'audio-format'
        : code.includes('bad-size') ? 'audio-too-long'
        : code.includes('os-too-old') ? 'os-too-old'
        : code.includes('canceled') ? 'canceled'
        : 'failed',
    );
  }
  progress({ kind: 'audio', done: pcm.length, total: pcm.length });
  return joinSegments(answer.segments);
}
